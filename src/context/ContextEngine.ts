import { createHash } from "node:crypto";
import type { ContextItem, FactConfidence } from "./ContextItem.js";
import { TUNING, type AgentTuning } from "../config/tuning.js";

/**
 * ContextEngine — the v2 replacement for ContextManager + ContextCompressor.
 *
 * Core principle (§6): compression is not deletion. Each item descends a
 * fidelity ladder and always keeps a re-traceable pointer. Selection is
 * side-effect-free and deterministic so the model input is byte-stable across
 * steps (prefix-cache friendly, §5).
 *
 * This Stage-1 build implements:
 *  - §6.1 ingest shaping (caller-side; items arrive already trimmed)
 *  - §6.2 re-fetchable degradation to a one-line pointer (not deletion)
 *  - §6.4 real budget + live token calibration from provider `usage`
 *  - §6.5 deterministic, side-effect-free selection
 *  - §6.6 read provenance + existence index (backs read-before-write, §9.5)
 *
 * §6.3 LLM structured rolling summary is intentionally deferred to Stage 3.
 *
 * It coexists with the legacy ContextManager (which the old loop still uses)
 * and is wired into the loop only at the Stage-2 skeleton switch.
 */

export type LineRange = { startLine: number; endLine: number };

/** Provenance discriminated union (§6.2). Drives degradation strategy. */
export type ItemProvenance =
  | { kind: "file"; path: string; startLine?: number; endLine?: number }
  | { kind: "search"; query: string; scope?: string }
  | { kind: "shell"; command: string }
  | { kind: "process"; processId: string }
  | { kind: "user" }
  | { kind: "model"; confidence: FactConfidence };

export type EngineItemType = ContextItem["type"];

export type EngineItemInput = {
  id?: string;
  type: EngineItemType;
  content: string;
  provenance: ItemProvenance;
  priority: number;
  pinned?: boolean;
  expiresAfterSteps?: number;
};

export type EngineItem = {
  id: string;
  type: EngineItemType;
  content: string;
  provenance: ItemProvenance;
  priority: number;
  pinned: boolean;
  expiresAfterSteps?: number;
  createdStep: number;
  /** Monotonic insertion order — deterministic tie-break, never a timestamp. */
  seq: number;
  /** True once content has been replaced by a re-fetch pointer (§6.2). */
  degraded: boolean;
};

/** Read record backing read-before-write (§6.6). */
export type FileReadRecord = {
  path: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  readAtStep: number;
  stale: boolean;
};

export class ContextEngine {
  private items = new Map<string, EngineItem>();
  private reads: FileReadRecord[] = [];
  private existence = new Set<string>();
  private step = 0;
  private seqCounter = 0;
  private charsPerToken: number;

  constructor(private readonly tuning: AgentTuning = TUNING) {
    this.charsPerToken = tuning.token.charsPerToken;
  }

  get currentStep(): number {
    return this.step;
  }

  /** Advance to the next step; degradation/eviction happen only here (§6.5). */
  nextStep(): number {
    this.step += 1;
    this.pruneExpired();
    this.compact();
    return this.step;
  }

  add(input: EngineItemInput): EngineItem {
    const id = input.id ?? `${input.type}-${this.seqCounter}`;
    const item: EngineItem = {
      id,
      type: input.type,
      content: input.content,
      provenance: input.provenance,
      priority: input.priority,
      pinned: input.pinned ?? false,
      expiresAfterSteps: input.expiresAfterSteps,
      createdStep: this.step,
      seq: this.seqCounter++,
      degraded: false
    };
    this.items.set(id, item);
    return item;
  }

  list(): EngineItem[] {
    return [...this.items.values()].sort((a, b) => a.seq - b.seq);
  }

  // --- §6.5 deterministic, side-effect-free selection ---------------------

