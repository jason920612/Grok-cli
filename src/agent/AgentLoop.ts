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
import type { EvidenceBundle, EvidenceMemoryFact } from "./EvidenceBundle.js";
import type { ContextItem } from "../context/ContextItem.js";

type ToolActionSummary = {
  step: number;
  name: string;
  ok: boolean;
  summary: string;
  args?: string;
};

type FailureRecord = {
  count: number;
  lastError: string;
  lastArgs: string;
  toolName: string;
  progressVersion: number;
};

class FailureTracker {
  private map = new Map<string, FailureRecord>();
  private lastKey: string | undefined;
  private progressVersion = 0;

  record(toolName: string, args: string, error: string): void {
    const key = normalizeFailureKey(toolName, args);
    const prev = this.map.get(key) ?? {
      count: 0,
      lastError: "",
      lastArgs: args,
      toolName,
      progressVersion: this.progressVersion
    };
    this.map.set(key, {
      count: prev.count + 1,
      lastError: error,
      lastArgs: args,
      toolName,
      progressVersion: this.progressVersion
    });
    this.lastKey = key;
  }

  isRepeated(toolName: string, args: string): boolean {
    const key = normalizeFailureKey(toolName, args);
    const rec = this.map.get(key);
    return Boolean(rec && rec.count >= 1 && rec.progressVersion === this.progressVersion);
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

function getShellExitCode(toolName: string, data: unknown): number | undefined {
  if (toolName !== "run_shell" && toolName !== "start_background_command") return undefined;
  const d = data as Record<string, unknown> | undefined;
  return typeof d?.exitCode === "number" ? d.exitCode : undefined;
}

function isShellTool(toolName: string): boolean {
  return toolName === "run_shell" || toolName === "start_background_command";
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
    const executorTrace: string[] = [];
    let planOnlyReprompts = 0;
    let emptyReprompts = 0;
    let verifierAttempts = 0;
    let lastVerifierFeedback: string | undefined;
    let lastVerifierVerdict: import("./EvidenceBundle.js").VerifierVerdict | undefined;
    let runtimeFeedback: string | undefined;
    const hasModifiedFiles = { value: false };
    const failureTracker = new FailureTracker();
    let chainLength = 0;
    let consecutiveFailures = 0;
    let invalidResponses = 0;

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
          consecutiveFailures >= this.config.hybridResetAfterFailures ||
          invalidResponses > 0);

      let stepInput: any;
      let stepPreviousResponseId: string | undefined;

      if (mode === "stateless" || shouldResetChain) {
        if (shouldResetChain) {
          console.log(
            `[Hybrid] Resetting conversation chain at step ${step} (turns=${chainLength}, consecutive failures=${consecutiveFailures})`
          );
          chainLength = 0;
          invalidResponses = 0;
          previousResponseId = undefined;
        }
        stepInput = buildStatelessInput({
          task,
          verifiedFacts: toolActionSummaries.map(
            (s) => `${s.name} ${s.ok ? "succeeded" : "failed"}: ${s.summary}`
          ),
          priorActions: toolActionSummaries.map(
            (s) => `step ${s.step}: ${s.name}(${s.args ?? ""}) -> ${s.ok ? "ok" : "failed"}`
          ),
          inferredFacts: buildStatelessInferences(this.context.relevant(task, 20_000)),
          lastFailure: failureTracker.lastFailure(),
          verifierFeedback: lastVerifierFeedback,
          runtimeFeedback,
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
          runtimeFeedback =
            "Your previous response was empty. Continue by emitting exactly one tool call or a final answer. Do not respond with only narration.";
          invalidResponses++;
          pendingInput = runtimeFeedback;
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
          executorTrace.push(parsed.finalText);
          console.log(parsed.finalText);
          console.log(
            "Grok provided a plan without tool calls; asking it to continue with the required tools."
          );
          runtimeFeedback =
            "You provided a plan but did not request any function_call tools. The user asked for an action, not only a plan. Continue now by requesting exactly one appropriate tool in this response. If the action cannot be completed, explain the concrete blocker after using any relevant inspection tools.";
          invalidResponses++;
          pendingInput = runtimeFeedback;
          step++;
          continue;
        }

        // Verifier gate: run before accepting the final answer.
        // Runs even when no tool calls were made so first-turn knowledge-only answers are audited.
        if (this.config.enableVerifier && step <= this.config.maxSteps) {
          if (verifierAttempts < this.config.verifierMaxRetries) {
            const bundle: EvidenceBundle = {
              userTask: task,
              executorClaim: parsed.finalText,
              executorTrace: parsed.finalText ? [...executorTrace, parsed.finalText] : executorTrace,
              evidenceItems: toolActionSummaries.map((s) => ({
                toolName: s.name,
                ok: s.ok,
                args: s.args,
                summary: s.summary
              })),
              memoryFacts: buildVerifierMemoryFacts(this.context.relevant(task, 20_000))
            };
            const verifier = new VerifierAgent(this.client, this.config);
            const verdict = await verifier.verify(bundle);
            verifierAttempts++;
            lastVerifierVerdict = verdict;

            if (verdict.verdict !== "pass") {
              const feedback = buildVerifierFeedback(verdict);
              console.log(`[Verifier] ${verdict.verdict} (confidence: ${verdict.confidence}): ${verdict.reason}`);
              lastVerifierFeedback = feedback;
              runtimeFeedback = undefined;
              this.context.upsert("verifier-feedback", {
                type: "verifier_feedback",
                content: feedback,
                priority: 95,
                pinned: false,
                expiresAfterSteps: 4
              });
              recordVerifierTasks(this.context, verdict);
              pendingInput = feedback;
              step++;
              continue;
            }
            console.log(`[Verifier] pass (confidence: ${verdict.confidence})`);
          } else if (lastVerifierVerdict && lastVerifierVerdict.verdict !== "pass") {
            // Retries exhausted with unresolved issues — emit graceful partial-progress report
            finalText = buildVerifierExhaustedReport(parsed.finalText, lastVerifierVerdict);
            break;
          }
        }

        finalText = parsed.finalText;
        break;
      }

      if (parsed.finalText) executorTrace.push(parsed.finalText);

      if (parsed.functionCalls.length > 1) {
        runtimeFeedback =
          `Invalid response: requested ${parsed.functionCalls.length} tool calls in one turn. ` +
          "Continue by requesting exactly one tool call, or provide a final answer if the task is complete.";
        invalidResponses++;
        pendingInput = runtimeFeedback;
        step++;
        continue;
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
      runtimeFeedback = undefined;
      invalidResponses = 0;

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
    const rawArgs = call.arguments ?? "{}";

    // Repeated failure guard: block exact repeats of any tool call that failed
    // without intervening progress, including read-only inspection calls.
    if (failureTracker.isRepeated(call.name, rawArgs)) {
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
      toolActionSummaries.push({ step, name: call.name, ok: false, summary: `${result.error.code}: ${result.error.message}`, args: call.arguments?.slice(0, 300) });
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
    }

    let args: unknown;
    try {
      args = JSON.parse(rawArgs);
    } catch (error) {
      const result = {
        ok: false,
        error: { code: "json_parse_error", message: error instanceof Error ? error.message : String(error) }
      };
      failureTracker.record(call.name, rawArgs, result.error.message);
      toolActionSummaries.push({ step, name: call.name, ok: false, summary: `${result.error.code}: ${result.error.message}`, args: call.arguments?.slice(0, 300) });
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
      failureTracker.record(call.name, rawArgs, errorMsg);
    } else if (!this.tools.isReadOnly(call.name) && !isShellTool(call.name)) {
      failureTracker.markProgress();
    }

    toolActionSummaries.push({
      step,
      name: call.name,
      ok: result.ok,
      summary: summarizeToolResult(result),
      args: call.arguments?.slice(0, 300)
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

function buildVerifierMemoryFacts(items: ContextItem[]): EvidenceMemoryFact[] {
  return items
    .filter((item) =>
      [
        "file_range",
        "file_overview",
        "search_result",
        "shell_output",
        "background_output_summary",
        "patch",
        "test_result",
        "environment_summary",
        "project_tooling_summary",
        "task_summary"
      ].includes(item.type)
    )
    .slice(-40)
    .map((item) => ({
      type: item.type,
      content: oneLine(item.content, 500),
      factSource: item.factSource,
      factConfidence: item.factConfidence ?? "uncertain",
      source: item.source
    }));
}

function buildStatelessInferences(items: ContextItem[]): string[] {
  return items
    .filter((item) => item.factConfidence === "inferred" || item.factSource === "model_inference")
    .slice(-10)
    .map((item) => `${item.type}: ${oneLine(item.content, 300)}`);
}

function recordVerifierTasks(
  context: ContextManager,
  verdict: import("./EvidenceBundle.js").VerifierVerdict
): void {
  const tasks = [
    ...verdict.requiredNextActions,
    ...verdict.unsupportedAssumptions.map((item) => item.requiredVerification)
  ].filter((item): item is string => Boolean(item.trim()));

  for (const task of [...new Set(tasks)]) {
    context.add({
      type: "verification_task",
      content: task,
      priority: 90,
      expiresAfterSteps: 6,
      factSource: "model_inference",
      factConfidence: "uncertain"
    });
  }
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
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
  // If the model explicitly says it will use tools on an action task, reprompt regardless of
  // how many tools have already run — catches mid-task turns that narrate intent without acting.
  if (saysItWillUseTools && (englishActionTask || localizedActionTask)) return true;
  // For fresh starts only: reprompt if it's an action task and the model claims no capability
  return actionCount === 0 && (englishActionTask || localizedActionTask) && claimsNoCapability;
}

function buildVerifierExhaustedReport(
  executorClaim: string,
  lastVerdict: import("./EvidenceBundle.js").VerifierVerdict
): string {
  const lines = [
    "[Verifier] Retry budget exhausted. The executor's final claim could not be independently verified.",
    `Last verifier verdict: ${lastVerdict.verdict} (confidence: ${lastVerdict.confidence})`,
    `Reason: ${lastVerdict.reason}`
  ];
  if (lastVerdict.unsupportedClaims.length > 0) {
    lines.push("Unresolved unsupported claims:");
    for (const c of lastVerdict.unsupportedClaims) lines.push(`  - ${c}`);
  }
  if (lastVerdict.missingEvidence.length > 0) {
    lines.push("Missing evidence:");
    for (const e of lastVerdict.missingEvidence) lines.push(`  - ${e}`);
  }
  lines.push("", "Executor's unverified final answer (treat as partial progress):", executorClaim);
  return lines.join("\n");
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
