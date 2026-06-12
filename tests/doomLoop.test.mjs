import test from "node:test";
import assert from "node:assert/strict";
import { DoomLoopDetector } from "../dist/agent/DoomLoopDetector.js";

test("warns once at the threshold, then terminates if it persists", () => {
  const d = new DoomLoopDetector(12, 3, 5);
  assert.equal(d.record("a").action, "ok");
  assert.equal(d.record("a").action, "ok");
  assert.equal(d.record("a").action, "warn", "3rd identical -> warn");
  assert.equal(d.record("a").action, "ok", "already warned, not re-warned");
  assert.equal(d.record("a").action, "terminate", "5th identical -> terminate");
});

test("distinct operations never trip the detector", () => {
  const d = new DoomLoopDetector();
  for (const s of ["a", "b", "c", "d", "e", "f", "g"]) assert.equal(d.record(s).action, "ok");
});

test("the corrective message tells the model to change approach", () => {
  const msg = DoomLoopDetector.corrective(3);
  assert.match(msg, /DOOM LOOP DETECTED/);
  assert.match(msg, /different approach/i);
  assert.match(msg, /terminated/i);
});
