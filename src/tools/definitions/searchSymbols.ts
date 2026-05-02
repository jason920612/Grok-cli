import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { searchSymbols } from "../../workspace/SymbolSearch.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function searchSymbolsTool(skills: ToolSkillRegistry) {
  return makeTool(
    "search_symbols",
    "Find functions, classes, types, interfaces, exports, and methods by symbol name.",
    schemas.object({ query: schemas.string("Symbol name query."), maxResults: schemas.number("Maximum results.") }, ["query"]),
    z.object({ query: z.string().min(1), maxResults: z.number().int().positive().max(200).optional() }),
    skills,
    async (args, ctx) => {
      const results = await searchSymbols(ctx.sandbox, args.query, args.maxResults ?? 50);
      ctx.context.add({ type: "search_result", content: `search_symbols ${args.query}\n${JSON.stringify(results, null, 2)}`, priority: 60, expiresAfterSteps: 3 });
      return { results };
    }
  );
}
