import ora from "ora";
import type OpenAI from "openai";
import { createResponse, type ResponseTool } from "../api/responsesClient.js";
import { parseResponse } from "../api/responseParser.js";
import type { GrokCodeConfig } from "../config/loadConfig.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolExecutionContext } from "../tools/AgentTool.js";
import type { SkillLoader } from "../skills/SkillLoader.js";
import type { ToolSkillRegistry } from "../tool-skills/ToolSkillRegistry.js";
import { buildModelInput, buildStatelessInput } from "./modelInputBuilder.js";
import { finalAnswerGate } from "./finalAnswerGate.js";
import { VerifierAgent, buildVerifierFeedback } from "./VerifierAgent.js";
import type { EvidenceBundle } from "./EvidenceBundle.js";

type ToolActionSummary = {
  step: number;
  name: string;
  ok: boolean;
  summary: string;
};

type FailureRecord = {
  count: number;
  lastError: string;
  lastArgs: string;
  toolName: string;
};

class FailureTracker {
  private map = new Map<string, FailureRecord>();
  private lastKey: string | undefined;

  record(toolName: string, args: string, error: string): void {
    const key = normalizeFailureKey(toolName, args);
    const prev = this.map.get(key) ?? { count: 0, lastError: "", lastArgs: args, toolName };
    this.map.set(key, { count: prev.count + 1, lastError: error, lastArgs: args, toolName });
    this.lastKey = key;
  }

  isRepeated(toolName: string, args: string): boolean {
    const key = normalizeFailureKey(toolName, args);
    return (this.map.get(key)?.count ?? 0) >= 1;
  }

  lastFailure(): { toolName: string; args: string; error: string; attempts: number } | undefined {
    if (!this.lastKey) return undefined;
    const rec = this.map.get(this.lastKey);
    if (!rec) return undefined;
    return { toolName: rec.toolName, args: rec.lastArgs, error: rec.lastError, attempts: rec.count };
  }
}

function getShellExitCode(toolName: string, data: unknown): number | undefined {
  if (toolName !== "run_shell" && toolName !== "start_background_command") return undefined;
  const d = data as Record<string, unknown> | undefined;
  return typeof d?.exitCode === "number" ? d.exitCode : undefined;
}

function normalizeFailureKey(toolName: string, args: string): string {
  try {
    const parsed = JSON.parse(args || "{}") as Record<string, unknown>;
    // Strip annotation-only fields that models vary between calls but don't change the action
    const { reason: _r, description: _d, ...actionArgs } = parsed;
    return `${toolName}:${JSON.stringify(actionArgs)}`;
  } catch {
    return `${toolName}:${args}`;
  }
}

export class AgentLoop {
  constructor(
    private readonly client: OpenAI,
    private readonly config: GrokCodeConfig,
    private readonly context: ContextManager,
    private readonly tools: ToolRegistry,
    private readonly toolCtx: ToolExecutionContext,
    private readonly skillLoader: SkillLoader,
    private readonly toolSkills: ToolSkillRegistry,
    private readonly projectInstructions: string
  ) {}

