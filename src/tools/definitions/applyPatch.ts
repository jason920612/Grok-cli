import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import chalk from "chalk";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { parseCodexPatch, applyCodexUpdate, codexPatchMetadata, type CodexAction } from "../codexPatch.js";
import { findLazyMarkers } from "../lazyMarkers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";
import type { PatchApprovalMetadata } from "../../approval/ApprovalPolicy.js";

const DESCRIPTION =
  "Apply changes to workspace files using the apply_patch envelope (context-located, no line numbers). " +
  "Wrap in `*** Begin Patch` / `*** End Patch`. Use `*** Add File: <path>` (then +lines), " +
  "`*** Update File: <path>` (then `@@` hunks of ' ' context / '-' removed / '+' added lines), " +
  "`*** Delete File: <path>`, and optional `*** Move to: <path>`. " +
  "You must read the lines you change first (read-before-write).";

export function applyPatchTool(skills: ToolSkillRegistry) {
  return makeTool(
    "apply_patch",
    DESCRIPTION,
    schemas.object({ patch: schemas.string("apply_patch envelope."), reason: schemas.string("Why this patch is needed.") }, ["patch", "reason"]),
    z.object({ patch: z.string().min(1), reason: z.string().min(1) }),
    skills,
    async (args, ctx) => {
      const parsed = parseCodexPatch(args.patch);
      if (parsed.actions.length === 0) throw new Error("Patch contains no file actions.");

      // Anti-laziness gate: refuse stub/placeholder/MVP markers in added code.
      const lazy = findLazyMarkers(args.patch);
      if (lazy.length > 0) {
        const detail = lazy.slice(0, 6).map((h) => `  • "${h.marker}"  →  ${h.line}`).join("\n");
        throw new Error(
          `REJECTED — this patch contains lazy / placeholder / MVP markers, which are forbidden:\n${detail}\n` +
            `This is exactly the corner-cutting behavior that is not allowed. Implement the COMPLETE, working logic here — ` +
            `no placeholders, no "... rest unchanged", no "in a real implementation", no TODOs left for later, no mock/hardcoded stand-ins for real logic. ` +
            `Re-submit the patch with the full implementation. If a piece genuinely belongs in a later step, build that step now rather than leaving a marker.`
        );
      }

      const approved = await ctx.approval.approvePatch(args.reason, patchApprovalMetadata(parsed.actions));
      if (!approved) throw new Error("Patch denied by approval policy.");

      const modified: string[] = [];
      const deleted: string[] = [];
      for (const action of parsed.actions) {
        const abs = ctx.sandbox.assertWritablePatchPath(action.path);
        const round = ctx.round?.();

        if (action.type === "add") {
          if (ctx.snapshots && round !== undefined) ctx.snapshots.snapshot(abs, action.path, "create", round);
          await fs.mkdir(path.dirname(abs), { recursive: true }).catch(() => undefined);
          await fs.writeFile(abs, joinFileLines(action.lines), "utf8");
          ctx.engine?.invalidateReads(action.path);
          ctx.engine?.recordExistence([action.path]);
          modified.push(action.path);
          continue;
        }

        if (action.type === "delete") {
          if (ctx.engine && !ctx.engine.hasFileExistenceEvidence(action.path)) {
            throw new Error(
              `Refusing to delete ${action.path} without prior evidence it exists. List or inspect it first (list_files / get_file_overview).`
            );
          }
          if (ctx.snapshots && round !== undefined) ctx.snapshots.snapshot(abs, action.path, "delete", round);
          await fs.unlink(abs);
          ctx.engine?.invalidateReads(action.path);
          deleted.push(action.path);
          continue;
        }

        // update
        const content = await fs.readFile(abs, "utf8").catch(() => {
          throw new Error(`Cannot update ${action.path}: file not found.`);
        });
        const { result, ranges } = applyCodexUpdate(content, action.hunks);

        // read-before-write (§9.5): the modified regions must have been read & fresh.
        if (ctx.engine && ranges.length > 0) {
          const uncovered = ctx.engine.uncoveredForWrite(action.path, ranges);
          if (uncovered.length > 0) {
            const spans = uncovered.map((r) => `${r.startLine}-${r.endLine}`).join(", ");
            throw new Error(
              `Refusing to modify ${action.path}: lines ${spans} have not been read (or were changed since). ` +
                `Read them with read_file_range before editing.`
            );
          }
        }

        const targetAbs = action.movePath ? ctx.sandbox.assertWritablePatchPath(action.movePath) : abs;
        if (ctx.snapshots && round !== undefined) ctx.snapshots.snapshot(abs, action.path, "overwrite", round);
        await fs.mkdir(path.dirname(targetAbs), { recursive: true }).catch(() => undefined);
        await fs.writeFile(targetAbs, result, "utf8");
        ctx.engine?.invalidateReads(action.path);
        if (action.movePath) {
          await fs.unlink(abs).catch(() => undefined);
          ctx.engine?.invalidateReads(action.movePath);
        }
        modified.push(action.movePath ?? action.path);
      }

      console.log(chalk.green(`Applied patch: ${[...modified, ...deleted].join(", ")}`));
      return { modifiedFiles: modified, deletedFiles: deleted, reminder: "Run git_diff and the smallest relevant tests/checks before final answer." };
    }
  );
}

function joinFileLines(lines: string[]): string {
  const body = lines.join("\n");
  return body.endsWith("\n") || body === "" ? body : `${body}\n`;
}

function patchApprovalMetadata(actions: CodexAction[]): PatchApprovalMetadata {
  return { files: codexPatchMetadata(actions) };
}
