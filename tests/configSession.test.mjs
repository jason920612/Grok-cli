import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config/loadConfig.js";
import { SessionStore, migrate } from "../dist/session/SessionStore.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-cfg-"));
}

test("loadConfig applies defaults and honors overrides", () => {
  const cwd = tmpDir();
  const config = loadConfig(cwd, { maxSteps: 7, enableVerifier: true });
  assert.equal(config.model, "grok-build-0.1");
  assert.equal(config.approval, "on-request");
  assert.equal(config.maxSteps, 7);
  assert.equal(config.enableVerifier, true);
  assert.equal(config.enableLlmSummary, false);
  assert.equal(config.workspaceRoot, cwd);
});

test("loadConfig rejects invalid values with a clear error", () => {
  const cwd = tmpDir();
  assert.throws(() => loadConfig(cwd, { approval: "bogus" }), /Invalid configuration/);
  assert.throws(() => loadConfig(cwd, { maxSteps: -1 }), /Invalid configuration/);
});

test("invalid project config file surfaces an error rather than silent fallback", () => {
  const cwd = tmpDir();
  fs.mkdirSync(path.join(cwd, ".grok-code"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".grok-code", "config.json"), JSON.stringify({ sandboxProfile: "nope" }));
  assert.throws(() => loadConfig(cwd), /Invalid configuration/);
});

test("session migrate fills version and missing arrays on old sessions", () => {
  const old = { id: "abc", model: "grok-4.3", approval: "auto-local" };
  const migrated = migrate(old);
  assert.equal(migrated.version, 1);
  assert.deepEqual(migrated.contextItems, []);
  assert.deepEqual(migrated.toolCalls, []);
  assert.equal(migrated.id, "abc");
});

test("SessionStore round-trips a session with a version", () => {
  const cwd = tmpDir();
  const store = new SessionStore(cwd);
  const session = store.create("grok-4.3", "auto-local");
  assert.equal(session.version, 1);
  session.taskSummary = "do x";
  store.save(session);
  const loaded = store.load(session.id);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.taskSummary, "do x");
});

test("SessionStore.load migrates a legacy session file without version", () => {
  const cwd = tmpDir();
  const store = new SessionStore(cwd);
  const dir = path.join(cwd, ".grok-code", "sessions");
  fs.writeFileSync(path.join(dir, "legacy.json"), JSON.stringify({ id: "legacy", model: "grok-4.3", approval: "never" }));
  const loaded = store.load("legacy");
  assert.equal(loaded.version, 1);
  assert.equal(loaded.id, "legacy");
  assert.deepEqual(loaded.backgroundProcesses, []);
});
