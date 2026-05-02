import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { findSymbolCandidates } from "../../workspace/CodeSearch.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function findSymbolTool(skills: ToolSkillRegistry) {
  return makeTool(
    "find_symbol",
    "Find scored symbol definition candidates for tree-based code navigation.",
    schemas.object({
      name: schemas.string("Function, class, type, interface, command, or tool name."),
      maxResults: schemas.number("Maximum scored candidates.")
    }, ["name"]),
    z.object({ name: z.string().min(1), maxResults: z.number().int().positive().max(100).optional() }),
    skills,
    async (args, ctx) => {
      const results = await findSymbolCandidates(ctx.sandbox, args.name, args.maxResults ?? 50);
      ctx.context.add({
        type: "search_result",
        content: `find_symbol ${args.name}\n${JSON.stringify(results, null, 2)}`,
        priority: 70,
        expiresAfterSteps: 3
      });
      return { results };
    }
  );
}
