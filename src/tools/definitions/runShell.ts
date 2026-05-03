import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool, summarizeOutput } from "./helpers.js";
import { GENERATED_OUTPUT_DIRS } from "../../workspace/IgnoreRules.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const execAsync = promisify(exec);

export function runShellTool(skills: ToolSkillRegistry) {
  return makeTool(
    "run_shell",
    "Run a bounded foreground shell command in the workspace. Dangerous or global commands require approval or are denied.",
    schemas.object({ command: { type: "string" }, reason: { type: "string" }, timeoutSeconds: { type: "number" } }, ["command", "reason"]),
    z.object({ command: z.string().min(1), reason: z.string().min(1), timeoutSeconds: z.number().positive().max(600).optional() }),
    skills,
    async (args, ctx) => {
      const approval = await ctx.approval.approveCommand(args.command, args.reason);
      if (!approval.approved) throw new Error(approval.message ?? `Command rejected: ${approval.risk}`);
      const timeout = (args.timeoutSeconds ?? 120) * 1000;
      const existingGeneratedDirs = snapshotGeneratedDirs(ctx.workspaceRoot);
      try {
        const { stdout, stderr } = await execAsync(args.command, { cwd: ctx.workspaceRoot, timeout, maxBuffer: 5_000_000, windowsHide: true });
        markNewGeneratedDirs(ctx, existingGeneratedDirs);
        const output = summarizeOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`);
        ctx.context.add({ type: "shell_output", content: `$ ${args.command}\n${output.text}`, priority: /test|build|lint|typecheck/i.test(args.command) ? 75 : 50, expiresAfterSteps: 2, source: { command: args.command } });
        return { command: args.command, exitCode: 0, stdout: output.text, truncated: output.truncated };
      } catch (error: any) {
        markNewGeneratedDirs(ctx, existingGeneratedDirs);
        const combined = `${error?.stdout ?? ""}${error?.stderr ? `\n${error.stderr}` : ""}${error?.message ? `\n${error.message}` : ""}`;
        const output = summarizeOutput(combined);
        ctx.context.add({ type: /test|build|lint|typecheck/i.test(args.command) ? "test_result" : "shell_output", content: `$ ${args.command}\n${output.text}`, priority: 80, expiresAfterSteps: 2, source: { command: args.command } });
        return { command: args.command, exitCode: error?.code ?? 1, stdout: output.text, truncated: output.truncated };
      }
    }
  );
}

function snapshotGeneratedDirs(workspaceRoot: string): Set<string> {
  const existing = new Set<string>();
  for (const dir of GENERATED_OUTPUT_DIRS) {
    const abs = path.join(workspaceRoot, dir);
    if (directoryExists(abs)) existing.add(dir);
  }
  return existing;
}

function markNewGeneratedDirs(ctx: any, before: Set<string>): void {
  for (const dir of GENERATED_OUTPUT_DIRS) {
    const abs = path.join(ctx.workspaceRoot, dir);
    if (before.has(dir) || !directoryExists(abs)) continue;
    ctx.sandbox.allowGeneratedOutputPath(dir);
    ctx.context.add({
      type: "environment_summary",
      content: `Generated output directory allowed for this session: ${dir}`,
      priority: 60,
      expiresAfterSteps: 4,
      source: { command: "sandbox generated output tracking" }
    });
  }
}

function directoryExists(absPath: string): boolean {
  try {
    return fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}
