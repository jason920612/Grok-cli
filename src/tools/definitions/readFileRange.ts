import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { readTextFile } from "../../workspace/FileSystem.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function readFileRangeTool(skills: ToolSkillRegistry) {
  return makeTool(
    "read_file_range",
    "Read a specific line range from a text file inside the workspace. Prefer this over reading entire files.",
    schemas.object({ path: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" } }, ["path", "startLine", "endLine"]),
    z.object({ path: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive() }),
    skills,
    async (args, ctx) => {
      if (args.endLine < args.startLine) throw new Error("endLine must be >= startLine.");
      const content = await readTextFile(ctx.sandbox, args.path);
      const lines = content.split(/\r?\n/);
      const requested = args.endLine - args.startLine + 1;
      if (requested > 200 && lines.length >= 150) throw new Error("Range too large. Request at most 200 lines, or the whole file only if it is under 150 lines.");
      const clampedEnd = Math.min(args.endLine, lines.length);
      const rawRegion = lines.slice(args.startLine - 1, args.endLine);
      // Return raw lines WITHOUT line-number prefixes: apply_patch locates by
      // content, and prefixes copied into a patch break hunk matching.
      const text = rawRegion.join("\n");
      // Stable id so re-reading the SAME range refreshes one context item
      // instead of stacking duplicate copies (a real transcript-growth driver).
      const itemId = `file_range:${args.path}:${args.startLine}-${clampedEnd}`;

      // Duplicate-read guard: if this exact region was already read and has NOT
      // changed since (no intervening write invalidated it), refuse re-sending
      // the content. It is already in context — re-reading only burns steps and
      // re-bloats the transcript. Refresh the existing item so the content is
      // guaranteed still present, and return a short pointer instead of the body.
      if (ctx.engine?.hasFreshRead(args.path, args.startLine, clampedEnd, text)) {
        ctx.context.upsert(itemId, {
          type: "file_range",
          content: `${args.path}:${args.startLine}-${clampedEnd}\n${text}`,
          priority: 70,
          expiresAfterSteps: 5,
          factSource: "tool_output",
          factConfidence: "verified",
          source: { path: args.path, startLine: args.startLine, endLine: clampedEnd }
        });
        return {
          path: args.path,
          startLine: args.startLine,
          endLine: clampedEnd,
          lineCount: lines.length,
          unchanged: true,
          note: "You already read this exact range and it has not changed — the content is still in your context. Do NOT re-read it; act on what you have (edit, verify, or move on)."
        };
      }

      // Record read provenance for read-before-write (§6.6/§9.5).
      ctx.engine?.recordRead(args.path, args.startLine, clampedEnd, text);
      ctx.context.upsert(itemId, {
        type: "file_range",
        content: `${args.path}:${args.startLine}-${clampedEnd}\n${text}`,
        priority: 70,
        expiresAfterSteps: 5,
        factSource: "tool_output",
        factConfidence: "verified",
        source: { path: args.path, startLine: args.startLine, endLine: clampedEnd }
      });
      return { path: args.path, startLine: args.startLine, endLine: clampedEnd, lineCount: lines.length, content: text };
    }
  );
}
