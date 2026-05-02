import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { getRelatedFiles } from "../../workspace/CodeSearch.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function expandNodeTool(skills: ToolSkillRegistry) {
  return makeTool(
    "expand_node",
    "Expand a search-tree file node into direct imports, imported-by candidates, tests, and related symbols.",
    schemas.object({
      path: schemas.string("Workspace file path for the node to expand."),
      maxResults: schemas.number("Maximum related items per category.")
    }, ["path"]),
    z.object({ path: z.string().min(1), maxResults: z.number().int().positive().max(100).optional() }),
    skills,
    async (args, ctx) => {
      const related = await getRelatedFiles(ctx.sandbox, args.path, args.maxResults ?? 40);
      ctx.context.add({
        type: "file_overview",
        content: `expand_node ${args.path}\n${JSON.stringify(related, null, 2)}`,
        priority: 65,
        expiresAfterSteps: 5,
        source: { path: args.path }
      });
      return related;
    }
  );
}
