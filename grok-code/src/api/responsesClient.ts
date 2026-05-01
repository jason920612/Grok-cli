import type OpenAI from "openai";
import type { ToolChoice } from "../config/loadConfig.js";

export type ResponseInputItem = Record<string, unknown> | string;
export type ResponseTool = Record<string, unknown>;

export type CreateResponseOptions = {
  model: string;
  input: ResponseInputItem[] | string;
  tools: ResponseTool[];
  toolChoice: ToolChoice;
  previousResponseId?: string;
};

export async function createResponse(client: OpenAI, options: CreateResponseOptions): Promise<any> {
  const payload: Record<string, unknown> = {
    model: options.model,
    input: options.input,
    tools: options.tools,
    tool_choice: options.toolChoice,
    parallel_tool_calls: true
  };
  if (options.previousResponseId) payload.previous_response_id = options.previousResponseId;
  return (client as any).responses.create(payload);
}
