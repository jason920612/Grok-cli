import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { getRelatedFiles } from "../../workspace/CodeSearch.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function getRelatedFilesTool(skills: ToolSkillRegistry) {
  return makeTool(
    "get_related_files",
    "Return direct imports, exports, imported-by candidates, tests, and related symbols for a file.",
    schemas.object({
      path: schemas.string("Workspace file path."),
      maxResults: schemas.number("Maximum related items per category.")
    }, ["path"]),
    z.object({ path: z.string().min(1), maxResults: z.number().int().positive().max(100).optional() }),
    skills,
    async (args, ctx) => {
      const related = await getRelatedFiles(ctx.sandbox, args.path, args.maxResults ?? 40);
      ctx.context.add({
        type: "file_overview",
        content: `get_related_files ${args.path}\n${JSON.stringify(related, null, 2)}`,
        priority: 65,
        expiresAfterSteps: 5,
        source: { path: args.path }
      });
      return related;
    }
  );
}