  /**
   * Select items to fit `maxTokens`. Pinned items are always included.
   * Pure: no `lastUsedAt`/`lastUsedStep` mutation, no time-based tie-break.
   * Output is ordered by `seq` (insertion order) for byte-stable input.
   */
  select(maxTokens: number = this.tuning.context.relevantDefaultTokens): EngineItem[] {
    const ranked = [...this.items.values()].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.seq - b.seq;
    });
    const selected: EngineItem[] = [];
    let used = 0;
    for (const item of ranked) {
      const cost = this.estimate(item.content);
      if (!item.pinned && used + cost > maxTokens) continue;
      selected.push(item);
      used += cost;
    }
    return selected.sort((a, b) => a.seq - b.seq);
  }

  totalTokens(): number {
    let sum = 0;
    for (const item of this.items.values()) sum += this.estimate(item.content);
    return sum;
  }

  // --- §6.4 token calibration --------------------------------------------

  estimate(text: string): number {
    return Math.ceil(text.length / this.charsPerToken);
  }

  get charsPerTokenRatio(): number {
    return this.charsPerToken;
  }

  /** Calibrate chars-per-token from a real provider `usage` reading (EMA). */
  calibrate(inputTokens: number, sentChars: number, alpha = 0.3): void {
    if (!Number.isFinite(inputTokens) || !Number.isFinite(sentChars)) return;
    if (inputTokens <= 0 || sentChars <= 0) return;
    const observed = sentChars / inputTokens;
    this.charsPerToken = alpha * observed + (1 - alpha) * this.charsPerToken;
  }

  // --- §6.2 re-fetchable degradation -------------------------------------

  private static isRefetchable(provenance: ItemProvenance): boolean {
    return provenance.kind === "file" || provenance.kind === "search" || provenance.kind === "process";
  }

  static pointerFor(provenance: ItemProvenance): string {
    switch (provenance.kind) {
      case "file": {
        const range =
          provenance.startLine !== undefined
            ? `:${provenance.startLine}-${provenance.endLine ?? provenance.startLine}`
            : "";
        return `[degraded] previously read ${provenance.path}${range}; re-read with read_file_range if needed.`;
      }
      case "search":
        return `[degraded] previously searched "${provenance.query}"; re-run the search if needed.`;
      case "process":
        return `[degraded] background process ${provenance.processId}; use read_background_output if needed.`;
      default:
        return "[degraded]";
    }
  }

  /**
   * Degrade re-fetchable, non-pinned items (oldest first) until estimated
   * total is under the degrade threshold. Never deletes; replaces content
   * with a pointer so the model knows the data exists and how to fetch it.
   */
  private compact(): void {
    const threshold = this.degradeThreshold();
    if (this.totalTokens() <= threshold) return;
    const candidates = [...this.items.values()]
      .filter((item) => !item.pinned && !item.degraded && ContextEngine.isRefetchable(item.provenance))
      .sort((a, b) => a.seq - b.seq);
    for (const item of candidates) {
      if (this.totalTokens() <= threshold) break;
      item.content = ContextEngine.pointerFor(item.provenance);
      item.degraded = true;
    }
  }

  private degradeThreshold(): number {
    const usable = this.tuning.budget.maxInputTokens - this.tuning.budget.reservedForOutput;
    return Math.floor(usable * this.tuning.budget.degradeAtFraction);
  }

  private pruneExpired(): void {
    for (const item of this.items.values()) {
      if (item.pinned || item.expiresAfterSteps === undefined) continue;
      if (this.step - item.createdStep > item.expiresAfterSteps) this.items.delete(item.id);
    }
  }

  // --- §6.6 read provenance + existence index ----------------------------

  /** Record that a file region was read; backs read-before-write for `modify`. */
  recordRead(path: string, startLine: number, endLine: number, content: string): void {
    const norm = normalizePath(path);
    this.reads.push({
      path: norm,
      startLine,
      endLine,
      contentHash: hashContent(content),
      readAtStep: this.step,
      stale: false
    });
    this.existence.add(norm);
  }

  /**
   * True if this exact region was already read, the read has NOT been
   * invalidated by a later write (`stale`), and the content is unchanged
   * (same hash). Backs the duplicate-read guard: re-reading an identical,
   * unchanged region wastes the step budget and bloats the transcript, so the
   * read tool refuses it and points the model at what it already has.
   */
  hasFreshRead(path: string, startLine: number, endLine: number, content: string): boolean {
    const norm = normalizePath(path);
    const hash = hashContent(content);
    return this.reads.some(
      (r) => r.path === norm && !r.stale && r.startLine === startLine && r.endLine === endLine && r.contentHash === hash
    );
  }

  /** Register paths seen via listing/search/overview/status; backs `delete`. */
  recordExistence(paths: string[]): void {
    for (const path of paths) this.existence.add(normalizePath(path));
  }

  hasFileExistenceEvidence(path: string): boolean {
    return this.existence.has(normalizePath(path));
  }

  /** Invalidate all read records for a path after it is written (§9.5 step 4). */
  invalidateReads(path: string): void {
    const norm = normalizePath(path);
    for (const record of this.reads) {
      if (record.path === norm) record.stale = true;
    }
  }

  /**
   * For a `modify`, return the line ranges NOT covered by a fresh (non-stale)
   * read. Empty array means every requested line has been read → write allowed.
   */
  uncoveredForWrite(path: string, ranges: LineRange[]): LineRange[] {
    const norm = normalizePath(path);
    const covers = this.reads.filter((r) => r.path === norm && !r.stale);
    return ranges.flatMap((range) => subtractRanges(range, covers));
  }

  /** Exposed for read-before-write freshness checks against disk (Stage 2). */
  readRecords(path: string): FileReadRecord[] {
    const norm = normalizePath(path);
    return this.reads.filter((r) => r.path === norm);
  }
}

function subtractRanges(target: LineRange, covers: LineRange[]): LineRange[] {
  let segments: LineRange[] = [target];
  for (const cover of covers) {
    segments = segments.flatMap((seg) => removeOverlap(seg, cover));
  }
  return segments;
}

function removeOverlap(seg: LineRange, cover: LineRange): LineRange[] {
  if (cover.endLine < seg.startLine || cover.startLine > seg.endLine) return [seg];
  const result: LineRange[] = [];
  if (cover.startLine > seg.startLine) result.push({ startLine: seg.startLine, endLine: cover.startLine - 1 });
  if (cover.endLine < seg.endLine) result.push({ startLine: cover.endLine + 1, endLine: seg.endLine });
  return result;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
