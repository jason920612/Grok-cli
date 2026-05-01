import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { inspectProjectTooling } from "../../workspace/ProjectTooling.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function checkProjectToolingTool(skills: ToolSkillRegistry) {
  return makeTool(
    "check_project_tooling",
    "Inspect project-local tooling, scripts, lockfiles, version files, and dependency declarations to choose local commands instead of global setup.",
    schemas.object({ purpose: schemas.string("The intended task, such as test, lint, build, dev server, format, typecheck, install, or run tool.") }, ["purpose"]),
    z.object({ purpose: z.string().min(1) }),
    skills,
    async (args, ctx) => {
      const result = inspectProjectTooling(ctx.workspaceRoot, args.purpose);
      ctx.context.upsert("project-tooling-summary", { type: "project_tooling_summary", content: JSON.stringify(result, null, 2), priority: 95, pinned: true });
      return result;
    }
  );
}