  async run(task: string, oneShot: boolean, signal?: AbortSignal): Promise<string> {
    let previousResponseId: string | undefined;
    let finalText = "";
    const usedToolNames = new Set<string>();
    const toolActionSummaries: ToolActionSummary[] = [];
    let planOnlyReprompts = 0;
    let emptyReprompts = 0;
    let verifierAttempts = 0;
    let lastVerifierFeedback: string | undefined;
    const hasModifiedFiles = { value: false };
    const failureTracker = new FailureTracker();
    let chainLength = 0;
    let consecutiveFailures = 0;

    this.context.upsert("user-task", { type: "user_task", content: task, priority: 100, pinned: true });

    const mode = this.config.conversationMode;

    let pendingInput: any = buildModelInput({
      task,
      context: this.context,
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
      projectInstructions: this.projectInstructions
    });

    let step = 1;
    while (step <= this.config.maxSteps) {
      throwIfAborted(signal);
      this.context.nextStep(task);

      const shouldResetChain =
        mode === "hybrid" &&
        step > 1 &&
        (chainLength >= this.config.hybridResetAfterTurns ||
          consecutiveFailures >= this.config.hybridResetAfterFailures);

      let stepInput: any;
      let stepPreviousResponseId: string | undefined;

      if (mode === "stateless" || shouldResetChain) {
        if (shouldResetChain) {
          console.log(
            `[Hybrid] Resetting conversation chain at step ${step} (turns=${chainLength}, consecutive failures=${consecutiveFailures})`
          );
          chainLength = 0;
          previousResponseId = undefined;
        }
        stepInput = buildStatelessInput({
          task,
          verifiedObservations: toolActionSummaries.map(
            (s) => `${s.name} ${s.ok ? "succeeded" : "failed"}: ${s.summary}`
          ),
          lastFailure: failureTracker.lastFailure(),
          verifierFeedback: lastVerifierFeedback,
          toolIndex: this.toolSkills.toolIndex(),
          generalSkills: this.skillLoader.select(task),
          toolSkills: this.toolSkills.select(task, [...usedToolNames]),
          projectInstructions: this.projectInstructions
        });
        stepPreviousResponseId = undefined;
      } else {
        stepInput = pendingInput;
        stepPreviousResponseId = previousResponseId;
      }

      const spinner = ora(`Grok thinking (step ${step})`).start();
      let response: any;
      try {
        response = await createResponse(this.client, {
          model: this.config.model,
          input: stepInput,
          tools: this.tools.schemas(serverTools(this.config)),
          toolChoice: this.config.toolChoice,
          previousResponseId: stepPreviousResponseId,
          signal
        });
      } finally {
        spinner.stop();
      }

      throwIfAborted(signal);
      const parsed = parseResponse(response);

      if (mode !== "stateless") {
        previousResponseId = parsed.id || previousResponseId;
        chainLength++;
      }

      // Empty response guard
      if (!parsed.finalText && parsed.functionCalls.length === 0) {
        if (emptyReprompts < 1) {
          emptyReprompts++;
          console.log("[Warning] Empty response from model. Requesting continuation.");
          pendingInput =
            "Your previous response was empty. Continue by emitting exactly one tool call or a final answer. Do not respond with only narration.";
          step++;
          continue;
        }
        finalText = "[Agent stopped: model returned repeated empty responses without tool calls or a final answer.]";
        break;
      }
      emptyReprompts = 0;

      // Narration-only guard (no tool calls but has text)
      if (parsed.functionCalls.length === 0) {
        if (
          planOnlyReprompts < 2 &&
          shouldContinueAfterPlanOnlyResponse(parsed.finalText, task, toolActionSummaries.length)
        ) {
          planOnlyReprompts++;
          console.log(parsed.finalText);
          console.log(
            "Grok provided a plan without tool calls; asking it to continue with the required tools."
          );
          pendingInput =
            "You provided a plan but did not request any function_call tools. The user asked for an action, not only a plan. Continue now by requesting the appropriate tools in this response. If the action cannot be completed, explain the concrete blocker after using any relevant inspection tools.";
          step++;
          continue;
        }

        // Verifier gate: run before accepting the final answer
        if (
          this.config.enableVerifier &&
          toolActionSummaries.length > 0 &&
          verifierAttempts < this.config.verifierMaxRetries &&
          step <= this.config.maxSteps
        ) {
          const bundle: EvidenceBundle = {
            userTask: task,
            executorClaim: parsed.finalText,
            evidenceItems: toolActionSummaries.map((s) => ({
              toolName: s.name,
              ok: s.ok,
              summary: s.summary
            }))
          };
          const verifier = new VerifierAgent(this.client, this.config);
          const verdict = await verifier.verify(bundle);
          verifierAttempts++;

          if (verdict.verdict !== "pass") {
            const feedback = buildVerifierFeedback(verdict);
            console.log(`[Verifier] ${verdict.verdict} (confidence: ${verdict.confidence}): ${verdict.reason}`);
            lastVerifierFeedback = feedback;
            this.context.upsert("verifier-feedback", {
              type: "verifier_feedback",
              content: feedback,
              priority: 95,
              pinned: false,
              expiresAfterSteps: 4
            });
            pendingInput = feedback;
            step++;
            continue;
          }
          console.log(`[Verifier] pass (confidence: ${verdict.confidence})`);
        }

        finalText = parsed.finalText;
        break;
      }

      if (parsed.finalText) console.log(parsed.finalText);
      console.log(formatToolBatch(step, parsed.functionCalls.map((call) => call.name)));

      const outputs = await this.executeToolBatch(
        parsed.functionCalls,
        step,
        usedToolNames,
        toolActionSummaries,
        hasModifiedFiles,
        failureTracker,
        signal
      );

      // Track consecutive failures
      const stepHadFailure = toolActionSummaries.filter((s) => s.step === step).some((s) => !s.ok);
      consecutiveFailures = stepHadFailure ? consecutiveFailures + 1 : 0;

      if (mode === "stateless") {
        // Situation is rebuilt from toolActionSummaries next turn; pendingInput unused
        pendingInput = null;
      } else {
        pendingInput = outputs;
      }

      step++;
    }

    const gate = await finalAnswerGate({
      oneShot,
      background: this.toolCtx.background,
      tools: this.tools,
      toolCtx: this.toolCtx,
      hasModifiedFiles: hasModifiedFiles.value
    });
    const diffSection = gate.diffPreview ? `\n\n[Diff preview]\n${gate.diffPreview}` : "";
    const actionSection =
      toolActionSummaries.length > 0
        ? `\n\n[Actions completed]\n${formatActionSummary(toolActionSummaries)}`
        : "";
    const suffix = `${actionSection}${diffSection}\n\n[Final checks]\nBackground: ${gate.backgroundStatus}\nDiff checked: ${gate.diffChecked ? "yes" : "not needed"}`;
    return finalText
      ? `${finalText}${suffix}`
      : `Stopped after max steps without a final model message.${suffix}`;
  }

