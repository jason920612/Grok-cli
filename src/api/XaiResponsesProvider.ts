import { parseResponse } from "./responseParser.js";
import type {
  CompletionRequest,
  CompletionResult,
  CompletionUsage,
  LLMProvider,
  ModelMessage,
  ProviderCapabilities
} from "./LLMProvider.js";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_TIMEOUT_MS = 360_000;

export type XaiProviderOptions = {
  apiKey: string;
  model: string;
  baseURL?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  capabilities?: Partial<ProviderCapabilities>;
};

/**
 * xAI provider implemented as a direct HTTP client to the Responses API.
 *
 * xAI publishes no first-party JS/TS SDK (it recommends the OpenAI-compatible
 * client), so per the project's provider policy — official SDK when one exists,
 * otherwise the raw HTTP endpoint — this talks to `/v1/responses` over `fetch`
 * with no SDK dependency. Other sources (OpenAI, Anthropic) get their own
 * official-SDK-backed providers behind the same {@link LLMProvider} seam.
 *
 * Operates statelessly: every call sends the full message list, never
 * `previous_response_id`. The agent's ContextManager is the single source of
 * conversation truth.
 */
export class XaiResponsesProvider implements LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: XaiProviderOptions) {
    this.id = options.model;
    this.apiKey = options.apiKey;
    this.endpoint = `${(options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/responses`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.capabilities = {
      serverTools: options.capabilities?.serverTools ?? ["web_search", "x_search"],
      promptCaching: options.capabilities?.promptCaching ?? true
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body = {
      model: this.id,
      input: req.messages.map(toInputItem),
      tools: req.tools,
      tool_choice: req.toolChoice,
      parallel_tool_calls: req.parallelToolCalls ?? true
    };
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      signal: withTimeout(req.signal, this.timeoutMs)
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new XaiHttpError(res.status, detail);
    }
    return toCompletionResult(await res.json());
  }
}

export function createXaiProvider(
  options: Omit<XaiProviderOptions, "apiKey"> & { apiKey?: string }
): XaiResponsesProvider {
  const apiKey = options.apiKey ?? process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing XAI_API_KEY. Set it with: export XAI_API_KEY='your_api_key'");
  }
  return new XaiResponsesProvider({ ...options, apiKey });
}

export class XaiHttpError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`xAI API request failed: status=${status}${detail ? ` body=${detail.slice(0, 500)}` : ""}`);
    this.name = "XaiHttpError";
  }
}

function toInputItem(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { type: "function_call_output", call_id: message.toolCallId, output: message.content };
  }
  return { role: message.role, content: message.content };
}

function toCompletionResult(raw: any): CompletionResult {
  const parsed = parseResponse(raw);
  const warnings: string[] = [];
  if (!parsed.id) warnings.push("Provider response is missing an id.");
  if (parsed.functionCalls.some((call) => !call.name)) {
    warnings.push("One or more tool calls were missing a name.");
  }
  if (parsed.functionCalls.length > 1) {
    warnings.push(`Provider returned ${parsed.functionCalls.length} tool calls in one turn.`);
  }
  if (!parsed.finalText && parsed.functionCalls.length === 0) {
    warnings.push("Provider returned neither text nor tool calls.");
  }
  return {
    id: parsed.id,
    text: parsed.finalText,
    toolCalls: parsed.functionCalls.map((call) => ({
      id: call.call_id,
      name: call.name,
      argsJson: call.arguments
    })),
    usage: extractUsage(raw),
    warnings,
    raw
  };
}

function extractUsage(raw: any): CompletionUsage | undefined {
  const usage = raw?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = numberOrUndefined(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = numberOrUndefined(usage.output_tokens ?? usage.completion_tokens);
  const cachedInputTokens = numberOrUndefined(
    usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens
  );
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens, cachedInputTokens };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
