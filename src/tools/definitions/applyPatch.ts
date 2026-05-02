import fs from "node:fs/promises";
import path from "node:path";
import { parsePatch, applyPatch as applyOnePatch } from "diff";
import { z } from "zod";
import chalk from "chalk";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function applyPatchTool(skills: ToolSkillRegistry) {
  return makeTool(
    "apply_patch",
    "Apply a unified diff patch to files inside the workspace.",
    schemas.object({ patch: schemas.string("Unified diff patch."), reason: schemas.string("Why this patch is needed.") }, ["patch", "reason"]),
    z.object({ patch: z.string().min(1), reason: z.string().min(1) }),
    skills,
    async (args, ctx) => {
      const parsed = parsePatch(args.patch);
      if (parsed.length === 0) throw new Error("Patch is not a valid unified diff.");
      const approved = await ctx.approval.approvePatch(args.reason);
      if (!approved) throw new Error("Patch denied by approval policy.");
      const modified: string[] = [];
      for (const filePatch of parsed) {
        const target = cleanPatchPath(filePatch.newFileName && filePatch.newFileName !== "/dev/null" ? filePatch.newFileName : filePatch.oldFileName);
        if (!target) throw new Error("Patch file path missing.");
        const abs = ctx.sandbox.assertWritablePatchPath(target);
        const oldContent = filePatch.oldFileName === "/dev/null" ? "" : await fs.readFile(abs, "utf8").catch(() => "");
        const next = applyOnePatch(oldContent, filePatch);
        if (next === false) throw new Error(`Patch failed for ${target}`);
        await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => undefined);
        await fs.writeFile(abs, next, "utf8");
        modified.push(target);
      }
      console.log(chalk.green("Applied patch:"));
      console.log(colorUnifiedDiff(args.patch));
      ctx.context.add({ type: "patch", content: args.patch, priority: 85, source: { command: args.reason } });
      return { modifiedFiles: modified, reminder: "Run git_diff and the smallest relevant tests/checks before final answer." };
    }
  );
}

function colorUnifiedDiff(patch: string): string {
  return patch.split(/\r?\n/).map((line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) return chalk.green(line);
    if (line.startsWith("-") && !line.startsWith("---")) return chalk.red(line);
    if (line.startsWith("@@")) return chalk.cyan(line);
    if (line.startsWith("diff ") || line.startsWith("index ")) return chalk.dim(line);
    return line;
  }).join("\n");
}

function cleanPatchPath(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  return fileName.replace(/^a\//, "").replace(/^b\//, "");
}
