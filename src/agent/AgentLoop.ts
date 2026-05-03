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
    const hasModifiedFiles = { value: false };
    this.context.upsert("user-task", { type: "user_task", content: task, priority: 100, pinned: true });

    let step = 1;
    let pendingInput: any = buildModelInput({
      task,
      context: this.context,
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
      projectInstructions: this.projectInstructions
    });

    while (step <= this.config.maxSteps) {
      throwIfAborted(signal);
      this.context.nextStep(task);
      const spinner = ora(`Grok thinking (step ${step})`).start();
      let response: any;
      try {
        response = await createResponse(this.client, {
          model: this.config.model,
          input: pendingInput,
          tools: this.tools.schemas(serverTools(this.config)),
          toolChoice: this.config.toolChoice,
          previousResponseId,
          signal
        });
      } finally {
        spinner.stop();
      }
      throwIfAborted(signal);
      const parsed = parseResponse(response);
      previousResponseId = parsed.id || previousResponseId;
      if (parsed.functionCalls.length === 0) {
        if (planOnlyReprompts < 2 && shouldContinueAfterPlanOnlyResponse(parsed.finalText, task, toolActionSummaries.length)) {
          planOnlyReprompts += 1;
          console.log(parsed.finalText);
          console.log("Grok provided a plan without tool calls; asking it to continue with the required tools.");
          pendingInput = "You provided a plan but did not request any function_call tools. The user asked for an action, not only a plan. Continue now by requesting the appropriate tools in this response. If the action cannot be completed, explain the concrete blocker after using any relevant inspection tools.";
          step += 1;
          continue;
        }
        finalText = parsed.finalText;
        break;
      }
      if (parsed.finalText) {
        console.log(parsed.finalText);
      }
      console.log(formatToolBatch(step, parsed.functionCalls.map((call) => call.name)));

      const outputs = await this.executeToolBatch(parsed.functionCalls, step, usedToolNames, toolActionSummaries, hasModifiedFiles, signal);
      pendingInput = outputs;
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

  private async executeToolBatch(
    functionCalls: Array<{ name: string; arguments?: string; call_id: string }>,
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
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
        outputs.push(...await Promise.all(readOnlyCalls.map((item) => this.executeOneToolCall(item, step, usedToolNames, toolActionSummaries, hasModifiedFiles, signal))));
        continue;
      }
      outputs.push(await this.executeOneToolCall(call, step, usedToolNames, toolActionSummaries, hasModifiedFiles, signal));
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
    signal?: AbortSignal
  ): Promise<{ type: "function_call_output"; call_id: string; output: string }> {
    throwIfAborted(signal);
    usedToolNames.add(call.name);
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch (error) {
      const result = { ok: false, error: { code: "json_parse_error", message: error instanceof Error ? error.message : String(error) } };
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
    }
    const result = await this.tools.execute(call.name, args, this.toolCtx);
    throwIfAborted(signal);
    if (call.name === "apply_patch" && result.ok) hasModifiedFiles.value = true;
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
      expiresAfterSteps: 2
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

export function shouldContinueAfterPlanOnlyResponse(text: string, task: string, actionCount: number): boolean {
  if (!text.trim()) return false;
  const lower = text.toLowerCase();
  const taskLower = task.toLowerCase();
  const saysItWillUseTools = /(brief plan|before first tool call|i'?ll now|i will now|proceeding to|run the first tool|call .*tool|use .*tool|工具)/i.test(text);
  const englishActionTask = /\b(commit|push|edit|modify|fix|write|create|delete|run|test|build|review|issue|pr)\b/i.test(taskLower);
  const localizedActionTask = ["\u4fee bug", "\u4fee\u6539", "\u4fee\u6b63", "\u5efa\u7acb", "\u65b0\u589e", "\u522a\u9664", "\u6267\u884c", "\u57f7\u884c", "\u6e2c\u8a66", "\u6d4b\u8bd5", "\u5efa\u7f6e", "\u63d0\u4ea4", "\u63a8\u9001", "\u5be9\u6838", "\u5ba1\u6838", "\u958bpr", "\u958b issue"].some((keyword) => taskLower.includes(keyword));
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
