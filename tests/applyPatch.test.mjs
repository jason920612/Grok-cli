import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyPatchTool } from "../dist/tools/definitions/applyPatch.js";
import { listFilesTool } from "../dist/tools/definitions/listFiles.js";
import { runShellTool } from "../dist/tools/definitions/runShell.js";
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

test("run_shell allows newly generated output directories for the session", async () => {
  const root = makeWorkspace();
  const tool = runShellTool(new ToolSkillRegistry(root));
  const ctx = makeContext(root);

  await tool.execute({
    command: "node -e \"const fs=require('fs');fs.mkdirSync('coverage',{recursive:true});fs.writeFileSync('coverage/report.txt','ok')\"",
    reason: "create a generated test report"
  }, ctx);

  assert.equal(path.basename(ctx.sandbox.assertReadableFile("coverage/report.txt")), "report.txt");
});

test("run_shell allows newly generated nested output directories for the session", async () => {
  const root = makeWorkspace();
  const tool = runShellTool(new ToolSkillRegistry(root));
  const ctx = makeContext(root);

  await tool.execute({
    command: "node -e \"const fs=require('fs');fs.mkdirSync('packages/api/dist',{recursive:true});fs.writeFileSync('packages/api/dist/report.txt','ok')\"",
    reason: "create a nested generated report"
  }, ctx);

  assert.equal(path.basename(ctx.sandbox.assertReadableFile("packages/api/dist/report.txt")), "report.txt");
});

test("list_files shows generated outputs allowed for the current session", async () => {
  const root = makeWorkspace();
  const runShell = runShellTool(new ToolSkillRegistry(root));
  const listFiles = listFilesTool(new ToolSkillRegistry(root));
  const ctx = makeContext(root);

  await runShell.execute({
    command: "node -e \"const fs=require('fs');fs.mkdirSync('coverage',{recursive:true});fs.writeFileSync('coverage/report.txt','ok')\"",
    reason: "create a generated test report"
  }, ctx);

  const result = await listFiles.execute({ glob: "coverage/**" }, ctx);
  assert.deepEqual(result.files, ["coverage/report.txt"]);
});

test("list_files explains how to continue when results are truncated", async () => {
  const root = makeWorkspace();
  fs.mkdirSync(path.join(root, "src", "agent"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "context"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "agent", "AgentLoop.ts"), "export {}\n");
  fs.writeFileSync(path.join(root, "src", "context", "ContextManager.ts"), "export {}\n");
  fs.writeFileSync(path.join(root, "README.md"), "readme\n");
  const listFiles = listFilesTool(new ToolSkillRegistry(root));
  const ctx = makeContext(root);

  const result = await listFiles.execute({ maxResults: 1 }, ctx);

  assert.equal(result.truncated, true);
  assert.match(result.note, /Results are truncated/);
  assert.match(result.note, /list_files with a subdirectory path/);
  assert.match(result.note, /src\/agent/);
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
