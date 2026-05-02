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
      const selected = lines.slice(args.startLine - 1, args.endLine).map((line, i) => `${args.startLine + i}: ${line}`);
      const text = selected.join("\n");
      ctx.context.add({ type: "file_range", content: `${args.path}:${args.startLine}-${args.endLine}\n${text}`, priority: 70, expiresAfterSteps: 5, source: { path: args.path, startLine: args.startLine, endLine: args.endLine } });
      return { path: args.path, startLine: args.startLine, endLine: Math.min(args.endLine, lines.length), lineCount: lines.length, content: text };
    }
  );
}
