import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileRangeTool } from "../dist/tools/definitions/readFileRange.js";
import { applyPatchTool } from "../dist/tools/definitions/applyPatch.js";
import { ApprovalPolicy } from "../dist/approval/ApprovalPolicy.js";
import { ContextManager } from "../dist/context/ContextManager.js";
import { ContextEngine } from "../dist/context/ContextEngine.js";
import { WorkspaceSandbox } from "../dist/workspace/WorkspaceSandbox.js";
import { WorkspaceSnapshotStore } from "../dist/workspace/WorkspaceSnapshotStore.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-dup-"));
}

function makeContext(root) {
  return {
    workspaceRoot: root,
    sandbox: new WorkspaceSandbox(root),
    approval: new ApprovalPolicy("auto-local"),
    background: {},
    context: new ContextManager(),
    engine: new ContextEngine(),
    snapshots: new WorkspaceSnapshotStore(root)
  };
}

test("re-reading the same unchanged range is refused (content not re-sent)", async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\nbravo\ncharlie\n");
  const ctx = makeContext(root);
  const read = readFileRangeTool(new ToolSkillRegistry(root));

  const first = await read.execute({ path: "a.txt", startLine: 1, endLine: 3 }, ctx);
  assert.equal(first.content, "alpha\nbravo\ncharlie");
  assert.ok(!first.unchanged, "first read returns content");

  const second = await read.execute({ path: "a.txt", startLine: 1, endLine: 3 }, ctx);
  assert.equal(second.unchanged, true, "duplicate read is flagged unchanged");
  assert.equal(second.content, undefined, "duplicate read does NOT re-send the body");
  assert.match(second.note, /Do NOT re-read/i);
});

test("the same range is re-sent after the file changes (read records invalidated by a write)", async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\nbravo\n");
  const ctx = makeContext(root);
  const read = readFileRangeTool(new ToolSkillRegistry(root));
  const patch = applyPatchTool(new ToolSkillRegistry(root));

  await read.execute({ path: "a.txt", startLine: 1, endLine: 2 }, ctx);
  // edit invalidates the read records for a.txt
  const p = ["*** Begin Patch", "*** Update File: a.txt", "@@", "-alpha", "+ALPHA", " bravo", "*** End Patch"].join("\n");
  await patch.execute({ patch: p, reason: "edit" }, ctx);

  const after = await read.execute({ path: "a.txt", startLine: 1, endLine: 2 }, ctx);
  assert.ok(!after.unchanged, "after a write the same range is re-sent");
  assert.equal(after.content, "ALPHA\nbravo");
});

test("a different range is never blocked by a prior read", async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "a.txt"), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const ctx = makeContext(root);
  const read = readFileRangeTool(new ToolSkillRegistry(root));

  await read.execute({ path: "a.txt", startLine: 1, endLine: 3 }, ctx);
  const other = await read.execute({ path: "a.txt", startLine: 4, endLine: 6 }, ctx);
  assert.ok(!other.unchanged, "a distinct range is allowed");
  assert.equal(other.content, "line 4\nline 5\nline 6");
});

test("re-reading the same range does not stack duplicate context items", async () => {
  const root = makeWorkspace();
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\nbravo\n");
  const ctx = makeContext(root);
  const read = readFileRangeTool(new ToolSkillRegistry(root));

  await read.execute({ path: "a.txt", startLine: 1, endLine: 2 }, ctx);
  await read.execute({ path: "a.txt", startLine: 1, endLine: 2 }, ctx);
  await read.execute({ path: "a.txt", startLine: 1, endLine: 2 }, ctx);

  const ranges = ctx.context.list().filter((i) => i.type === "file_range");
  assert.equal(ranges.length, 1, "only one file_range item is kept for the same range");
});
