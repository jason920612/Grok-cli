import type { CompletionUsage } from "../api/LLMProvider.js";

type Totals = { inputTokens: number; outputTokens: number; cachedInputTokens: number; calls: number };

const blank = (): Totals => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 });

/**
 * Cumulative token usage for an interactive session.
 *
 * xAI's Responses API does automatic prompt-prefix caching; it reports how many
 * input tokens were served from cache (`cachedInputTokens`). The stateless loop
 * keeps a stable prefix per task, so most steps after the first hit the cache.
 * This tracker makes that visible (per-task footer + /status) instead of the
 * number being read off the wire and dropped.
 */
export class SessionUsage {
  private readonly totals = blank();
  private lapMark = blank();

  record(usage?: CompletionUsage): void {
    if (!usage) return;
    this.totals.calls += 1;
    this.totals.inputTokens += usage.inputTokens ?? 0;
    this.totals.outputTokens += usage.outputTokens ?? 0;
    this.totals.cachedInputTokens += usage.cachedInputTokens ?? 0;
  }

  /** Delta since the previous lap() call, advancing the marker. */
  lap(): Totals {
    const delta: Totals = {
      inputTokens: this.totals.inputTokens - this.lapMark.inputTokens,
      outputTokens: this.totals.outputTokens - this.lapMark.outputTokens,
      cachedInputTokens: this.totals.cachedInputTokens - this.lapMark.cachedInputTokens,
      calls: this.totals.calls - this.lapMark.calls
    };
    this.lapMark = { ...this.totals };
    return delta;
  }

  get hasData(): boolean {
    return this.totals.calls > 0;
  }

  /** Cumulative one-liner for /status. */
  format(): string {
    return `tokens this session: ${formatTotals(this.totals)}`;
  }
}

export function formatTotals(t: Totals): string {
  const hit = t.inputTokens > 0 ? Math.round((t.cachedInputTokens / t.inputTokens) * 100) : 0;
  return `in ${fmt(t.inputTokens)} (cached ${fmt(t.cachedInputTokens)}, ${hit}% hit) · out ${fmt(t.outputTokens)} · ${t.calls} call${t.calls === 1 ? "" : "s"}`;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
