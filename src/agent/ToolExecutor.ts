import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolExecutionContext } from "../tools/AgentTool.js";
import type { ContextManager } from "../context/ContextManager.js";
import { TUNING } from "../config/tuning.js";

export type ProviderToolCall = { id: string; name: string; argsJson: string };

export type ToolActionSummary = {
  step: number;
  name: string;
  ok: boolean;
  summary: string;
  args?: string;
};

export type FunctionOutput = { type: "function_call_output"; call_id: string; output: string };

type FailureRecord = { count: number; lastError: string; lastArgs: string; toolName: string; progressVersion: number };

/**
 * Repeated no-progress call blocking + progress tracking (§7.4).
 *
 * Blocks re-running an identical (tool, args) call when nothing has changed
 * since it last ran — failures AND successes. Re-running an identical read-only
 * inspection or a side-effect-free script yields the same result and only burns
 * a step (a real task showed the model looping `inspect_environment` 13×). A
 * genuine mutation calls `markProgress`, bumping the version so legitimate
 * re-checks (e.g. `git_status` after an edit) are allowed again.
 */
export class FailureTracker {
  private map = new Map<string, FailureRecord>();
  /** Successful no-progress calls, key -> progressVersion they last ran at. */
  private seen = new Map<string, number>();
  private lastKey: string | undefined;
  private progressVersion = 0;

  record(toolName: string, args: string, error: string): void {
    const key = normalizeFailureKey(toolName, args);
    const prev = this.map.get(key);
    this.map.set(key, {
      count: (prev?.count ?? 0) + 1,
      lastError: error,
      lastArgs: args,
      toolName,
      progressVersion: this.progressVersion
    });
    this.lastKey = key;
  }

  /** Record a successful call that made no progress (read-only / side-effect-free). */
  recordNoProgress(toolName: string, args: string): void {
    this.seen.set(normalizeFailureKey(toolName, args), this.progressVersion);
  }

  isRepeated(toolName: string, args: string): boolean {
    const key = normalizeFailureKey(toolName, args);
    const rec = this.map.get(key);
    if (rec && rec.count >= 1 && rec.progressVersion === this.progressVersion) return true;
    return this.seen.get(key) === this.progressVersion;
  }

  lastFailure(): { toolName: string; args: string; error: string; attempts: number } | undefined {
    if (!this.lastKey) return undefined;
    const rec = this.map.get(this.lastKey);
    if (!rec) return undefined;
    return { toolName: rec.toolName, args: rec.lastArgs, error: rec.lastError, attempts: rec.count };
  }

  markProgress(): void {
    this.progressVersion++;
  }
}

/**
 * ToolExecutor (§7) — runs tool calls, deriving all semantics from the tool's
 * self-declared `effects` (§8) instead of sniffing tool names. Owns the
 * FailureTracker and the action-summary trace.
 */
export class ToolExecutor {
  readonly failureTracker = new FailureTracker();
  readonly usedToolNames = new Set<string>();
  readonly summaries: ToolActionSummary[] = [];
  hasModifiedFiles = false;
  /** Whether the most recent executed call made progress (a mutation). */
  lastProgress = false;

  constructor(
    private readonly tools: ToolRegistry,
    private readonly toolCtx: ToolExecutionContext,
    private readonly context: ContextManager
  ) {}

  async executeOne(call: ProviderToolCall, step: number, signal?: AbortSignal): Promise<FunctionOutput> {
    throwIfAborted(signal);
    this.lastProgress = false;
    this.usedToolNames.add(call.name);
    const rawArgs = call.argsJson || "{}";

    if (this.failureTracker.isRepeated(call.name, rawArgs)) {
      const prior = this.failureTracker.lastFailure();
      const detail =
        prior && prior.toolName === call.name && prior.args === rawArgs
          ? ` (already failed ${prior.attempts} time(s), last error: ${prior.error})`
          : " (already ran and produced the same result; nothing has changed since)";
      const result = {
        ok: false,
        error: {
          code: "repeated_failure_blocked",
          message:
            `This exact call to ${call.name} with these arguments was already made without any intervening progress${detail}. ` +
            `Reuse the earlier result, or take a different action: inspect something new, narrow the scope, edit a file, or proceed to the next step.`
        }
      };
      this.pushSummary(step, call, false, `${result.error.code}: ${result.error.message}`);
      return output(call.id, result);
    }

    let args: unknown;
    try {
      args = JSON.parse(rawArgs);
    } catch (error) {
      const result = {
        ok: false,
        error: { code: "json_parse_error", message: error instanceof Error ? error.message : String(error) }
      };
      this.failureTracker.record(call.name, rawArgs, result.error.message);
      this.pushSummary(step, call, false, `${result.error.code}: ${result.error.message}`);
      return output(call.id, result);
    }

    const result = await this.tools.execute(call.name, args, this.toolCtx);
    throwIfAborted(signal);

    const effects = this.tools.list().find((t) => t.name === call.name)?.effects;
    if (effects?.modifiesWorkspace && result.ok) this.hasModifiedFiles = true;

    const shellExitCode = result.ok && effects?.isShell ? getExitCode(result.data) : undefined;
    const effectiveFailure = !result.ok || (shellExitCode !== undefined && shellExitCode !== 0);
    if (effectiveFailure) {
      const errorMsg = !result.ok
        ? result.error.message
        : `Command exited with code ${shellExitCode}: ${String((result.data as any)?.stdout ?? "").slice(0, 200)}`;
      this.failureTracker.record(call.name, rawArgs, errorMsg);
    } else if (effects?.countsAsProgress) {
      this.failureTracker.markProgress();
      this.lastProgress = true;
    } else {
      // Successful but no progress (read-only inspection / side-effect-free script):
      // block an identical repeat until something actually changes.
      this.failureTracker.recordNoProgress(call.name, rawArgs);
    }

    this.pushSummary(step, call, result.ok, summarizeToolResult(result));
    this.context.add({
      type: "shell_output",
      content: `tool ${call.name}(${call.argsJson}) => ${JSON.stringify(result).slice(0, TUNING.truncate.toolOutputInlineChars)}`,
      priority: 45,
      expiresAfterSteps: TUNING.expiry.shellOutput,
      factSource: "tool_output",
      factConfidence: result.ok ? "verified" : "uncertain"
    });
    return output(call.id, result);
  }

  private pushSummary(step: number, call: ProviderToolCall, ok: boolean, summary: string): void {
    this.summaries.push({ step, name: call.name, ok, summary, args: call.argsJson?.slice(0, 300) });
  }
}

function output(callId: string, result: unknown): FunctionOutput {
  return { type: "function_call_output", call_id: callId, output: JSON.stringify(result) };
}

function getExitCode(data: unknown): number | undefined {
  const d = data as Record<string, unknown> | undefined;
  return typeof d?.exitCode === "number" ? d.exitCode : undefined;
}

function summarizeToolResult(result: { ok: boolean; data?: unknown; summary?: string; error?: { message: string } }): string {
  if (!result.ok) return result.error!.message;
  return result.summary ?? JSON.stringify(result.data).slice(0, 240);
}

function normalizeFailureKey(toolName: string, args: string): string {
  try {
    const parsed = JSON.parse(args || "{}") as Record<string, unknown>;
    const { reason: _r, description: _d, ...actionArgs } = parsed;
    return `${toolName}:${JSON.stringify(actionArgs)}`;
  } catch {
    return `${toolName}:${args}`;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Interrupted by user.");
}
