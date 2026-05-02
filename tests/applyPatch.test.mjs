import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatchTool } from "../dist/tools/definitions/applyPatch.js";
import { ApprovalPolicy } from "../dist/approval/ApprovalPolicy.js";
import { ContextManager } from "../dist/context/ContextManager.js";
import { WorkspaceSandbox } from "../dist/workspace/WorkspaceSandbox.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";

test("apply_patch creates files inside new directories", async () => {
  const root = makeWorkspace();
  const tool = applyPatchTool(new ToolSkillRegistry(root));
  const patch = [
    "--- /dev/null",
    "+++ b/new-dir/file.txt",
    "@@ -0,0 +1 @@",
    "+hello",
    ""
  ].join("\n");

  const result = await tool.execute({ patch, reason: "create nested file" }, makeContext(root));
  assert.deepEqual(result.modifiedFiles, ["new-dir/file.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "new-dir", "file.txt"), "utf8"), "hello\n");
});

test("apply_patch removes files for delete patches", async () => {
  const root = makeWorkspace();
  const target = path.join(root, "delete-me.txt");
  fs.writeFileSync(target, "hello\n");
  const tool = applyPatchTool(new ToolSkillRegistry(root));
  const patch = [
    "--- a/delete-me.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-hello",
    ""
  ].join("\n");

  const result = await tool.execute({ patch, reason: "delete file" }, makeContext(root));
  assert.deepEqual(result.modifiedFiles, []);
  assert.deepEqual(result.deletedFiles, ["delete-me.txt"]);
  assert.equal(fs.existsSync(target), false);
});

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-apply-patch-"));
}

function makeContext(root) {
  return {
    workspaceRoot: root,
    sandbox: new WorkspaceSandbox(root),
    approval: new ApprovalPolicy("auto-local"),
    background: {},
    context: new ContextManager()
  };
}
