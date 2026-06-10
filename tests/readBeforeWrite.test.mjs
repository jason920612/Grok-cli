import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatchTool } from "../dist/tools/definitions/applyPatch.js";
import { readFileRangeTool } from "../dist/tools/definitions/readFileRange.js";
import { ApprovalPolicy } from "../dist/approval/ApprovalPolicy.js";
import { ContextManager } from "../dist/context/ContextManager.js";
import { ContextEngine } from "../dist/context/ContextEngine.js";
import { WorkspaceSandbox } from "../dist/workspace/WorkspaceSandbox.js";
import { WorkspaceSnapshotStore } from "../dist/workspace/WorkspaceSnapshotStore.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-rbw-"));
}

function makeContext(root) {
  return {
    workspaceRoot: root,
    sandbox: new WorkspaceSandbox(root),
    approval: new ApprovalPolicy("auto-local"),
    background: {},
    context: new ContextManager(),
    engine: new ContextEngine(),
    snapshots: new WorkspaceSnapshotStore(root),
    round: (() => { let r = 0; return () => ++r; })()
  };
}

const modifyPatch = (file) => [
  `--- a/${file}`,
  `+++ b/${file}`,
  "@@ -1,2 +1,2 @@",
  "-line one",
  "+LINE ONE",
  " line two",
  ""
].join("\n");

test("modify is rejected until the edited region has been read", async (t) => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "a.ts"), "line one\nline two\n");
  const ctx = makeContext(root);
  const patch = applyPatchTool(new ToolSkillRegistry(root));

  await assert.rejects(
    () => patch.execute({ patch: modifyPatch("a.ts"), reason: "edit" }, ctx),
    /have not been read/
  );

  // read the region, then the same patch applies
  const read = readFileRangeTool(new ToolSkillRegistry(root));
  await read.execute({ path: "a.ts", startLine: 1, endLine: 2 }, ctx);
  const result = await patch.execute({ patch: modifyPatch("a.ts"), reason: "edit" }, ctx);
  assert.deepEqual(result.modifiedFiles, ["a.ts"]);
  assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "LINE ONE\nline two\n");
});

test("a write invalidates reads so a second blind edit is blocked", async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "a.ts"), "line one\nline two\n");
  const ctx = makeContext(root);
  const patch = applyPatchTool(new ToolSkillRegistry(root));
  const read = readFileRangeTool(new ToolSkillRegistry(root));

  await read.execute({ path: "a.ts", startLine: 1, endLine: 2 }, ctx);
  await patch.execute({ patch: modifyPatch("a.ts"), reason: "edit" }, ctx);

  // reads invalidated by the write — a second edit without re-reading is blocked
  const second = [
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-LINE ONE",
    "+line ONE",
    " line two",
    ""
  ].join("\n");
  await assert.rejects(() => patch.execute({ patch: second, reason: "edit again" }, ctx), /have not been read/);
});

test("delete requires existence evidence but not content reads", async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "gone.ts"), "bye\n");
  const ctx = makeContext(root);
  const patch = applyPatchTool(new ToolSkillRegistry(root));
  const deletePatch = ["--- a/gone.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye", ""].join("\n");

  await assert.rejects(() => patch.execute({ patch: deletePatch, reason: "rm" }, ctx), /without prior evidence it exists/);

  ctx.engine.recordExistence(["gone.ts"]);
  const result = await patch.execute({ patch: deletePatch, reason: "rm" }, ctx);
  assert.deepEqual(result.deletedFiles, ["gone.ts"]);
});

test("destructive ops are snapshotted and can be restored", async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "a.ts"), "line one\nline two\n");
  const ctx = makeContext(root);
  const patch = applyPatchTool(new ToolSkillRegistry(root));
  const read = readFileRangeTool(new ToolSkillRegistry(root));

  await read.execute({ path: "a.ts", startLine: 1, endLine: 2 }, ctx);
  await patch.execute({ patch: modifyPatch("a.ts"), reason: "edit" }, ctx);
  assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "LINE ONE\nline two\n");

  const snap = ctx.snapshots.list()[0];
  assert.ok(snap, "a snapshot was recorded");
  assert.ok(ctx.snapshots.restore(snap.id, path.join(root, "a.ts")));
  assert.equal(fs.readFileSync(path.join(root, "a.ts"), "utf8"), "line one\nline two\n");
});

test("create needs no prior read", async () => {
  const root = makeWorkspace();
  const ctx = makeContext(root);
  const patch = applyPatchTool(new ToolSkillRegistry(root));
  const createPatch = ["--- /dev/null", "+++ b/new.ts", "@@ -0,0 +1 @@", "+hi", ""].join("\n");
  const result = await patch.execute({ patch: createPatch, reason: "new" }, ctx);
  assert.deepEqual(result.modifiedFiles, ["new.ts"]);
});
