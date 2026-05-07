import type { ContextItem } from "./ContextItem.js";
import { tokenEstimate } from "./tokenEstimate.js";

export function compactItems(items: ContextItem[], task: string, step = 0): ContextItem {
  const eligible = items.filter((item) => item.type !== "file_range" || item.priority >= 50).slice(-80);

  // Verified facts first, inferred/uncertain tagged explicitly so the model doesn't treat them as ground truth
  const verified = eligible.filter((item) => !item.factConfidence || item.factConfidence === "verified");
  const inferred = eligible.filter((item) => item.factConfidence === "inferred" || item.factConfidence === "uncertain");

  const formatItem = (item: ContextItem, tag?: string): string => {
    const prefix = tag ? ` [${tag}]` : "";
    return `- ${item.type}${prefix}: ${oneLine(item.content, 260)}`;
  };

  const facts = [
    ...verified.map((item) => formatItem(item)),
    ...inferred.map((item) => formatItem(item, item.factConfidence))
  ].join("\n");
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
    createdStep: step,
    lastUsedStep: step,
    pinned: true
  };
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}
