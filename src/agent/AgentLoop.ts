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
    let previousResponseId: string | undefined;
    let finalText = "";
    const usedToolNames = new Set<string>();
    const toolActionSummaries: ToolActionSummary[] = [];
    let planOnlyReprompts = 0;
    let emptyResponseRetries = 0;
    const hasModifiedFiles = { value: false };
    const situationMemory = new SituationMemory();
    const isStateless = this.config.conversationMode === "stateless";
    const isHybrid = this.config.conversationMode === "hybrid";

    this.context.upsert("user-task", { type: "user_task", content: task, priority: 100, pinned: true });

    let step = 1;
    let pendingInput: any = this.buildInput(task, isStateless ? situationMemory : undefined);

    while (step <= this.config.maxSteps) {
      throwIfAborted(signal);
      this.context.nextStep(task);

      // hybrid mode: reset stateful context after thresholds
      if (isHybrid && previousResponseId) {
        const shouldReset =
          step > this.config.hybridResetAfterSteps ||
          situationMemory.totalFailures() >= this.config.hybridResetAfterFailures;
        if (shouldReset) {
          previousResponseId = undefined;
          pendingInput = this.buildInput(task, situationMemory);
          console.log(`[hybrid] Context reset at step ${step} — switching to fresh stateless call.`);
        }
      }

      const spinner = ora(`Grok thinking (step ${step})`).start();
      let response: any;
      try {
        const useStateless = isStateless || (isHybrid && !previousResponseId);
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

      if (!usesPreviousResponseId(isStateless, isHybrid, previousResponseId)) {
        previousResponseId = parsed.id || previousResponseId;
      } else {
        previousResponseId = parsed.id || previousResponseId;
      }

      // watchdog: empty response
      if (!parsed.finalText && parsed.functionCalls.length === 0) {
        if (emptyResponseRetries < 1) {
          emptyResponseRetries += 1;
          console.log("[watchdog] Empty response detected. Nudging model to continue.");
          pendingInput = this.buildCorrectionInput(
            task,
            "Your previous response was empty. Continue by emitting exactly one tool call or a final answer.",
            isStateless || isHybrid ? situationMemory : undefined
          );
          step += 1;
          continue;
        }
        finalText = "[agent stopped: repeated empty responses from model]";
        break;
      }
      emptyResponseRetries = 0;

      // narration-only: model described intent without a tool call
      if (parsed.functionCalls.length === 0) {
        if (planOnlyReprompts < 2 && shouldContinueAfterPlanOnlyResponse(parsed.finalText, task, toolActionSummaries.length)) {
          planOnlyReprompts += 1;
          console.log(parsed.finalText);
          console.log("Grok provided a plan without tool calls; asking it to continue with the required tools.");
          pendingInput = this.buildCorrectionInput(
            task,
            "Invalid response: you stated an intention but did not call a tool. Return exactly one tool call or a final answer. Do not narrate intent without acting.",
            isStateless || isHybrid ? situationMemory : undefined
          );
          step += 1;
          continue;
        }
        finalText = parsed.finalText;
        break;
      }

      planOnlyReprompts = 0;
      if (parsed.finalText) {
        console.log(parsed.finalText);
      }
      console.log(formatToolBatch(step, parsed.functionCalls.map((call) => call.name)));

      // blind-retry guard: reject repeated failed tool+args before execution
      const blocked = parsed.functionCalls.find((call) => {
        let args: unknown;
        try { args = JSON.parse(call.arguments || "{}"); } catch { return false; }
        return situationMemory.hasRecentlyFailed(call.name, args);
      });
      if (blocked) {
        let args: unknown;
        try { args = JSON.parse(blocked.arguments || "{}"); } catch { args = {}; }
        const record = situationMemory.hasRecentlyFailed(blocked.name, args)!;
        console.log(`[guard] Blocking blind retry of ${blocked.name} (failed ${record.attempts}x). Injecting failure context.`);
        pendingInput = this.buildCorrectionInput(
          task,
          `BLIND RETRY BLOCKED:\nTool: ${record.tool}\nError: ${record.error}\nAttempts: ${record.attempts}\nConstraint: Do not retry the exact same action unchanged. Choose a different approach: narrow the scope, inspect logs, or change strategy.`,
          isStateless || isHybrid ? situationMemory : undefined
        );
        step += 1;
        continue;
      }

      const outputs = await this.executeToolBatch(
        parsed.functionCalls,
        step,
        usedToolNames,
        toolActionSummaries,
        hasModifiedFiles,
        situationMemory,
        signal
      );

      if (isStateless || isHybrid) {
        pendingInput = this.buildInput(task, situationMemory, outputs);
      } else {
        pendingInput = outputs;
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
    const actionSection = toolActionSummaries.length > 0 ? `\n\n[Actions completed]\n${formatActionSummary(toolActionSummaries)}` : "";
    const suffix = `${actionSection}${diffSection}\n\n[Final checks]\nBackground: ${gate.backgroundStatus}\nDiff checked: ${gate.diffChecked ? "yes" : "not needed"}`;
    return finalText ? `${finalText}${suffix}` : `Stopped after max steps without a final model message.${suffix}`;
  }

  private buildInput(task: string, memory?: SituationMemory, toolOutputs?: any[]): any {
    if (toolOutputs && toolOutputs.length > 0) {
      // in stateless/hybrid, append tool outputs as part of the fresh prompt context
      const base = this.buildStatelessPrompt(task, memory);
      return [{ role: "user", content: base }, ...toolOutputs];
    }
    if (memory) {
      return this.buildStatelessPrompt(task, memory);
    }
    return buildModelInput({
      task,
      context: this.context,
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
      projectInstructions: this.projectInstructions
    });
  }

  private buildStatelessPrompt(task: string, memory?: SituationMemory): string {
    return buildModelInput({
      task,
      context: this.context,
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
      projectInstructions: this.projectInstructions,
      situationSnapshot: memory?.snapshot()
    });
  }

  private buildCorrectionInput(task: string, correction: string, memory?: SituationMemory): string {
    const base = memory ? this.buildStatelessPrompt(task, memory) : "";
    return base ? `${base}\n\n<Correction>\n${correction}\n</Correction>` : correction;
  }

  private async executeToolBatch(
    functionCalls: Array<{ name: string; arguments?: string; call_id: string }>,
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
    situationMemory: SituationMemory,
    signal?: AbortSignal
  ): Promise<Array<{ type: "function_call_output"; call_id: string; output: string }>> {
    const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];
    for (let index = 0; index < functionCalls.length;) {
      const call = functionCalls[index];
      if (this.tools.isReadOnly(call.name)) {
        const readOnlyCalls = [];
        while (index < functionCalls.length && this.tools.isReadOnly(functionCalls[index].name)) {
          readOnlyCalls.push(functionCalls[index]);
          index += 1;
        }
        outputs.push(...await Promise.all(readOnlyCalls.map((item) => this.executeOneToolCall(item, step, usedToolNames, toolActionSummaries, hasModifiedFiles, situationMemory, signal))));
        continue;
      }
      outputs.push(await this.executeOneToolCall(call, step, usedToolNames, toolActionSummaries, hasModifiedFiles, situationMemory, signal));
      index += 1;
    }
    return outputs;
  }

  private async executeOneToolCall(
    call: { name: string; arguments?: string; call_id: string },
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
    situationMemory: SituationMemory,
    signal?: AbortSignal
  ): Promise<{ type: "function_call_output"; call_id: string; output: string }> {
    throwIfAborted(signal);
    usedToolNames.add(call.name);
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch (error) {
      const result = { ok: false, error: { code: "json_parse_error", message: error instanceof Error ? error.message : String(error) } };
      situationMemory.recordFailure(call.name, {}, "JSON parse error", step);
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
    }
    const result = await this.tools.execute(call.name, args, this.toolCtx);
    throwIfAborted(signal);
    if (call.name === "apply_patch" && result.ok) hasModifiedFiles.value = true;

    const summary = summarizeToolResult(result);
    toolActionSummaries.push({ step, name: call.name, ok: result.ok, summary });

    if (result.ok) {
      situationMemory.recordAction(call.name, args, true, summary);
    } else {
      situationMemory.recordAction(call.name, args, false);
      situationMemory.recordFailure(call.name, args, result.error.message, step);
    }

    this.context.add({
      type: "shell_output",
      content: `tool ${call.name}(${call.arguments}) => ${JSON.stringify(result).slice(0, 4000)}`,
      priority: 45,
      expiresAfterSteps: 2
    });
    return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
  }
}

function usesPreviousResponseId(isStateless: boolean, isHybrid: boolean, previousResponseId: string | undefined): boolean {
  return !isStateless && !(isHybrid && !previousResponseId);
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
  const lower = text.toLowerCase();
  const taskLower = task.toLowerCase();
  const saysItWillUseTools = /(brief plan|before first tool call|i'?ll now|i will now|proceeding to|run the first tool|call .*tool|use .*tool|工具)/i.test(text);
  const englishActionTask = /\b(commit|push|edit|modify|fix|write|create|delete|run|test|build|review|issue|pr)\b/i.test(taskLower);
  const localizedActionTask = ["修 bug", "修改", "修正", "建立", "新增", "刪除", "執行", "执行", "測試", "测试", "建置", "提交", "推送", "審核", "審核", "開pr", "開 issue"].some((keyword) => taskLower.includes(keyword));
  const claimsNoCapability = /no .*tool available|there is no .*tool|tools limited to/i.test(lower);
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
