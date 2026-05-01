import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function stopBackgroundCommandTool(skills: ToolSkillRegistry) {
  return makeTool(
    "stop_background_command",
    "Stop a background command started by this agent session.",
    schemas.object({ id: { type: "string" }, reason: { type: "string" } }, ["id", "reason"]),
    z.object({ id: z.string().min(1), reason: z.string().min(1) }),
    skills,
    async (args, ctx) => {
      const stopped = await ctx.background.stop(args.id, args.reason);
      ctx.context.add({ type: "background_process", content: `Stopped ${args.id}: ${args.reason}`, priority: 60, source: { processId: args.id } });
      return stopped;
    }
  );
}
