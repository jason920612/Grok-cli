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

  async run(task: string, oneShot: boolean): Promise<string> {
    let previousResponseId: string | undefined;
    let finalText = "";
    const usedToolNames = new Set<string>();
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
      this.context.nextStep(task);
      const spinner = ora(`Grok thinking (step ${step})`).start();
      const response = await createResponse(this.client, {
        model: this.config.model,
        input: pendingInput,
        tools: this.tools.schemas(serverTools(this.config)),
        toolChoice: this.config.toolChoice,
        previousResponseId
      });
      spinner.stop();
      const parsed = parseResponse(response);
      previousResponseId = parsed.id || previousResponseId;
      if (parsed.functionCalls.length === 0) {
        finalText = parsed.finalText;
        break;
      }

      const outputs = await Promise.all(parsed.functionCalls.map(async (call) => {
        usedToolNames.add(call.name);
        let args: unknown;
        try {
          args = JSON.parse(call.arguments || "{}");
        } catch (error) {
          args = {};
          const result = { ok: false, error: { code: "json_parse_error", message: error instanceof Error ? error.message : String(error) } };
          return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
        }
        const result = await this.tools.execute(call.name, args, this.toolCtx);
        if (call.name === "apply_patch" && result.ok) hasModifiedFiles.value = true;
        this.context.add({
          type: "shell_output",
          content: `tool ${call.name}(${call.arguments}) => ${JSON.stringify(result).slice(0, 4000)}`,
          priority: 45,
          expiresAfterSteps: 2
        });
        return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
      }));
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
    const suffix = `\n\n[Final checks]\nBackground: ${gate.backgroundStatus}\nDiff checked: ${gate.diffChecked ? "yes" : "not needed"}`;
    return finalText ? `${finalText}${suffix}` : `Stopped after max steps without a final model message.${suffix}`;
  }
}

function serverTools(config: GrokCodeConfig): ResponseTool[] {
  if (!config.serverTools) return [];
  const tools: ResponseTool[] = [];
  if (config.enableWebSearch) tools.push({ type: "web_search" });
  if (config.enableXSearch) tools.push({ type: "x_search" });
  return tools;
}
