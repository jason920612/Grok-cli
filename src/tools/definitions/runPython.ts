import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool, summarizeOutput } from "./helpers.js";
import { GENERATED_OUTPUT_DIRS } from "../../workspace/IgnoreRules.js";
import type { ToolExecutionContext } from "../AgentTool.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const execFileAsync = promisify(execFile);

/**
 * run_python (§9.4) — cross-platform execution tool that replaces run_shell.
 *
 * Python gives uniform behaviour across Windows/macOS/Linux (the project runs
 * on Windows where bash one-liners break). External programs (git/npm/tsc) are
 * invoked via `subprocess`. Code is passed via `python -c` through execFile (no
 * shell), so the code string itself is not subject to shell interpolation.
 *
 * Note: this is NOT a sandbox — Python can still touch the filesystem and
 * network. Risk is classified by scanning for dangerous capabilities
 * (classifyPythonCode) and gated through approval.
 */
export function runPythonTool(skills: ToolSkillRegistry) {
  return makeTool(
    "run_python",
    "Run a Python script in the workspace (cross-platform). Use for shell-like tasks and invoke external programs via subprocess. Prefer apply_patch for file edits.",
    schemas.object(
      { code: { type: "string" }, reason: { type: "string" }, timeoutSeconds: { type: "number" } },
      ["code", "reason"]
    ),
    z.object({ code: z.string().min(1), reason: z.string().min(1), timeoutSeconds: z.number().positive().max(600).optional() }),
    skills,
    async (args, ctx) => {
      const approval = await ctx.approval.approveCode(args.code, args.reason);
      if (!approval.approved) throw new Error(approval.message ?? `Python execution rejected: ${approval.risk}`);
      const timeout = (args.timeoutSeconds ?? 120) * 1000;
      const python = pythonExecutable();
      const isCheck = /test|build|lint|typecheck|pytest|mypy/i.test(args.code);
      const existingGeneratedDirs = await snapshotGeneratedDirs(ctx.workspaceRoot);
      try {
        const { stdout, stderr } = await execFileAsync(python, ["-c", args.code], {
          cwd: ctx.workspaceRoot,
          timeout,
          maxBuffer: 5_000_000,
          windowsHide: true
        });
        await markNewGeneratedDirs(ctx, existingGeneratedDirs);
        const output = summarizeOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`);
        ctx.context.add({
          type: isCheck ? "test_result" : "shell_output",
          content: `run_python:\n${output.text}`,
          priority: isCheck ? 75 : 50,
          expiresAfterSteps: 2,
          factSource: isCheck ? "test" : "tool_output",
          factConfidence: "verified",
          source: { command: "run_python" }
        });
        return { exitCode: 0, stdout: output.text, truncated: output.truncated };
      } catch (error: any) {
        await markNewGeneratedDirs(ctx, existingGeneratedDirs);
        const combined = `${error?.stdout ?? ""}${error?.stderr ? `\n${error.stderr}` : ""}${error?.message ? `\n${error.message}` : ""}`;
        const output = summarizeOutput(combined);
        ctx.context.add({
          type: isCheck ? "test_result" : "shell_output",
          content: `run_python (failed):\n${output.text}`,
          priority: 80,
          expiresAfterSteps: 2,
          factSource: isCheck ? "test" : "tool_output",
          factConfidence: "verified",
          source: { command: "run_python" }
        });
        return { exitCode: error?.code ?? 1, stdout: output.text, truncated: output.truncated };
      }
    }
  );
}

function pythonExecutable(): string {
  if (process.env.GROK_PYTHON) return process.env.GROK_PYTHON;
  return process.platform === "win32" ? "python" : "python3";
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

async function markNewGeneratedDirs(ctx: ToolExecutionContext, before: Set<string>): Promise<void> {
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
