import test from "node:test";
import assert from "node:assert/strict";
import { findLazyMarkers } from "../dist/tools/lazyMarkers.js";

const wrap = (added) => "*** Begin Patch\n*** Update File: a.js\n@@\n" + added.map((l) => "+" + l).join("\n") + "\n*** End Patch";

test("flags placeholder / MVP / stub markers in added lines", () => {
  assert.ok(findLazyMarkers(wrap(["// TODO: implement auth later"])).length > 0);
  assert.ok(findLazyMarkers(wrap(["return null; // in a real implementation this would query the DB"])).length > 0);
  assert.ok(findLazyMarkers(wrap(["// ... rest of the handlers unchanged"])).length > 0);
  assert.ok(findLazyMarkers(wrap(["const data = mockData; // mock data for now"])).length > 0);
  assert.ok(findLazyMarkers(wrap(["// for brevity, only one case is handled"])).length > 0);
});

test("does not flag legitimate production code", () => {
  assert.equal(findLazyMarkers(wrap([
    "function add(a, b) {",
    "  if (typeof a !== 'number') throw new Error('a must be a number');",
    "  return a + b;",
    "}"
  ])).length, 0);
});

test("only inspects added (+) lines, not context", () => {
  const patch = "*** Begin Patch\n*** Update File: a.js\n@@\n // TODO: implement this later (existing context)\n+const x = 1;\n*** End Patch";
  assert.equal(findLazyMarkers(patch).length, 0);
});
