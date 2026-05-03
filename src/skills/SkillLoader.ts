import fs from "node:fs";
import path from "node:path";
import type { Skill } from "./Skill.js";
import { tokenEstimate } from "../context/tokenEstimate.js";
import { resolvePackageRoot } from "../packageRoot.js";

const PACKAGE_ROOT = resolvePackageRoot(import.meta.url);

export class SkillLoader {
  constructor(private readonly workspaceRoot: string) {}

  loadAll(): Skill[] {
    const builtins = this.loadDir(path.join(PACKAGE_ROOT, "src", "skills", "builtin"), true);
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
    if (/(run|test|build|install|lint|dev|server|command)/i.test(task) || includesAny(task, ["\u57f7\u884c", "\u6e2c\u8a66", "\u6d4b\u8bd5", "\u5efa\u7f6e", "\u5b89\u88dd"])) {
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
  if (id === "git-commit-push") return 94;
  if (id === "tree-based-code-navigation") return 92;
  if (id === "environment-awareness") return 90;
  return 70;
}

function triggersFor(id: string): string[] {
  const triggers: Record<string, string[]> = {
    "code-navigation": ["find", "where", "read", "search", "symbol", "file"],
    "patch-editing": ["edit", "fix", "change", "modify", "implement", "refactor", "\u4fee\u6539", "\u4fee\u6b63"],
    debugging: ["debug", "error", "failed", "exception", "stack", "\u9664\u932f", "\u9519\u8bef"],
    "test-driven-fix": ["test", "failing", "regression", "\u6e2c\u8a66", "\u6d4b\u8bd5"],
    "shell-usage": ["command", "shell", "run", "build", "lint", "\u57f7\u884c", "\u6267\u884c", "\u5efa\u7f6e"],
    "environment-awareness": ["environment", "install", "setup", "build", "test", "dev", "\u74b0\u5883", "\u5b89\u88dd"],
    "git-commit-push": ["commit", "push", "git commit", "git push", "write commit", "\u63d0\u4ea4", "\u63a8\u9001", "\u9001\u51fa", "\u958bpr", "\u958b pr"],
    "project-local-setup": ["install", "setup", "dependency", "tooling", "\u5b89\u88dd", "\u8a2d\u5b9a"],
    "project-understanding": ["project-understanding"],
    "tree-based-code-navigation": [
      "codebase",
      "find relevant files",
      "modify code",
      "debug",
      "failing test",
      "stack trace",
      "refactor",
      "implementation",
      "where is",
      "search project",
      "read file",
      "locate logic",
      "edit",
      "fix",
      "change",
      "feature",
      "review",
      "\u4fee\u6539",
      "\u4fee\u6b63",
      "\u529f\u80fd"
    ]
  };
  return triggers[id] ?? [id];
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function forcedSkills(task: string): string[] {
  return [...task.matchAll(/<Use Skill:\s*([a-z0-9-]+)\s*>/gi)].map((match) => match[1] ?? "");
}
