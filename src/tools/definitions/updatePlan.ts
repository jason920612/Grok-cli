import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

/**
 * update_plan — Codex-style maintained plan (a step checklist with statuses).
 *
 * The agent calls this BEFORE starting non-trivial work to lay out its plan,
 * and again to update step statuses as it progresses. The plan is pinned in
 * context so it stays in view, which both keeps the agent on track and forces
 * it to decompose large work into discrete steps (rather than charging at a
 * giant task in one shot). The orchestrator uses it to plan parallel sub-tasks.
 */
const STATUSES = ["pending", "in_progress", "completed"] as const;

export function updatePlanTool(skills: ToolSkillRegistry) {
  return makeTool(
    "update_plan",
    "Record or update your step-by-step plan (a checklist). Call this BEFORE starting non-trivial work to lay out the steps, then call it again to flip steps to in_progress/completed as you go. Each item: {step, status: pending|in_progress|completed}. Keep exactly one step in_progress at a time.",
    schemas.object(
      { plan: { type: "array" }, explanation: { type: "string" } },
      ["plan"]
    ),
    z.object({
      plan: z.array(z.object({ step: z.string().min(1), status: z.enum(STATUSES) })).min(1).max(30),
      explanation: z.string().optional()
    }),
    skills,
    async (args, ctx) => {
      // Enforce the Codex invariant: at most one step in_progress. A plan with
      // several "in progress" steps is just a wish-list — reject it so the model
      // commits to one active step at a time.
      const inProgress = args.plan.filter((p) => p.status === "in_progress").length;
      if (inProgress > 1) {
        throw new Error(`A plan may have at most ONE step in_progress at a time (got ${inProgress}). Mark only the step you are actively working on as in_progress; the rest are pending or completed.`);
      }
      const content = renderPlan(args.plan, args.explanation);
      // No-op guard: re-recording an IDENTICAL plan is the classic orchestrator
      // spin (it churns update_plan instead of acting/finishing). Refuse it so the
      // model moves on, rather than waiting for the doom-loop to terminate it.
      const existing = ctx.context.list().find((i) => i.id === "active-plan")?.content;
      if (existing === content) {
        return {
          plan: args.plan,
          rendered: content,
          unchanged: true,
          note: "This plan is identical to the one you already recorded — do NOT re-submit an unchanged plan. Take the next concrete action now; if every step is completed, give your final summary instead of calling update_plan again."
        };
      }
      ctx.context.upsert("active-plan", { type: "plan", content, priority: 95, pinned: true });
      return { plan: args.plan, rendered: content };
    }
  );
}

function renderPlan(plan: Array<{ step: string; status: (typeof STATUSES)[number] }>, explanation?: string): string {
  const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
  const lines = plan.map((p) => `${mark[p.status]} ${p.step}`);
  return `Plan${explanation ? ` (${explanation})` : ""}:\n${lines.join("\n")}`;
}
