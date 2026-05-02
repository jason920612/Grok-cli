import { z } from "zod";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function listBackgroundCommandsTool(skills: ToolSkillRegistry) {
  return makeTool("list_background_commands", "List background commands started by this agent session.", { type: "object", properties: {}, required: [], additionalProperties: false }, z.object({}).optional().default({}), skills, async (_args, ctx) => ({ processes: ctx.background.list() }));
}
