import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexPatch, applyCodexUpdate } from "../dist/tools/codexPatch.js";

const wrap = (...lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

test("parses add / delete / update actions", () => {
  const patch = wrap(
    "*** Add File: a.txt",
    "+hello",
    "*** Delete File: old.txt",
    "*** Update File: b.ts",
    "@@",
    " keep",
    "-remove",
    "+added"
  );
  const { actions } = parseCodexPatch(patch);
  assert.equal(actions.length, 3);
  assert.deepEqual(actions[0], { type: "add", path: "a.txt", lines: ["hello"] });
  assert.deepEqual(actions[1], { type: "delete", path: "old.txt" });
  assert.equal(actions[2].type, "update");
  assert.equal(actions[2].hunks[0].changes.length, 3);
});

test("rejects a patch without the envelope markers", () => {
  assert.throws(() => parseCodexPatch("*** Update File: x\n+y"), /Begin Patch/);
  assert.throws(() => parseCodexPatch("*** Begin Patch\n*** Add File: a\n+x"), /End Patch/);
});

test("applies an update located by context, not line numbers", () => {
  const content = "alpha\nbeta\ngamma\n";
  const { actions } = parseCodexPatch(wrap("*** Update File: f", "@@", " alpha", "-beta", "+BETA", " gamma"));
  const { result, ranges } = applyCodexUpdate(content, actions[0].hunks);
  assert.equal(result, "alpha\nBETA\ngamma\n");
  assert.deepEqual(ranges, [{ startLine: 1, endLine: 3 }]);
});

test("tolerates trailing/leading whitespace drift in context", () => {
  const content = "  indented one\n  indented two\n";
  // model dropped the exact leading whitespace on the context line
  const { actions } = parseCodexPatch(wrap("*** Update File: f", "@@", "-indented one", "+CHANGED one", " indented two"));
  const { result } = applyCodexUpdate(content, actions[0].hunks);
  assert.match(result, /CHANGED one/);
  assert.match(result, /indented two/);
});

test("uses the @@ header to disambiguate repeated context", () => {
  const content = ["function a() {", "  return 1;", "}", "function b() {", "  return 1;", "}", ""].join("\n");
  const { actions } = parseCodexPatch(
    wrap("*** Update File: f", "@@ function b()", "-  return 1;", "+  return 2;")
  );
  // header anchors search at function b(), so the second "return 1;" is changed
  const { result } = applyCodexUpdate(content, actions[0].hunks);
  assert.match(result, /function a\(\) \{\n {2}return 1;/);
  assert.match(result, /function b\(\) \{\n {2}return 2;/);
});

test("Add File ignores diff/envelope noise the model may echo", () => {
  const patch = wrap(
    "*** Add File: src/utils/slugify.ts",
    "++ src/utils/slugify.ts",
    "@@",
    "+export function slugify(text) {",
    "+  return text;",
    "+}"
  );
  const { actions } = parseCodexPatch(patch);
  assert.deepEqual(actions[0].lines, ["export function slugify(text) {", "  return text;", "}"]);
});

test("throws when a hunk cannot be located", () => {
  const { actions } = parseCodexPatch(wrap("*** Update File: f", "@@", "-nonexistent line", "+x"));
  assert.throws(() => applyCodexUpdate("real content\n", actions[0].hunks), /Could not locate/);
});

test("multiple hunks apply in order", () => {
  const content = ["one", "two", "three", "four", ""].join("\n");
  const { actions } = parseCodexPatch(
    wrap("*** Update File: f", "@@", "-one", "+ONE", " two", "@@", "-four", "+FOUR")
  );
  const { result } = applyCodexUpdate(content, actions[0].hunks);
  assert.equal(result, ["ONE", "two", "three", "FOUR", ""].join("\n"));
});
