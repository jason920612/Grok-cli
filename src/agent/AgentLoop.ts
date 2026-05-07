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
import { buildModelInput } from "./modelInputBuilder.js";
import { finalAnswerGate } from "./finalAnswerGate.js";
import { SituationMemory } from "./SituationMemory.js";
import { runVerifier } from "./Verifier.js";

type ToolActionSummary = {
  step: number;
  name: string;
  ok: boolean;
  summary: string;
};

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
    const isStateless = this.config.conversationMode === "stateless";
    const isHybrid = this.config.conversationMode === "hybrid";

    let previousResponseId: string | undefined;
    // tracks whether the next hybrid call should be a fresh stateless call (after a reset)
    let hybridForceStateless = false;
    let finalText = "";
    const usedToolNames = new Set<string>();
    const toolActionSummaries: ToolActionSummary[] = [];
    let planOnlyReprompts = 0;
    let emptyResponseRetries = 0;
    let verifierReprompts = 0;
    const hasModifiedFiles = { value: false };
    const situationMemory = new SituationMemory();

    this.context.upsert("user-task", { type: "user_task", content: task, priority: 100, pinned: true });

    let step = 1;
    let pendingInput: any = this.buildInput(task, isStateless ? situationMemory : undefined);

    while (step <= this.config.maxSteps) {
      throwIfAborted(signal);
      this.context.nextStep(task);

      // hybrid: reset stateful context after thresholds
      if (isHybrid && previousResponseId && !hybridForceStateless) {
        const shouldReset =
          step > this.config.hybridResetAfterSteps ||
          situationMemory.totalFailures() >= this.config.hybridResetAfterFailures;
        if (shouldReset) {
          previousResponseId = undefined;
          hybridForceStateless = true;
          pendingInput = this.buildStatelessPrompt(task, situationMemory);
          console.log(`[hybrid] Context reset at step ${step} — rebuilding from situation memory.`);
        }
      }

      const useStateless = isStateless || hybridForceStateless;

      const spinner = ora(`Grok thinking (step ${step})`).start();
      let response: any;
      try {
        response = await createResponse(this.client, {
          model: this.config.model,
          input: pendingInput,
          tools: this.tools.schemas(serverTools(this.config)),
          toolChoice: this.config.toolChoice,
          previousResponseId: useStateless ? undefined : previousResponseId,
          signal
        });
      } finally {
        spinner.stop();
      }

      throwIfAborted(signal);
      const parsed = parseResponse(response);
      previousResponseId = parsed.id || previousResponseId;
      hybridForceStateless = false;

      // watchdog: empty response with no tool calls and no text
      if (!parsed.finalText && parsed.functionCalls.length === 0) {
        if (emptyResponseRetries < 1) {
          emptyResponseRetries += 1;
          console.log("[watchdog] Empty response detected. Nudging model to continue.");
          pendingInput = this.buildCorrectionInput(
            task,
            "Your previous response was empty. Emit exactly one tool call or a final answer. Do not respond with only whitespace.",
            useStateless ? situationMemory : undefined
          );
          step += 1;
          continue;
        }
        finalText = "[agent stopped: repeated empty responses from model]";
        break;
      }
      emptyResponseRetries = 0;

      // narration guard: model described intent but did not call a tool
      if (parsed.functionCalls.length === 0) {
        if (planOnlyReprompts < 2 && shouldContinueAfterPlanOnlyResponse(parsed.finalText, task, toolActionSummaries.length)) {
          planOnlyReprompts += 1;
          console.log(parsed.finalText);
          console.log("Grok provided a plan without tool calls; requesting actual tool use.");
          pendingInput = this.buildCorrectionInput(
            task,
            "Invalid response: you described an intention but did not call a tool. Return exactly one tool call or a final answer. Describing intent is not the same as acting.",
            useStateless ? situationMemory : undefined
          );
          step += 1;
          continue;
        }

        // candidate final answer — run verifier if enabled
        if (this.config.enableVerifier && verifierReprompts < 2 && parsed.finalText) {
          const verifierResult = await this.verify(task, situationMemory, parsed.finalText, signal);
          if (verifierResult && verifierResult.verdict !== "pass") {
            verifierReprompts += 1;
            const correction = buildVerifierCorrection(verifierResult);
            console.log(`[verifier] verdict=${verifierResult.verdict} confidence=${verifierResult.confidence}`);
            pendingInput = this.buildCorrectionInput(task, correction, useStateless ? situationMemory : undefined);
            step += 1;
            continue;
          }
        }

        finalText = parsed.finalText;
        break;
      }

      planOnlyReprompts = 0;
      if (parsed.finalText) console.log(parsed.finalText);
      console.log(formatToolBatch(step, parsed.functionCalls.map((call) => call.name)));

      // blind-retry guard: block repeated failed tool+args before executing
      const blocked = this.findBlockedCall(parsed.functionCalls, situationMemory);
      if (blocked) {
        let args: unknown;
        try { args = JSON.parse(blocked.arguments || "{}"); } catch { args = {}; }
        const record = situationMemory.hasRecentlyFailed(blocked.name, args)!;
        console.log(`[guard] Blocking blind retry of ${blocked.name} (failed ${record.attempts}x). Injecting failure context.`);
        pendingInput = this.buildCorrectionInput(
          task,
          `BLIND RETRY BLOCKED:\nTool: ${record.tool}\nError: ${record.error}\nAttempts: ${record.attempts}\nConstraint: Do not retry the exact same action unchanged. Choose a different approach: narrow the scope, inspect logs, or change strategy.`,
          useStateless ? situationMemory : undefined
        );
        step += 1;
        continue;
      }

      await this.executeToolBatch(
        parsed.functionCalls,
        step,
        usedToolNames,
        toolActionSummaries,
        hasModifiedFiles,
        situationMemory,
        signal
      );

      // in stateless/hybrid: rebuild fresh prompt from updated situation memory
      // do NOT pass raw function_call_output protocol items without previous_response_id context
      if (useStateless || isStateless || isHybrid) {
        pendingInput = this.buildStatelessPrompt(task, situationMemory);
      } else {
        // stateful: xAI API tracks conversation via previous_response_id
        // just send an empty continuation signal — the API replays context
        pendingInput = [];
      }

      step += 1;
    }

    const gate = await finalAnswerGate({
      oneShot,
      background: this.toolCtx.background,
      tools: this.tools,
      toolCtx: this.toolCtx,
      hasModifiedFiles: hasModifiedFiles.value
    });
    const diffSection = gate.diffPreview ? `\n\n[Diff preview]\n${gate.diffPreview}` : "";
    const actionSection = toolActionSummaries.length > 0
      ? `\n\n[Actions completed]\n${formatActionSummary(toolActionSummaries)}`
      : "";
    const suffix = `${actionSection}${diffSection}\n\n[Final checks]\nBackground: ${gate.backgroundStatus}\nDiff checked: ${gate.diffChecked ? "yes" : "not needed"}`;
    return finalText ? `${finalText}${suffix}` : `Stopped after max steps without a final model message.${suffix}`;
  }

  private buildInput(task: string, memory?: SituationMemory): string {
    if (memory) return this.buildStatelessPrompt(task, memory);
    return buildModelInput({
      task,
      context: this.context,
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
      projectInstructions: this.projectInstructions
    });
  }

  private buildStatelessPrompt(task: string, memory: SituationMemory): string {
    return buildModelInput({
      task,
      context: this.context,
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
      projectInstructions: this.projectInstructions,
      situationSnapshot: memory.snapshot()
    });
  }

  private buildCorrectionInput(task: string, correction: string, memory?: SituationMemory): string {
    const base = memory ? this.buildStatelessPrompt(task, memory) : "";
    return base ? `${base}\n\n<Correction>\n${correction}\n</Correction>` : correction;
  }

  private findBlockedCall(
    functionCalls: Array<{ name: string; arguments?: string; call_id: string }>,
    memory: SituationMemory
  ): { name: string; arguments?: string; call_id: string } | undefined {
    return functionCalls.find((call) => {
      let args: unknown;
      try { args = JSON.parse(call.arguments || "{}"); } catch { return false; }
      return memory.hasRecentlyFailed(call.name, args) !== undefined;
    });
  }

  private async verify(task: string, memory: SituationMemory, executorClaim: string, signal?: AbortSignal) {
    try {
      return await runVerifier(this.client, this.config.model, task, memory.getEvidence(), executorClaim, signal);
    } catch {
      return null;
    }
  }

  private async executeToolBatch(
    functionCalls: Array<{ name: string; arguments?: string; call_id: string }>,
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
    situationMemory: SituationMemory,
    signal?: AbortSignal
  ): Promise<void> {
    for (let index = 0; index < functionCalls.length;) {
      const call = functionCalls[index];
      if (this.tools.isReadOnly(call.name)) {
        const readOnlyCalls: typeof functionCalls = [];
        while (index < functionCalls.length && this.tools.isReadOnly(functionCalls[index].name)) {
          readOnlyCalls.push(functionCalls[index]);
          index += 1;
        }
        await Promise.all(readOnlyCalls.map((item) =>
          this.executeOneToolCall(item, step, usedToolNames, toolActionSummaries, hasModifiedFiles, situationMemory, signal)
        ));
        continue;
      }
      await this.executeOneToolCall(call, step, usedToolNames, toolActionSummaries, hasModifiedFiles, situationMemory, signal);
      index += 1;
    }
  }

  private async executeOneToolCall(
    call: { name: string; arguments?: string; call_id: string },
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
    situationMemory: SituationMemory,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfAborted(signal);
    usedToolNames.add(call.name);
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      situationMemory.recordFailure(call.name, {}, `JSON parse error: ${msg}`, step);
      toolActionSummaries.push({ step, name: call.name, ok: false, summary: `JSON parse error: ${msg}` });
      return;
    }
    const result = await this.tools.execute(call.name, args, this.toolCtx);
    throwIfAborted(signal);
    if (call.name === "apply_patch" && result.ok) hasModifiedFiles.value = true;

    const summary = summarizeToolResult(result);
    toolActionSummaries.push({ step, name: call.name, ok: result.ok, summary });

    const outputExcerpt = result.ok
      ? (result.summary ?? JSON.stringify(result.data).slice(0, 600))
      : `ERROR: ${result.error.message}`;

    situationMemory.recordEvidence(call.name, args, outputExcerpt, result.ok, step);
    if (!result.ok) {
      situationMemory.recordFailure(call.name, args, result.error.message, step);
    }

    this.context.add({
      type: "shell_output",
      content: `tool ${call.name}(${call.arguments}) => ${JSON.stringify(result).slice(0, 4000)}`,
      priority: 45,
      expiresAfterSteps: 2
    });
  }
}

