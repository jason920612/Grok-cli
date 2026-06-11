/**
 * Provider-agnostic LLM interface.
 *
 * The agent core depends on this, never on the OpenAI SDK or xAI's Responses
 * API directly. `XaiResponsesProvider` adapts the Responses API to this shape;
 * other providers (Chat Completions, Anthropic Messages, local models) can be
 * added without touching the loop.
 *
 * The interface is messages-based — the largest common denominator across
 * providers. Server-side conversation chaining (`previous_response_id`) is an
 * implementation detail of a provider, never visible above this boundary.
 */

export type ModelMessage =
  | { role: "system" | "user" | "assistant"; content: string; images?: string[] }
  | { role: "tool_call"; toolCallId: string; name: string; argsJson: string }
  | { role: "tool"; toolCallId: string; content: string };

export type ToolSchema = Record<string, unknown>;

export type ToolChoiceMode = "auto" | "required" | "none";

export type CompletionRequest = {
  messages: ModelMessage[];
  tools: ToolSchema[];
  toolChoice: ToolChoiceMode;
  /** Allow the model to emit more than one tool call per turn. Defaults true. */
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
};

export type CompletionToolCall = {
  id: string;
  name: string;
  argsJson: string;
};

export type CompletionUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens served from the provider's prompt cache, when reported. */
  cachedInputTokens?: number;
};

export type CompletionResult = {
  /** Provider response id (e.g. for debugging / tracing). May be empty. */
  id: string;
  text: string;
  toolCalls: CompletionToolCall[];
  usage?: CompletionUsage;
  /** Non-fatal parse anomalies surfaced for observability, not silently dropped. */
  warnings: string[];
  /** Raw provider response, for diagnostics only. */
  raw: unknown;
};

export type ProviderCapabilities = {
  /** Server-side tool names the provider exposes (e.g. "web_search", "x_search"). */
  serverTools: string[];
  /** Whether the provider does prompt-prefix caching (the stateless cost model relies on this). */
  promptCaching: boolean;
};

export type CompletionChunk = {
  textDelta?: string;
  done?: boolean;
};

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Reserved for future streaming support; not implemented yet by all providers. */
  stream?(req: CompletionRequest): AsyncIterable<CompletionChunk>;
}
