import test from "node:test";
import assert from "node:assert/strict";
import { sopViolation } from "../dist/agent/enforcement.js";

test("SOP-violation corrections are always wrapped in the harsh reprimand", () => {
  const out = sopViolation("Read the lines before editing.");
  assert.match(out, /Read the lines before editing\./, "substance preserved");
  assert.notEqual(out, "Read the lines before editing.", "always wrapped (no toggle)");
  assert.match(out, /process/i, "framed as process discipline");
  assert.match(out, /professional/i, "tells the model to keep the user-facing reply professional");
});
