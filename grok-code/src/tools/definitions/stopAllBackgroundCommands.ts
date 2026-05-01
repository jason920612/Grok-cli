import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function stopAllBackgroundCommandsTool(skills: ToolSkillRegistry) {
  return makeTool(
    "stop_all_background_commands",
    "Stop all background commands started by this agent session.",
    schemas.object({ reason: schemas.string("Why all background commands should stop.") }),
    z.object({ reason: z.string().optional().default("cleanup") }),
    skills,
    async (args, ctx) => ({ stopped: await ctx.background.stopAll(args.reason) })
  );
}
