import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceSandbox } from "../dist/workspace/WorkspaceSandbox.js";

test("readable files must resolve inside the workspace", (t) => {
  const { root, outside } = makeWorkspace();
  const outsideFile = path.join(outside, "secret.txt");
  fs.writeFileSync(outsideFile, "secret");

  const linkPath = path.join(root, "secret-link.txt");
  if (!trySymlink(outsideFile, linkPath, "file")) {
    t.skip("file symlinks are not available in this environment");
    return;
  }

  const sandbox = new WorkspaceSandbox(root);
  assert.throws(() => sandbox.assertReadableFile("secret-link.txt"), /escapes workspace/);
});

test("readable symlinks cannot bypass denied workspace paths", (t) => {
  const { root } = makeWorkspace();
  const envPath = path.join(root, ".env");
  fs.writeFileSync(envPath, "SECRET=value");

  const linkPath = path.join(root, "safe-link.txt");
  if (!trySymlink(envPath, linkPath, "file")) {
    t.skip("file symlinks are not available in this environment");
    return;
  }

  const sandbox = new WorkspaceSandbox(root);
  assert.throws(() => sandbox.assertReadableFile("safe-link.txt"), /Path is denied by sandbox: \.env/);
});

test("writable patch paths reject symlink path components", (t) => {
  const { root, outside } = makeWorkspace();
  const linkPath = path.join(root, "linked-dir");
  if (!trySymlink(outside, linkPath, "junction")) {
    t.skip("directory symlinks are not available in this environment");
    return;
  }

  const sandbox = new WorkspaceSandbox(root);
  assert.throws(() => sandbox.assertWritablePatchPath("linked-dir/new-file.txt"), /symlink denied|escapes workspace/);
});

test("writable patch paths allow new directories inside the workspace", () => {
  const { root } = makeWorkspace();
  const sandbox = new WorkspaceSandbox(root);
  const abs = sandbox.assertWritablePatchPath("new-dir/nested/file.ts");
  assert.equal(abs, path.join(root, "new-dir", "nested", "file.ts"));
});

function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-sandbox-"));
  const root = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  return { root, outside };
}

function trySymlink(target, linkPath, type) {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch {
    return false;
  }
}
