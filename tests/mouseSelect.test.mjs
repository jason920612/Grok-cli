import { test } from "node:test";
import assert from "node:assert/strict";
import { renderChoiceLines, clickIndex } from "../dist/ui/mouseSelect.js";

const CHOICES = [
  { name: "Allow once", value: "allow_once", description: "just this time" },
  { name: "Allow similar", value: "allow_similar" },
  { name: "Deny", value: "deny" }
];

test("renderChoiceLines marks the active row with a pointer and shows its description", () => {
  const lines = renderChoiceLines(CHOICES, 0);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /❯ /);
  assert.match(lines[0], /just this time/);
  assert.match(lines[1], /^ {2}Allow similar/);
  assert.doesNotMatch(lines[1], /❯/);
});

test("clickIndex maps absolute rows to choices and rejects out-of-range clicks", () => {
  // choices start at screen row 5
  assert.equal(clickIndex(5, 5, 3), 0);
  assert.equal(clickIndex(7, 5, 3), 2);
  assert.equal(clickIndex(8, 5, 3), -1, "below the list");
  assert.equal(clickIndex(4, 5, 3), -1, "above the list");
});
