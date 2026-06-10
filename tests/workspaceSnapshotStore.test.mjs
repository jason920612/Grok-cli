import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceSnapshotStore } from "../dist/workspace/WorkspaceSnapshotStore.js";

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-snap-"));
  return root;
}

test("snapshot + restore recovers an overwritten file", () => {
  const root = makeWorkspace();
  const file = path.join(root, "a.ts");
  fs.writeFileSync(file, "original");
  const store = new WorkspaceSnapshotStore(root);

  const entry = store.snapshot(file, "a.ts", "overwrite", 1);
  fs.writeFileSync(file, "clobbered");
  assert.equal(fs.readFileSync(file, "utf8"), "clobbered");

  assert.ok(store.restore(entry.id, file));
  assert.equal(fs.readFileSync(file, "utf8"), "original");
});

test("snapshot + restore recovers a deleted file", () => {
  const root = makeWorkspace();
  const file = path.join(root, "gone.ts");
  fs.writeFileSync(file, "keep me");
  const store = new WorkspaceSnapshotStore(root);

  const entry = store.snapshot(file, "gone.ts", "delete", 1);
  fs.rmSync(file);
  assert.ok(!fs.existsSync(file));

  assert.ok(store.restore(entry.id, file));
  assert.equal(fs.readFileSync(file, "utf8"), "keep me");
});

test("create snapshot is a tombstone; restore removes the created file", () => {
  const root = makeWorkspace();
  const file = path.join(root, "new.ts");
  const store = new WorkspaceSnapshotStore(root);

  const entry = store.snapshot(file, "new.ts", "create", 1);
  assert.equal(entry.sha, undefined);
  fs.writeFileSync(file, "created content");

  assert.ok(store.restore(entry.id, file));
  assert.ok(!fs.existsSync(file), "restoring a create tombstone removes the file");
});

test("identical content is deduped to a single blob", () => {
  const root = makeWorkspace();
  const f1 = path.join(root, "x.ts");
  const f2 = path.join(root, "y.ts");
  fs.writeFileSync(f1, "same");
  fs.writeFileSync(f2, "same");
  const store = new WorkspaceSnapshotStore(root);

  store.snapshot(f1, "x.ts", "overwrite", 1);
  store.snapshot(f2, "y.ts", "overwrite", 1);

  const blobs = fs.readdirSync(path.join(root, ".grok-code", ".trash", "blobs"));
  assert.equal(blobs.length, 1, "same content stored once");
});

test("retention prunes snapshots older than the round window", () => {
  const root = makeWorkspace();
  const file = path.join(root, "a.ts");
  const store = new WorkspaceSnapshotStore(root, { snapshot: { retainSteps: 3, maxTotalBytes: 1e9, maxEntries: 1000 } });

  fs.writeFileSync(file, "v0");
  const old = store.snapshot(file, "a.ts", "overwrite", 1);
  // advance well past the window
  fs.writeFileSync(file, "v5");
  store.snapshot(file, "a.ts", "overwrite", 10);

  const ids = store.list().map((e) => e.id);
  assert.ok(!ids.includes(old.id), "round-1 snapshot pruned at round 10 with window 3");
});

test("orphan blobs are garbage-collected when their entries are pruned", () => {
  const root = makeWorkspace();
  const file = path.join(root, "a.ts");
  const store = new WorkspaceSnapshotStore(root, { snapshot: { retainSteps: 1, maxTotalBytes: 1e9, maxEntries: 1000 } });

  fs.writeFileSync(file, "unique-old-content");
  store.snapshot(file, "a.ts", "overwrite", 1);
  fs.writeFileSync(file, "unique-new-content");
  store.snapshot(file, "a.ts", "overwrite", 5);

  const blobs = fs.readdirSync(path.join(root, ".grok-code", ".trash", "blobs"));
  assert.equal(blobs.length, 1, "pruned entry's orphan blob removed");
});

test("restore returns false for unknown id", () => {
  const root = makeWorkspace();
  const store = new WorkspaceSnapshotStore(root);
  assert.equal(store.restore("nope", path.join(root, "a.ts")), false);
});
