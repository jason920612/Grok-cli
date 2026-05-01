import fs from "node:fs";
import path from "node:path";
import type { ToolSkill } from "./ToolSkill.js";
import { tokenEstimate } from "../context/tokenEstimate.js";

export class ToolSkillRegistry {
  private skills = new Map<string, ToolSkill>();

  constructor(private readonly root: string) {}

  loadBuiltin(toolNames: string[]): void {
    for (const toolName of toolNames) {
      const file = path.join(this.root, "src", "tool-skills", "builtin", `${toolName}.skill.md`);
      const full = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : defaultFull(toolName);
      this.skills.set(toolName, makeSkill(toolName, full));
    }
  }

  get(toolName: string): ToolSkill {
    return this.skills.get(toolName) ?? makeSkill(toolName, defaultFull(toolName));
  }

  list(): ToolSkill[] {
    return [...this.skills.values()];
  }

  toolIndex(): string {
    return ["Available tools:", ...this.list().map((skill) => `- ${skill.toolName}: ${skill.short}`)].join("\n");
  }

  select(task: string, names: string[] = [], max = 6): ToolSkill[] {
    const lower = task.toLowerCase();
    return this.list()
      .filter((skill) => names.includes(skill.toolName) || lower.includes(skill.toolName.replaceAll("_", " ")))
      .sort((a, b) => b.priority - a.priority)
      .slice(0, max);
  }
}

function makeSkill(toolName: string, full: string): ToolSkill {
  const title = toolName.replaceAll("_", " ");
  return {
    id: `${toolName}-skill`,
    toolName,
    title,
    purpose: firstNonHeading(full),
    whenToUse: ["Use when the task needs this local capability."],
    beforeUse: ["Inspect enough context and choose narrow parameters."],
    standardProcedure: ["Call the tool with validated arguments.", "Interpret the bounded result.", "Keep only relevant context."],
    parameterGuidance: ["Prefer narrow paths, globs, ranges, and limits."],
    resultInterpretation: ["Use returned summaries and line references; do not infer unseen file contents."],
    afterUse: ["Store concise context and proceed to the next smallest useful step."],
    avoid: ["Avoid broad repeated calls and generated files."],
    failureRecovery: ["On failure, narrow scope or inspect project/environment context."],
    examples: [{ situation: "Need precise local information", good: `Call ${toolName} with a narrow scope.` }],
    short: firstNonHeading(full).slice(0, 180),
    full,
    tokenEstimate: tokenEstimate(full),
    priority: 70
  };
}

function firstNonHeading(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "Tool operating procedure.";
}

function defaultFull(toolName: string): string {
  return `# ${toolName}\nUse ${toolName} carefully with narrow scope. Keep outputs compact and relevant.`;
}
