import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceTrustStore, describeTrustEntry } from "../dist/workspace/WorkspaceTrustStore.js";

test("exact trust applies only to the selected directory", () => {
  const { store, root, child } = makeStore();
  store.setTrust(root, "exact");

  assert.equal(store.getTrustFor(root)?.scope, "exact");
  assert.equal(store.getTrustFor(child), undefined);
});

test("descendant trust applies to subdirectories and records recent workspaces", () => {
  const { store, root, child } = makeStore();
  store.setTrust(root, "descendants");

  assert.equal(store.getTrustFor(child)?.scope, "descendants");
  assert.deepEqual(store.recentWorkspaces(1), [fs.realpathSync(root)]);
});

test("custom descendant trust uses the selected base directory", () => {
  const { store, base, root, sibling } = makeStore();
  const entry = store.setTrust(root, "custom-descendants", base);

  assert.equal(store.getTrustFor(sibling)?.scope, "custom-descendants");
  assert.equal(store.getTrustFor(sibling)?.baseDirectory, fs.realpathSync(base));
  assert.equal(describeTrustEntry(entry), `Trust ${fs.realpathSync(base)} and all subdirectories`);
});

test("clearing trust removes the remembered entry for that workspace", () => {
  const { store, root } = makeStore();
  store.setTrust(root, "exact");

  assert.equal(store.clearTrust(root), true);
  assert.equal(store.getTrustFor(root), undefined);
  assert.equal(store.clearTrust(root), false);
});

function makeStore() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "grok-trust-"));
  const root = path.join(base, "project");
  const child = path.join(root, "child");
  const sibling = path.join(base, "sibling");
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(sibling);
  const store = new WorkspaceTrustStore(path.join(base, "trust.json"));
  return { store, base, root, child, sibling };
}
