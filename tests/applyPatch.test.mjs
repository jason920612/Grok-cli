import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applyPatchTool } from "../dist/tools/definitions/applyPatch.js";
import { listFilesTool } from "../dist/tools/definitions/listFiles.js";
import { runPythonTool } from "../dist/tools/definitions/runPython.js";
import { ApprovalPolicy } from "../dist/approval/ApprovalPolicy.js";
import { ContextManager } from "../dist/context/ContextManager.js";
import { WorkspaceSandbox } from "../dist/workspace/WorkspaceSandbox.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";

test("apply_patch creates files inside new directories", async () => {
  const root = makeWorkspace();
  const tool = applyPatchTool(new ToolSkillRegistry(root));
  const patch = ["*** Begin Patch", "*** Add File: new-dir/file.txt", "+hello", "*** End Patch"].join("\n");

  const result = await tool.execute({ patch, reason: "create nested file" }, makeContext(root));
  assert.deepEqual(result.modifiedFiles, ["new-dir/file.txt"]);
  assert.equal(fs.readFileSync(path.join(root, "new-dir", "file.txt"), "utf8"), "hello\n");
});

test("apply_patch removes files for delete patches", async () => {
  const root = makeWorkspace();
  const target = path.join(root, "delete-me.txt");
  fs.writeFileSync(target, "hello\n");
  const tool = applyPatchTool(new ToolSkillRegistry(root));
  const patch = ["*** Begin Patch", "*** Delete File: delete-me.txt", "*** End Patch"].join("\n");

  const result = await tool.execute({ patch, reason: "delete file" }, makeContext(root));
  assert.deepEqual(result.modifiedFiles, []);
  assert.deepEqual(result.deletedFiles, ["delete-me.txt"]);
  assert.equal(fs.existsSync(target), false);
});

const PY_AVAILABLE = (() => {
  try {
    execFileSync(process.platform === "win32" ? "python" : "python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("run_python allows newly generated output directories for the session", async (t) => {
  if (!PY_AVAILABLE) return t.skip("python not available");
  const root = makeWorkspace();
  const tool = runPythonTool(new ToolSkillRegistry(root));
  const ctx = makeContext(root);

  await tool.execute({
    code: "import os\nos.makedirs('coverage', exist_ok=True)\nopen(os.path.join('coverage','report.txt'),'w').write('ok')",
    reason: "create a generated test report"
  }, ctx);

  assert.equal(path.basename(ctx.sandbox.assertReadableFile("coverage/report.txt")), "report.txt");
});

test("run_python allows newly generated nested output directories for the session", async (t) => {
  if (!PY_AVAILABLE) return t.skip("python not available");
  const root = makeWorkspace();
  const tool = runPythonTool(new ToolSkillRegistry(root));
  const ctx = makeContext(root);

  await tool.execute({
    code: "import os\nos.makedirs(os.path.join('packages','api','dist'), exist_ok=True)\nopen(os.path.join('packages','api','dist','report.txt'),'w').write('ok')",
    reason: "create a nested generated report"
  }, ctx);

  assert.equal(path.basename(ctx.sandbox.assertReadableFile("packages/api/dist/report.txt")), "report.txt");
});

test("list_files shows generated outputs allowed for the current session", async (t) => {
  if (!PY_AVAILABLE) return t.skip("python not available");
  const root = makeWorkspace();
  const runPython = runPythonTool(new ToolSkillRegistry(root));
  const listFiles = listFilesTool(new ToolSkillRegistry(root));
  const ctx = makeContext(root);

  await runPython.execute({
    code: "import os\nos.makedirs('coverage', exist_ok=True)\nopen(os.path.join('coverage','report.txt'),'w').write('ok')",
    reason: "create a generated test report"
  }, ctx);

  const result = await listFiles.execute({ glob: "coverage/**" }, ctx);
  assert.deepEqual(result.files, ["coverage/report.txt"]);
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
