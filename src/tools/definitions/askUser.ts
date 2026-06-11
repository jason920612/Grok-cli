import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

/**
 * ask_user — batched conceptual questions to the interactive user (scoping-v1 §6).
 *
 * For OPEN problems, gather requirements/goals/principles up front in ONE round,
 * calibrated to the user's per-domain level (concepts/analogies for domains they
 * don't know). Never ask the user technical implementation details — resolve
 * those on the agent board instead. In one-shot mode (no interactive user) this
 * returns a signal to proceed with stated assumptions rather than blocking.
 */
export function askUserTool(skills: ToolSkillRegistry) {
  return makeTool(
    "ask_user",
    "Ask the interactive user a batched set of CONCEPTUAL clarifying questions (about goals, priorities, desired outcome, process preferences) for an open-ended task. Calibrate language to the user's level — use plain concepts and analogies for non-technical users; never ask implementation/technical details here. Ask everything you need in one call. Optionally provide options per question.",
    schemas.object(
      { questions: { type: "array" }, preamble: { type: "string" } },
      ["questions"]
    ),
    z.object({
      questions: z.array(z.object({ question: z.string().min(1), options: z.array(z.string()).optional() })).min(1).max(6),
      preamble: z.string().optional()
    }),
    skills,
    async (args, ctx) => {
      if (!ctx.askUser) {
        return {
          interactive: false,
          note: "No interactive user is available (one-shot mode). Proceed with explicit, clearly-stated assumptions instead of asking; surface them in your plan."
        };
      }
      if (args.preamble) console.log(args.preamble);
      const answers = await ctx.askUser(args.questions);
      return { interactive: true, answers };
    }
  );
}
