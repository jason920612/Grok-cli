import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool, summarizeOutput } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const execFileAsync = promisify(execFile);

export function gitDiffTool(skills: ToolSkillRegistry) {
  return makeTool(
    "git_diff",
    "Inspect current git diff with stat and bounded patch.",
    schemas.object({ path: schemas.string("Optional file path.") }),
    z.object({ path: z.string().optional() }),
    skills,
    async (args, ctx) => {
      const pathArg = args.path ? ["--", args.path] : [];
      const stat = await execFileAsync("git", ["diff", "--stat", ...pathArg], { cwd: ctx.workspaceRoot, timeout: 10_000, windowsHide: true }).then((r) => r.stdout).catch(() => "");
      const diff = await execFileAsync("git", ["diff", ...pathArg], { cwd: ctx.workspaceRoot, timeout: 10_000, maxBuffer: 5_000_000, windowsHide: true }).then((r) => r.stdout).catch(() => "");
      const bounded = summarizeOutput(diff, 260, 30_000);
      ctx.context.add({ type: "patch", content: `git diff --stat\n${stat}\n\ngit diff\n${bounded.text}`, priority: 80, expiresAfterSteps: 5, source: { path: args.path } });
      return { stat, diff: bounded.text, truncated: bounded.truncated };
    }
  );
}
