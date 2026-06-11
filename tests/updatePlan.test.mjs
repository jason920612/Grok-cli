import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updatePlanTool } from "../dist/tools/definitions/updatePlan.js";
import { ContextManager } from "../dist/context/ContextManager.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";
import { TOOL_EFFECTS } from "../dist/tools/toolEffects.js";

test("update_plan pins a rendered checklist in context", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-plan-"));
  const tool = updatePlanTool(new ToolSkillRegistry(root));
  const ctx = { context: new ContextManager() };
  const res = await tool.execute(
    { plan: [
      { step: "design", status: "completed" },
      { step: "build", status: "in_progress" },
      { step: "test", status: "pending" }
    ], explanation: "v1" },
    ctx
  );
  assert.equal(res.plan.length, 3);
  const plan = ctx.context.list().find((i) => i.type === "plan");
  assert.ok(plan, "plan item pinned in context");
  assert.ok(plan.pinned, "plan is pinned (never evicted)");
  assert.match(plan.content, /\[x\] design/);
  assert.match(plan.content, /\[~\] build/);
  assert.match(plan.content, /\[ \] test/);
});

test("update_plan is a non-mutating tool (so the orchestrator keeps it)", () => {
  const e = TOOL_EFFECTS.update_plan;
  assert.ok(e && !e.modifiesWorkspace && !e.isShell, "update_plan must not be stripped from the read-only orchestrator");
});
