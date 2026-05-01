import fs from "node:fs";
import path from "node:path";
import type { Skill } from "./Skill.js";
import { tokenEstimate } from "../context/tokenEstimate.js";

export class SkillLoader {
  constructor(private readonly workspaceRoot: string) {}

  loadAll(): Skill[] {
    const builtins = this.loadDir(path.join(this.workspaceRoot, "src", "skills", "builtin"), true);
    const project = this.loadProjectSkills();
    return [...builtins, ...project];
  }

  select(task: string, max = 5): Skill[] {
    const lower = task.toLowerCase();
    const all = this.loadAll();
    const forcedSkillIds = forcedSkills(task);
    const selected = all.filter((skill) =>
      skill.id === "context-hygiene"
      || skill.id === "project-local-setup"
      || forcedSkillIds.includes(skill.id)
      || skill.triggers.some((trigger) => lower.includes(trigger))
    );
    if (/(run|test|build|install|lint|dev|server|command)/i.test(task)) {
      const env = all.find((skill) => skill.id === "environment-awareness");
      if (env && !selected.includes(env)) selected.push(env);
    }
    return selected.sort((a, b) => b.priority - a.priority).slice(0, max);
  }

  projectInstructions(): string {
    const grok = path.join(this.workspaceRoot, "GROK.md");
    return fs.existsSync(grok) ? fs.readFileSync(grok, "utf8").slice(0, 12_000) : "";
  }

  private loadDir(dir: string, builtin: boolean): Skill[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      const id = file.replace(/\.md$/, "");
      return {
        id,
        title: heading(content) ?? id,
        description: firstLine(content),
        triggers: triggersFor(id),
        priority: builtin ? priorityFor(id) : 50,
        content,
        tokenEstimate: tokenEstimate(content)
      };
    });
  }

  private loadProjectSkills(): Skill[] {
    return this.loadDir(path.join(this.workspaceRoot, ".grok-code", "skills"), false);
  }
}

function heading(content: string): string | undefined {
  return content.match(/^#\s+(.+)$/m)?.[1];
}

function firstLine(content: string): string {
  return content.split(/\r?\n/).find((line) => line.trim() && !line.startsWith("#"))?.trim() ?? "";
}

function priorityFor(id: string): number {
  if (id === "context-hygiene") return 100;
  if (id === "project-local-setup") return 95;
  if (id === "environment-awareness") return 90;
  return 70;
}

function triggersFor(id: string): string[] {
  return {
    "code-navigation": ["find", "where", "read", "search", "symbol", "file"],
    "patch-editing": ["edit", "fix", "change", "modify", "implement", "refactor"],
    debugging: ["debug", "error", "failed", "exception", "stack"],
    "test-driven-fix": ["test", "failing", "regression"],
    "shell-usage": ["command", "shell", "run", "build", "lint"],
    "environment-awareness": ["environment", "install", "setup", "build", "test", "dev"],
    "project-local-setup": ["install", "setup", "dependency", "tooling"],
    "project-understanding": ["project-understanding"]
  }[id] ?? [id];
}

function forcedSkills(task: string): string[] {
  return [...task.matchAll(/<Use Skill:\s*([a-z0-9-]+)\s*>/gi)].map((match) => match[1] ?? "");
}
