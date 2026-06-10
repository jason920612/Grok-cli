import type { LLMProvider } from "../api/LLMProvider.js";

/**
 * RollingSummarizer (§6.3) — LLM structured rolling summary.
 *
 * Old/low-priority evidence is distilled into a JSON {@link EpisodeSummary}
 * (not prose), so two summaries can be merged *deterministically* (union +
 * dedup) without going through the model again — error does not accumulate.
 * `failedAttempts` is a first-class field: the thing a summary most easily
 * drops and most expensively forgets.
 */

export type SummaryFact = { text: string; provenance: string; confidence: "verified" | "inferred" | "uncertain" };
export type FileTouch = { path: string; action: "read" | "modified" | "created" };
export type FailedAttempt = { what: string; why: string };

export type EpisodeSummary = {
  facts: SummaryFact[];
  filesTouched: FileTouch[];
  decisions: string[];
  failedAttempts: FailedAttempt[];
  openQuestions: string[];
};

export const EMPTY_SUMMARY: EpisodeSummary = {
  facts: [],
  filesTouched: [],
  decisions: [],
  failedAttempts: [],
  openQuestions: []
};

const SUMMARY_PROMPT = `You compress an AI coding agent's working memory. Read the items below and return ONLY a JSON object (no prose, no fences) of this exact shape:
{
  "facts": [{"text": "...", "provenance": "tool/file/etc", "confidence": "verified|inferred|uncertain"}],
  "filesTouched": [{"path": "...", "action": "read|modified|created"}],
  "decisions": ["..."],
  "failedAttempts": [{"what": "...", "why": "..."}],
  "openQuestions": ["..."]
}
Be faithful and concise. Preserve failed attempts — they prevent repeated mistakes. Do not invent facts.`;

export class RollingSummarizer {
  constructor(private readonly provider: LLMProvider) {}

  async summarize(items: string[]): Promise<EpisodeSummary> {
    if (items.length === 0) return clone(EMPTY_SUMMARY);
    const input = `${SUMMARY_PROMPT}\n\n<items>\n${items.map((it, i) => `${i + 1}. ${it}`).join("\n")}\n</items>`;
    try {
      const result = await this.provider.complete({
        messages: [{ role: "user", content: input }],
        tools: [],
        toolChoice: "none",
        parallelToolCalls: false
      });
      return parseEpisodeSummary(result.text);
    } catch {
      return clone(EMPTY_SUMMARY);
    }
  }
}

/** Deterministic union merge — no LLM, no error accumulation. */
export function mergeSummaries(a: EpisodeSummary, b: EpisodeSummary): EpisodeSummary {
  return {
    facts: dedupeBy([...a.facts, ...b.facts], (f) => f.text.trim().toLowerCase()),
    filesTouched: dedupeBy([...a.filesTouched, ...b.filesTouched], (f) => `${f.path}:${f.action}`),
    decisions: dedupeStrings([...a.decisions, ...b.decisions]),
    failedAttempts: dedupeBy([...a.failedAttempts, ...b.failedAttempts], (f) => `${f.what}=>${f.why}`.toLowerCase()),
    openQuestions: dedupeStrings([...a.openQuestions, ...b.openQuestions])
  };
}

export function renderSummary(summary: EpisodeSummary): string {
  const lines: string[] = [];
  if (summary.facts.length) {
    lines.push("Facts:");
    for (const f of summary.facts) lines.push(`- [${f.confidence}] ${f.text} (${f.provenance})`);
  }
  if (summary.filesTouched.length) {
    lines.push("Files touched:");
    for (const f of summary.filesTouched) lines.push(`- ${f.action} ${f.path}`);
  }
  if (summary.decisions.length) {
    lines.push("Decisions:");
    for (const d of summary.decisions) lines.push(`- ${d}`);
  }
  if (summary.failedAttempts.length) {
    lines.push("Failed attempts (do not repeat):");
    for (const f of summary.failedAttempts) lines.push(`- ${f.what} — ${f.why}`);
  }
  if (summary.openQuestions.length) {
    lines.push("Open questions:");
    for (const q of summary.openQuestions) lines.push(`- ${q}`);
  }
  return lines.join("\n") || "No accumulated summary yet.";
}

export function parseEpisodeSummary(text: string): EpisodeSummary {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return clone(EMPTY_SUMMARY);
  let raw: any;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return clone(EMPTY_SUMMARY);
  }
  return {
    facts: asArray(raw.facts).map((f: any) => ({
      text: String(f?.text ?? ""),
      provenance: String(f?.provenance ?? "unknown"),
      confidence: f?.confidence === "verified" || f?.confidence === "inferred" ? f.confidence : "uncertain"
    })).filter((f: SummaryFact) => f.text),
    filesTouched: asArray(raw.filesTouched).map((f: any) => ({
      path: String(f?.path ?? ""),
      action: f?.action === "modified" || f?.action === "created" ? f.action : "read"
    })).filter((f: FileTouch) => f.path),
    decisions: asArray(raw.decisions).map(String).filter(Boolean),
    failedAttempts: asArray(raw.failedAttempts).map((f: any) => ({
      what: String(f?.what ?? ""),
      why: String(f?.why ?? "")
    })).filter((f: FailedAttempt) => f.what),
    openQuestions: asArray(raw.openQuestions).map(String).filter(Boolean)
  };
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function dedupeStrings(items: string[]): string[] {
  return dedupeBy(items.filter((s) => s.trim()), (s) => s.trim().toLowerCase());
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function clone(summary: EpisodeSummary): EpisodeSummary {
  return JSON.parse(JSON.stringify(summary));
}
