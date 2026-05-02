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
  const seenMessages = new Set<string>();

  const addMessage = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.trim();
    if (!normalized || seenMessages.has(normalized)) return;
    seenMessages.add(normalized);
    messages.push(normalized);
  };

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
        addMessage(content?.text);
        addMessage(content?.output_text);
      }
    }
    addMessage(item?.content);
  }

  addMessage(response?.output_text);

  return {
    id: String(response?.id ?? ""),
    functionCalls,
    finalText: messages.join("\n").trim(),
    raw: response
  };
}
