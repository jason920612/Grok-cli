import { exec } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
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
      const existingGeneratedDirs = await snapshotGeneratedDirs(ctx.workspaceRoot);
      try {
        const { stdout, stderr } = await execAsync(args.command, { cwd: ctx.workspaceRoot, timeout, maxBuffer: 5_000_000, windowsHide: true });
        await markNewGeneratedDirs(ctx, existingGeneratedDirs);
        const output = summarizeOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`);
        ctx.context.add({
          type: "shell_output",
          content: `$ ${args.command}\n${output.text}`,
          priority: /test|build|lint|typecheck/i.test(args.command) ? 75 : 50,
          expiresAfterSteps: 2,
          factSource: /test|build|lint|typecheck/i.test(args.command) ? "test" : "tool_output",
          factConfidence: "verified",
          source: { command: args.command }
        });
        return { command: args.command, exitCode: 0, stdout: output.text, truncated: output.truncated };
      } catch (error: any) {
        await markNewGeneratedDirs(ctx, existingGeneratedDirs);
        const combined = `${error?.stdout ?? ""}${error?.stderr ? `\n${error.stderr}` : ""}${error?.message ? `\n${error.message}` : ""}`;
        const output = summarizeOutput(combined);
        ctx.context.add({
          type: /test|build|lint|typecheck/i.test(args.command) ? "test_result" : "shell_output",
          content: `$ ${args.command}\n${output.text}`,
          priority: 80,
          expiresAfterSteps: 2,
          factSource: /test|build|lint|typecheck/i.test(args.command) ? "test" : "tool_output",
          factConfidence: "verified",
          source: { command: args.command }
        });
        return { command: args.command, exitCode: error?.code ?? 1, stdout: output.text, truncated: output.truncated };
      }
    }
  );
}

async function snapshotGeneratedDirs(workspaceRoot: string): Promise<Set<string>> {
  const patterns = GENERATED_OUTPUT_DIRS.flatMap((dir) => [dir, `**/${dir}`]);
  const matches = await fg(patterns, {
    cwd: workspaceRoot,
    dot: true,
    onlyDirectories: true,
    unique: true,
    ignore: ["**/.git/**", "**/node_modules/**"]
  });
  return new Set(matches.map((entry) => entry.replace(/\\/g, "/")));
}

async function markNewGeneratedDirs(ctx: any, before: Set<string>): Promise<void> {
  const after = await snapshotGeneratedDirs(ctx.workspaceRoot);
  for (const dir of after) {
    if (before.has(dir)) continue;
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
