import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { searchCode } from "../../workspace/CodeSearch.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function searchCodeTool(skills: ToolSkillRegistry) {
  return makeTool(
    "search_code",
    "Search the codebase with a tree-navigation scoring model across paths, exact text, and symbols.",
    schemas.object({
      query: schemas.string("Search query from the current search tree branch."),
      maxResults: schemas.number("Maximum scored results.")
    }, ["query"]),
    z.object({ query: z.string().min(1), maxResults: z.number().int().positive().max(100).optional() }),
    skills,
    async (args, ctx) => {
      const results = await searchCode(ctx.sandbox, args.query, args.maxResults ?? 50);
      ctx.context.add({
        type: "search_result",
        content: `search_code ${args.query}\n${JSON.stringify(results, null, 2)}`,
        priority: 65,
        expiresAfterSteps: 3
      });
      return { results };
    }
  );
}
