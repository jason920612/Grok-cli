import test from "node:test";
import assert from "node:assert/strict";
import { ContextEngine } from "../dist/context/ContextEngine.js";

function fileItem(path, content, priority = 60) {
  return { type: "file_range", content, provenance: { kind: "file", path, startLine: 1, endLine: 10 }, priority };
}

test("select is deterministic and side-effect-free", () => {
  const engine = new ContextEngine();
  engine.add({ type: "user_task", content: "do x", provenance: { kind: "user" }, priority: 100, pinned: true });
  engine.add(fileItem("a.ts", "aaa", 50));
  engine.add(fileItem("b.ts", "bbb", 70));

  const first = engine.select().map((i) => i.id);
  const second = engine.select().map((i) => i.id);
  assert.deepEqual(first, second, "repeated select returns identical order");
  // ordered by seq (insertion), pinned included
  assert.deepEqual(first, engine.list().map((i) => i.id));
});

test("select keeps pinned items even when over budget, drops low-priority first", () => {
  const engine = new ContextEngine();
  const pinned = engine.add({ type: "user_task", content: "T".repeat(40), provenance: { kind: "user" }, priority: 100, pinned: true });
  const low = engine.add(fileItem("low.ts", "L".repeat(4000), 10));
  const high = engine.add(fileItem("high.ts", "H".repeat(40), 90));

  const selected = engine.select(20).map((i) => i.id); // tiny budget
  assert.ok(selected.includes(pinned.id), "pinned always selected");
  assert.ok(selected.includes(high.id), "high priority fits");
  assert.ok(!selected.includes(low.id), "low priority dropped under budget");
});

test("token calibration moves chars-per-token toward observed usage", () => {
  const engine = new ContextEngine();
  const before = engine.charsPerTokenRatio;
  assert.equal(before, 4);
  // observed ratio 2 chars/token (e.g. dense code)
  engine.calibrate(1000, 2000);
  const after = engine.charsPerTokenRatio;
  assert.ok(after < before && after > 2, `EMA between 2 and 4, got ${after}`);
  assert.equal(engine.estimate("12345678"), Math.ceil(8 / after));
});

test("calibrate ignores degenerate inputs", () => {
  const engine = new ContextEngine();
  engine.calibrate(0, 1000);
  engine.calibrate(100, 0);
  engine.calibrate(NaN, 10);
  assert.equal(engine.charsPerTokenRatio, 4);
});

test("uncoveredForWrite reflects read coverage and staleness", () => {
  const engine = new ContextEngine();
  // nothing read yet → whole range uncovered
  assert.deepEqual(engine.uncoveredForWrite("src/x.ts", [{ startLine: 10, endLine: 20 }]), [
    { startLine: 10, endLine: 20 }
  ]);

  engine.recordRead("src/x.ts", 5, 25, "content");
  assert.deepEqual(engine.uncoveredForWrite("src/x.ts", [{ startLine: 10, endLine: 20 }]), [], "fully covered");

  // partial coverage leaves the uncovered remainder
  assert.deepEqual(engine.uncoveredForWrite("src/x.ts", [{ startLine: 1, endLine: 30 }]), [
    { startLine: 1, endLine: 4 },
    { startLine: 26, endLine: 30 }
  ]);

  // a write invalidates reads → range uncovered again
  engine.invalidateReads("src/x.ts");
  assert.deepEqual(engine.uncoveredForWrite("src/x.ts", [{ startLine: 10, endLine: 20 }]), [
    { startLine: 10, endLine: 20 }
  ]);
});

test("path normalization makes coverage and existence backslash-insensitive", () => {
  const engine = new ContextEngine();
  engine.recordRead("src\\x.ts", 1, 50, "c");
  assert.deepEqual(engine.uncoveredForWrite("src/x.ts", [{ startLine: 10, endLine: 20 }]), []);
  assert.equal(engine.hasFileExistenceEvidence("./src/x.ts"), true);
});

test("existence evidence backs delete preconditions without reading content", () => {
  const engine = new ContextEngine();
  assert.equal(engine.hasFileExistenceEvidence("dir/gone.ts"), false);
  engine.recordExistence(["dir/gone.ts", "dir/other.ts"]);
  assert.equal(engine.hasFileExistenceEvidence("dir/gone.ts"), true);
});

test("re-fetchable items degrade to a pointer instead of being deleted", () => {
  const engine = new ContextEngine();
  // pin a huge item so total stays above the degrade threshold via re-fetchables
  const big = "X".repeat(400_000); // ~100k tokens at 4 cpt, over the degrade threshold
  const refetchable = engine.add(fileItem("big.ts", big, 50));
  const userFact = engine.add({ type: "task_summary", content: "Y".repeat(400_000), provenance: { kind: "model", confidence: "inferred" }, priority: 40 });

  engine.nextStep(); // triggers compact at step boundary

  const after = engine.list().find((i) => i.id === refetchable.id);
  assert.equal(after.degraded, true, "re-fetchable file item degraded");
  assert.match(after.content, /re-read with read_file_range/);

  // non-re-fetchable model inference is NOT degraded (must wait for summary, §6.3)
  const modelItem = engine.list().find((i) => i.id === userFact.id);
  assert.equal(modelItem.degraded, false);
});

test("pinned items are never degraded", () => {
  const engine = new ContextEngine();
  const pinned = engine.add({ type: "repo_summary", content: "R".repeat(600_000), provenance: { kind: "file", path: "REPO" }, priority: 100, pinned: true });
  engine.nextStep();
  const after = engine.list().find((i) => i.id === pinned.id);
  assert.equal(after.degraded, false);
});

test("expired non-pinned items are pruned at step boundary", () => {
  const engine = new ContextEngine();
  const item = engine.add({ ...fileItem("tmp.ts", "x"), expiresAfterSteps: 2 });
  engine.nextStep(); // step 1
  engine.nextStep(); // step 2
  assert.ok(engine.list().some((i) => i.id === item.id), "still present within ttl");
  engine.nextStep(); // step 3 > createdStep(0)+2
  assert.ok(!engine.list().some((i) => i.id === item.id), "pruned after ttl");
});
