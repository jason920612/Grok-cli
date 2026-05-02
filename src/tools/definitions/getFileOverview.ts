import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { readTextFile } from "../../workspace/FileSystem.js";
import { getFileOverviewContent } from "../../workspace/FileOverview.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function getFileOverviewTool(skills: ToolSkillRegistry) {
  return makeTool(
    "get_file_overview",
    "Inspect imports, exports, functions, classes, and line numbers without reading full file content.",
    schemas.object({ path: schemas.string("File path inside workspace.") }, ["path"]),
    z.object({ path: z.string().min(1) }),
    skills,
    async (args, ctx) => {
      const content = await readTextFile(ctx.sandbox, args.path);
      const overview = getFileOverviewContent(content);
      ctx.context.add({ type: "file_overview", content: `${args.path}\n${JSON.stringify(overview, null, 2)}`, priority: 60, expiresAfterSteps: 5, source: { path: args.path } });
      return overview;
    }
  );
}