function buildVerifierCorrection(result: Awaited<ReturnType<typeof runVerifier>>): string {
  if (!result) return "";
  const lines = [
    `VERIFIER AUDIT — verdict: ${result.verdict} (confidence: ${result.confidence})`,
    `Reason: ${result.reason}`
  ];
  if (result.unsupported_assumptions.length > 0) {
    lines.push("\nUnsupported assumptions detected:");
    for (const a of result.unsupported_assumptions) {
      lines.push(`- Claim: ${a.claim}`);
      lines.push(`  Why unsupported: ${a.why_unsupported}`);
      lines.push(`  Required verification: ${a.required_verification}`);
    }
  }
  if (result.missing_evidence.length > 0) {
    lines.push("\nMissing evidence:");
    for (const e of result.missing_evidence) lines.push(`- ${e}`);
  }
  if (result.required_next_actions.length > 0) {
    lines.push("\nRequired next actions:");
    for (const a of result.required_next_actions) lines.push(`- ${a}`);
  }
  lines.push("\nThe verifier found unsupported claims. You must perform the required tool verifications before providing a final answer.");
  return lines.join("\n");
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

export function shouldContinueAfterPlanOnlyResponse(text: string, task: string, actionCount: number): boolean {
  if (!text.trim()) return false;
  const taskLower = task.toLowerCase();
  const saysItWillUseTools = /(brief plan|before first tool call|i'?ll now|i will now|proceeding to|run the first tool|call .*tool|use .*tool|工具)/i.test(text);
  const englishActionTask = /\b(commit|push|edit|modify|fix|write|create|delete|run|test|build|review|issue|pr)\b/i.test(taskLower);
  const localizedActionTask = ["修 bug", "修改", "修正", "建立", "新增", "刪除", "執行", "执行", "測試", "测试", "建置", "提交", "推送", "審核", "審核", "開pr", "開 issue"].some((keyword) => taskLower.includes(keyword));
  const claimsNoCapability = /no .*tool available|there is no .*tool|tools limited to/i.test(text.toLowerCase());
  return actionCount === 0 && (englishActionTask || localizedActionTask) && (saysItWillUseTools || claimsNoCapability);
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
