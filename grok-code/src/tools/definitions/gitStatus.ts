import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const execFileAsync = promisify(execFile);

export function gitStatusTool(skills: ToolSkillRegistry) {
  return makeTool(
    "git_status",
    "Inspect git status with changed files.",
    { type: "object", properties: {}, required: [], additionalProperties: false },
    z.object({}).optional().default({}),
    skills,
    async (_args, ctx) => {
      const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], { cwd: ctx.workspaceRoot, timeout: 10_000, windowsHide: true });
      const changedFiles = stdout.split(/\r?\n/).filter((line) => line && !line.startsWith("##")).map((line) => line.slice(3).trim());
      ctx.context.add({ type: "shell_output", content: `git status --short --branch\n${stdout}`, priority: 65, expiresAfterSteps: 2, source: { command: "git status --short --branch" } });
      return { raw: stdout, changedFiles };
    }
  );
}
