import type { ContextItem } from "./ContextItem.js";

export function relevanceScore(item: ContextItem, task: string): number {
  const haystack = `${item.type} ${item.content}`.toLowerCase();
  const terms = task.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  const hits = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
  return item.priority + hits;
}
