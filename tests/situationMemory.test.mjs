import test from "node:test";
import assert from "node:assert/strict";
import { SituationMemory } from "../dist/agent/SituationMemory.js";

test("recordEvidence sets confidence:verified when ok=true", () => {
  const mem = new SituationMemory();
  mem.recordEvidence("read_file_range", { path: "a.ts", start: 1, end: 10 }, "content here", true, 1);
  const evidence = mem.getEvidence();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].confidence, "verified");
  assert.equal(evidence[0].ok, true);
});

test("recordEvidence sets confidence:uncertain when ok=false", () => {
  const mem = new SituationMemory();
  mem.recordEvidence("run_shell", { command: "npm test" }, "ERROR: exit 1", false, 1);
  const evidence = mem.getEvidence();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].confidence, "uncertain");
  assert.equal(evidence[0].ok, false);
});

test("snapshot labels verified evidence with [VERIFIED]", () => {
  const mem = new SituationMemory();
  mem.recordEvidence("run_shell", { command: "echo hi" }, "hi", true, 1);
  const snap = mem.snapshot();
  assert.ok(snap.includes("[VERIFIED]"), `Expected [VERIFIED] in snapshot:\n${snap}`);
});

test("snapshot labels failed evidence with [UNCERTAIN]", () => {
  const mem = new SituationMemory();
  mem.recordEvidence("run_shell", { command: "fail" }, "ERROR: not found", false, 1);
  const snap = mem.snapshot();
  assert.ok(snap.includes("[UNCERTAIN]"), `Expected [UNCERTAIN] in snapshot:\n${snap}`);
});

test("snapshot separates verified from failed observations", () => {
  const mem = new SituationMemory();
  mem.recordEvidence("read_file_range", { path: "a.ts", start: 1, end: 5 }, "code", true, 1);
  mem.recordEvidence("run_shell", { command: "npm test" }, "ERROR: exit 1", false, 2);
  const snap = mem.snapshot();
  assert.ok(snap.includes("Verified runtime observations"), `Missing verified section:\n${snap}`);
  assert.ok(snap.includes("Failed/uncertain observations"), `Missing uncertain section:\n${snap}`);
});

test("hasRecentlyFailed blocks same tool+args", () => {
  const mem = new SituationMemory();
  mem.recordFailure("run_shell", { command: "npm test" }, "exit 1", 1);
  const record = mem.hasRecentlyFailed("run_shell", { command: "npm test" });
  assert.ok(record, "Expected failure record to be found");
  assert.equal(record.tool, "run_shell");
  assert.equal(record.attempts, 1);
});

test("hasRecentlyFailed normalizes argument key order (stable key)", () => {
  const mem = new SituationMemory();
  // Record failure with keys in one order
  mem.recordFailure("run_shell", { reason: "test", command: "npm test" }, "exit 1", 1);
  // Look up with keys in different order — should still match
  const record = mem.hasRecentlyFailed("run_shell", { command: "npm test", reason: "test" });
  assert.ok(record, "Expected failure record regardless of key order");
});

test("hasRecentlyFailed returns undefined for different args", () => {
  const mem = new SituationMemory();
  mem.recordFailure("run_shell", { command: "npm test" }, "exit 1", 1);
  const record = mem.hasRecentlyFailed("run_shell", { command: "npm build" });
  assert.equal(record, undefined);
});

test("pending verifications are resolved by claim string", () => {
  const mem = new SituationMemory();
  mem.addPendingVerification("tests pass", "run_shell with exit 0", 1);
  assert.equal(mem.getUnresolvedVerifications().length, 1);
  mem.resolvePendingVerifications(["tests pass"]);
  assert.equal(mem.getUnresolvedVerifications().length, 0);
});

test("duplicate pending verifications are not added twice", () => {
  const mem = new SituationMemory();
  mem.addPendingVerification("file exists", "read_file_range", 1);
  mem.addPendingVerification("file exists", "read_file_range", 2);
  assert.equal(mem.getUnresolvedVerifications().length, 1);
});

test("audit failure counter increments and is reflected in snapshot", () => {
  const mem = new SituationMemory();
  assert.equal(mem.hasAuditFailures(), false);
  mem.recordAuditFailure();
  assert.equal(mem.hasAuditFailures(), true);
  const snap = mem.snapshot();
  assert.ok(snap.includes("intermediate claim audit"), `Expected audit warning:\n${snap.slice(0, 400)}`);
});

test("evidence provenance: read_file_range records filePath and lineRange", () => {
  const mem = new SituationMemory();
  mem.recordEvidence("read_file_range", { path: "src/foo.ts", start: 10, end: 20 }, "code", true, 1);
  const ev = mem.getEvidence()[0];
  assert.equal(ev.filePath, "src/foo.ts");
  assert.deepEqual(ev.lineRange, { start: 10, end: 20 });
});

test("evidence provenance: run_shell records exitCode", () => {
  const mem = new SituationMemory();
  mem.recordEvidence("run_shell", { command: "npm test" }, "exit_code: 0", true, 1);
  const ev = mem.getEvidence()[0];
  assert.equal(ev.exitCode, 0);
});
