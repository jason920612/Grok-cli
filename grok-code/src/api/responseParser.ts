export type ParsedFunctionCall = {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
};

export type ParsedResponse = {
  id: string;
  functionCalls: ParsedFunctionCall[];
  finalText: string;
  raw: unknown;
};

export function parseResponse(response: any): ParsedResponse {
  const output = Array.isArray(response?.output) ? response.output : [];
  const functionCalls: ParsedFunctionCall[] = [];
  const messages: string[] = [];

  for (const item of output) {
    if (item?.type === "function_call") {
      functionCalls.push({
        type: "function_call",
        name: String(item.name ?? ""),
        call_id: String(item.call_id ?? item.id ?? ""),
        arguments: String(item.arguments ?? "{}")
      });
      continue;
    }
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (typeof content?.text === "string") messages.push(content.text);
        if (typeof content?.output_text === "string") messages.push(content.output_text);
      }
    }
    if (typeof item?.content === "string") messages.push(item.content);
  }

  if (typeof response?.output_text === "string" && response.output_text.length > 0) {
    messages.push(response.output_text);
  }

  return {
    id: String(response?.id ?? ""),
    functionCalls,
    finalText: messages.join("\n").trim(),
    raw: response
  };
}
