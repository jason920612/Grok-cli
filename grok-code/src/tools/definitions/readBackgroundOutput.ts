import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function readBackgroundOutputTool(skills: ToolSkillRegistry) {
  return makeTool(
    "read_background_output",
    "Read recent stdout/stderr from a background command without stopping it.",
    schemas.object({ id: { type: "string" }, maxLines: { type: "number" } }, ["id"]),
    z.object({ id: z.string().min(1), maxLines: z.number().int().positive().max(200).optional() }),
    skills,
    async (args, ctx) => {
      const lines = ctx.background.read(args.id, args.maxLines ?? 120);
      const content = lines.join("\n");
      ctx.context.add({ type: "background_output_summary", content, priority: 55, expiresAfterSteps: 2, source: { processId: args.id } });
      return { id: args.id, output: content };
    }
  );
}
