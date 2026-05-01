import type { ContextItem } from "./ContextItem.js";
import { tokenEstimate } from "./tokenEstimate.js";

export function compactItems(items: ContextItem[], task: string): ContextItem {
  const facts = items
    .filter((item) => item.type !== "file_range" || item.priority >= 50)
    .slice(-80)
    .map((item) => `- ${item.type}: ${oneLine(item.content, 260)}`)
    .join("\n");
  const content = [
    `Current task: ${task}`,
    "Known facts, files, decisions, tool outputs, patches, tests, and pending work:",
    facts || "- No accumulated context yet."
  ].join("\n");
  const now = Date.now();
  return {
    id: "task-summary",
    type: "task_summary",
    content,
    tokensEstimate: tokenEstimate(content),
    priority: 100,
    createdAt: now,
    lastUsedAt: now,
    pinned: true
  };
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}