  private async executeToolBatch(
    functionCalls: Array<{ name: string; arguments?: string; call_id: string }>,
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
    failureTracker: FailureTracker,
    signal?: AbortSignal
  ): Promise<Array<{ type: "function_call_output"; call_id: string; output: string }>> {
    const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];
    for (let index = 0; index < functionCalls.length; ) {
      const call = functionCalls[index];
      if (this.tools.isReadOnly(call.name)) {
        const readOnlyCalls = [];
        while (index < functionCalls.length && this.tools.isReadOnly(functionCalls[index].name)) {
          readOnlyCalls.push(functionCalls[index]);
          index++;
        }
        outputs.push(
          ...(await Promise.all(
            readOnlyCalls.map((item) =>
              this.executeOneToolCall(
                item,
                step,
                usedToolNames,
                toolActionSummaries,
                hasModifiedFiles,
                failureTracker,
                signal
              )
            )
          ))
        );
        continue;
      }
      outputs.push(
        await this.executeOneToolCall(
          call,
          step,
          usedToolNames,
          toolActionSummaries,
          hasModifiedFiles,
          failureTracker,
          signal
        )
      );
      index++;
    }
    return outputs;
  }

  private async executeOneToolCall(
    call: { name: string; arguments?: string; call_id: string },
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
    failureTracker: FailureTracker,
    signal?: AbortSignal
  ): Promise<{ type: "function_call_output"; call_id: string; output: string }> {
    throwIfAborted(signal);
    usedToolNames.add(call.name);

    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch (error) {
      const result = {
        ok: false,
        error: { code: "json_parse_error", message: error instanceof Error ? error.message : String(error) }
      };
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
    }

    // Repeated failure guard: block non-read-only tools that have already failed with the same args
    if (!this.tools.isReadOnly(call.name) && failureTracker.isRepeated(call.name, call.arguments ?? "{}")) {
      const prior = failureTracker.lastFailure();
      const result = {
        ok: false,
        error: {
          code: "repeated_failure_blocked",
          message:
            `This exact call to ${call.name} with these arguments already failed` +
            (prior ? ` (${prior.attempts} time(s), last error: ${prior.error})` : "") +
            `. Choose a different approach: narrow the scope, inspect the root cause, or change strategy.`
        }
      };
      toolActionSummaries.push({ step, name: call.name, ok: false, summary: result.error.message });
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
    }

    const result = await this.tools.execute(call.name, args, this.toolCtx);
    throwIfAborted(signal);

    if (call.name === "apply_patch" && result.ok) hasModifiedFiles.value = true;

    const shellExitCode = result.ok ? getShellExitCode(call.name, result.data) : undefined;
    const isEffectiveFailure = !result.ok || (shellExitCode !== undefined && shellExitCode !== 0);
    if (isEffectiveFailure) {
      const errorMsg = !result.ok
        ? result.error.message
        : `Command exited with code ${shellExitCode}: ${String((result.data as any)?.stdout ?? "").slice(0, 200)}`;
      failureTracker.record(call.name, call.arguments ?? "{}", errorMsg);
    }

    toolActionSummaries.push({
      step,
      name: call.name,
      ok: result.ok,
      summary: summarizeToolResult(result)
    });

    this.context.add({
      type: "shell_output",
      content: `tool ${call.name}(${call.arguments}) => ${JSON.stringify(result).slice(0, 4000)}`,
      priority: 45,
      expiresAfterSteps: 2,
      factSource: "tool_output",
      factConfidence: result.ok ? "verified" : "uncertain"
    });

    return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
  }
}

