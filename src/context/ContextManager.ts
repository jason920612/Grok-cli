import { CONTEXT_BUDGET } from "./ContextBudget.js";
import type { ContextItem } from "./ContextItem.js";
import { compactItems } from "./ContextCompressor.js";
import { relevanceScore } from "./RelevanceScorer.js";
import { tokenEstimate } from "./tokenEstimate.js";

export class ContextManager {
  private items = new Map<string, ContextItem>();
  private step = 0;

  constructor(initialItems: ContextItem[] = []) {
    for (const item of initialItems) {
      const createdStep = item.createdStep ?? this.step;
      this.items.set(item.id, {
        ...item,
        createdStep,
        lastUsedStep: item.lastUsedStep ?? createdStep
      });
    }
  }

  add(item: Omit<ContextItem, "id" | "createdAt" | "lastUsedAt" | "createdStep" | "lastUsedStep" | "tokensEstimate"> & { id?: string; tokensEstimate?: number }): ContextItem {
    const now = Date.now();
    const full: ContextItem = {
      ...item,
      id: item.id ?? `${item.type}-${now}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: now,
      lastUsedAt: now,
      createdStep: this.step,
      lastUsedStep: this.step,
      tokensEstimate: item.tokensEstimate ?? tokenEstimate(item.content)
    };
    this.items.set(full.id, full);
    this.prune();
    return full;
  }

  upsert(id: string, item: Omit<ContextItem, "id" | "createdAt" | "lastUsedAt" | "createdStep" | "lastUsedStep" | "tokensEstimate"> & { tokensEstimate?: number }): ContextItem {
    const existing = this.items.get(id);
    const now = Date.now();
    const full: ContextItem = {
      ...item,
      id,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
      createdStep: existing?.createdStep ?? this.step,
      lastUsedStep: this.step,
      tokensEstimate: item.tokensEstimate ?? tokenEstimate(item.content)
    };
    this.items.set(id, full);
    this.prune();
    return full;
  }

  drop(id: string): boolean {
    const item = this.items.get(id);
    if (item?.pinned) return false;
    return this.items.delete(id);
  }

  list(): ContextItem[] {
    return [...this.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  byType(type: ContextItem["type"]): ContextItem[] {
    return this.list().filter((item) => item.type === type);
  }

  totalTokens(): number {
    return this.list().reduce((sum, item) => sum + item.tokensEstimate, 0);
  }

  nextStep(task: string): void {
    this.step += 1;
    if (this.totalTokens() > CONTEXT_BUDGET.warningLimit || this.step % 8 === 0) {
      this.compactContext(task);
    } else {
      this.prune();
    }
  }

  compactContext(task: string): ContextItem {
    const summary = compactItems(this.list(), task, this.step);
    this.items.set(summary.id, summary);
    for (const item of this.list()) {
      if (!item.pinned && ["shell_output", "background_output_summary", "search_result"].includes(item.type)) {
        this.items.delete(item.id);
      }
    }
    this.prune();
    return summary;
  }

  relevant(task: string, maxTokens = 90_000): ContextItem[] {
    const sorted = this.list().sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return relevanceScore(b, task) - relevanceScore(a, task);
    });
    const selected: ContextItem[] = [];
    let used = 0;
    for (const item of sorted) {
      if (used + item.tokensEstimate > maxTokens && !item.pinned) continue;
      selected.push(item);
      item.lastUsedAt = Date.now();
      item.lastUsedStep = this.step;
      used += item.tokensEstimate;
    }
    return selected.sort((a, b) => a.createdAt - b.createdAt);
  }

  private prune(): void {
    for (const item of this.list()) {
      if (!item.pinned && item.expiresAfterSteps !== undefined && this.step - item.createdStep > item.expiresAfterSteps) {
        this.items.delete(item.id);
      }
    }
    while (this.totalTokens() > CONTEXT_BUDGET.maxInputTokens - CONTEXT_BUDGET.reservedForOutput) {
      const removable = this.list()
        .filter((item) => !item.pinned)
        .sort((a, b) => a.priority - b.priority || a.lastUsedAt - b.lastUsedAt)[0];
      if (!removable) break;
      this.items.delete(removable.id);
    }
  }
}
