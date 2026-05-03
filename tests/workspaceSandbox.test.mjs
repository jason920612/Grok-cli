import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceSandbox, isDeniedPath } from "../dist/workspace/WorkspaceSandbox.js";

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
  assert.throws(() => sandbox.assertReadableFile("safe-link.txt"), /sensitive-path-denied/);
});

test(".env.example is readable while real env files stay denied", () => {
  const { root } = makeWorkspace();
  fs.mkdirSync(path.join(root, "sub"));
  fs.writeFileSync(path.join(root, ".env"), "SECRET=value");
  fs.writeFileSync(path.join(root, ".env.local"), "SECRET=value");
  fs.writeFileSync(path.join(root, ".env.example"), "XAI_API_KEY=");
  fs.writeFileSync(path.join(root, "sub", ".env"), "SECRET=value");
  fs.writeFileSync(path.join(root, "sub", ".env.local"), "SECRET=value");
  fs.writeFileSync(path.join(root, "sub", ".env.example"), "XAI_API_KEY=");

  const sandbox = new WorkspaceSandbox(root);
  assert.equal(isDeniedPath(".env.example"), false);
  assert.equal(isDeniedPath("sub/.env.example"), false);
  assert.equal(isDeniedPath("sub/.env"), true);
  assert.equal(isDeniedPath("secrets/token.txt"), true);
  assert.equal(isDeniedPath("certs/private.pem"), true);
  assert.equal(path.basename(sandbox.assertReadableFile(".env.example")), ".env.example");
  assert.equal(path.basename(sandbox.assertReadableFile("sub/.env.example")), ".env.example");
  assert.throws(() => sandbox.assertReadableFile(".env"), /sensitive-path-denied/);
  assert.throws(() => sandbox.assertReadableFile(".env.local"), /sensitive-path-denied/);
  assert.throws(() => sandbox.assertReadableFile("sub/.env"), /sensitive-path-denied/);
  assert.throws(() => sandbox.assertReadableFile("sub/.env.local"), /sensitive-path-denied/);
});

test("generated outputs are denied by default with actionable errors", () => {
  const { root } = makeWorkspace();
  fs.mkdirSync(path.join(root, "coverage"));
  fs.writeFileSync(path.join(root, "coverage", "index.html"), "report");

  const sandbox = new WorkspaceSandbox(root);
  assert.equal(isDeniedPath("coverage/index.html"), true);
  assert.throws(
    () => sandbox.assertReadableFile("coverage/index.html"),
    /Blocked by sandbox rule: generated-output-read-denied[\s\S]*Suggested profile: test/
  );
});

test("sandbox profiles allow generated output reads while keeping secrets denied", () => {
  const { root } = makeWorkspace();
  fs.mkdirSync(path.join(root, "coverage"));
  fs.writeFileSync(path.join(root, "coverage", "index.html"), "report");
  fs.writeFileSync(path.join(root, "coverage", ".env"), "SECRET=value");

  const sandbox = new WorkspaceSandbox(root, "test");
  assert.equal(isDeniedPath("coverage/index.html", "test"), false);
  assert.equal(path.basename(sandbox.assertReadableFile("coverage/index.html")), "index.html");
  assert.throws(() => sandbox.assertReadableFile("coverage/.env"), /sensitive-path-denied/);
});

test("generated output directories can be allowed for the current session", () => {
  const { root } = makeWorkspace();
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "summary.txt"), "ok");

  const sandbox = new WorkspaceSandbox(root);
  assert.throws(() => sandbox.assertReadableFile("dist/summary.txt"), /generated-output-read-denied/);
  sandbox.allowGeneratedOutputPath("dist");
  assert.equal(path.basename(sandbox.assertReadableFile("dist/summary.txt")), "summary.txt");
});

test("trusted workspaces allow local generated output operations", () => {
  const { root } = makeWorkspace();
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "summary.txt"), "ok");
  fs.writeFileSync(path.join(root, "dist", ".env"), "SECRET=value");

  const sandbox = new WorkspaceSandbox(root, "default", true);
  assert.equal(isDeniedPath("dist/summary.txt", "default", "read", true), false);
  assert.equal(path.basename(sandbox.assertReadableFile("dist/summary.txt")), "summary.txt");
  assert.equal(sandbox.assertWritablePatchPath("dist/summary.txt"), path.join(root, "dist", "summary.txt"));
  assert.throws(() => sandbox.assertReadableFile("dist/.env"), /sensitive-path-denied/);
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
