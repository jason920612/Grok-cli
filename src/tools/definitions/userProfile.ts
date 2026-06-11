import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { USER_LEVELS } from "../../memory/UserProfile.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function noteUserLevelTool(skills: ToolSkillRegistry) {
  return makeTool(
    "note_user_level",
    `Record your inferred assessment of the user's technical level for a domain (e.g. "backend", "frontend", "database", "ml", "devops"). Level is one of: ${USER_LEVELS.join(" | ")}. Used to calibrate how you ask scoping questions: jargon for domains they know, concepts/analogies for domains they don't. Update when you get new signal.`,
    schemas.object({ domain: { type: "string" }, level: { type: "string" } }, ["domain", "level"]),
    z.object({ domain: z.string().min(1), level: z.enum(USER_LEVELS) }),
    skills,
    async (args, ctx) => {
      if (!ctx.userProfile) throw new Error("User profile is not available in this context.");
      ctx.userProfile.setLevel(args.domain, args.level);
      return { domain: args.domain, level: args.level };
    }
  );
}
