import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sopViolation, harshEnforcementEnabled } from "../dist/agent/enforcement.js";

test("firm mode (default) returns the correction unchanged", () => {
  assert.equal(harshEnforcementEnabled(), false);
  assert.equal(sopViolation("Read the lines before editing."), "Read the lines before editing.");
});

test("harsh mode (GROK_HARSH=1) wraps with profanity but preserves the instruction", () => {
  const out = execFileSync(
    process.execPath,
    ["-e", "import('./dist/agent/enforcement.js').then(m => process.stdout.write(m.sopViolation('Read the lines before editing.')))"],
    { env: { ...process.env, GROK_HARSH: "1" }, encoding: "utf8" }
  );
  assert.match(out, /Read the lines before editing\./, "substance preserved");
  assert.notEqual(out, "Read the lines before editing.", "wrapped");
  assert.match(out, /process/i, "frames it as process discipline");
});