function formatToolBatch(step: number, toolNames: string[]): string {
  const unique = [...new Set(toolNames)];
  return `Grok requested tool batch ${step}: ${unique.join(", ")}`;
}

function summarizeToolResult(result: Awaited<ReturnType<ToolRegistry["execute"]>>): string {
  if (!result.ok) return result.error.message;
  return result.summary ?? JSON.stringify(result.data).slice(0, 240);
}

function formatActionSummary(actions: ToolActionSummary[]): string {
  return actions
    .map((action) => `- step ${action.step}: ${action.name} ${action.ok ? "ok" : "failed"} - ${action.summary}`)
    .join("\n");
}

export function shouldContinueAfterPlanOnlyResponse(
  text: string,
  task: string,
  actionCount: number
): boolean {
  if (!text.trim()) return false;
  const lower = text.toLowerCase();
  const taskLower = task.toLowerCase();
  const saysItWillUseTools =
    /(brief plan|before first tool call|i'?ll now|i will now|proceeding to|run the first tool|call .*tool|use .*tool|工具)/i.test(
      text
    );
  const englishActionTask =
    /\b(commit|push|edit|modify|fix|write|create|delete|run|test|build|review|issue|pr)\b/i.test(taskLower);
  const localizedActionTask = [
    "修 bug",
    "修改",
    "修正",
    "建立",
    "新增",
    "刪除",
    "执行",
    "執行",
    "測試",
    "测试",
    "建置",
    "提交",
    "推送",
    "審核",
    "审核",
    "開pr",
    "開 issue"
  ].some((keyword) => taskLower.includes(keyword));
  const claimsNoCapability = /no .*tool available|there is no .*tool|tools limited to/i.test(lower);
  return (
    actionCount === 0 &&
    (englishActionTask || localizedActionTask) &&
    (saysItWillUseTools || claimsNoCapability)
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Interrupted by user.");
}

function serverTools(config: GrokCodeConfig): ResponseTool[] {
  if (!config.serverTools) return [];
  const tools: ResponseTool[] = [];
  if (config.enableWebSearch) tools.push({ type: "web_search" });
  if (config.enableXSearch) tools.push({ type: "x_search" });
  return tools;
}
