import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitDiff, buildRows, renderFrame, parseInput, summarizeChanges, renderPlain } from "../dist/ui/diffBrowser.js";

const SAMPLE = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,3 @@",
  " const x = 1;",
  "-const y = 2;",
  "+const y = 3;",
  "+const z = 4;",
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "index 000..333",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,1 @@",
  "+hello"
].join("\n");

test("parseGitDiff splits files, counts changes, and detects status", () => {
  const files = parseGitDiff(SAMPLE);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].status, "M");
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 1);
  assert.equal(files[1].path, "new.ts");
  assert.equal(files[1].status, "A");
  assert.equal(files[1].additions, 1);
  assert.match(files[0].body, /@@ -1,2 \+1,3 @@/);
});

test("buildRows shows only headers when collapsed, body when expanded", () => {
  const files = parseGitDiff(SAMPLE);
  const collapsed = { entries: files.map((f) => ({ ...f, expanded: false })), selected: 0, scroll: 0 };
  assert.equal(buildRows(collapsed).filter((r) => r.header).length, 2);
  assert.equal(buildRows(collapsed).filter((r) => !r.header).length, 0);

  const expanded = { entries: files.map((f, i) => ({ ...f, expanded: i === 0 })), selected: 0, scroll: 0 };
  const rows = buildRows(expanded);
  assert.ok(rows.some((r) => !r.header && /const z = 4/.test(r.text)), "expanded body lines present");
});

test("renderFrame includes a title and footer and fits the viewport height", () => {
  const files = parseGitDiff(SAMPLE);
  const state = { entries: files.map((f) => ({ ...f, expanded: false })), selected: 0, scroll: 0 };
  const frame = renderFrame(state, 80, 10).split("\r\n");
  assert.match(frame[0], /Changes — 2 file/);
  assert.match(frame[frame.length - 1], /q to close/);
  assert.equal(frame.length, 10, "title + 8 body + footer");
});

test("parseInput decodes keys and SGR mouse events", () => {
  assert.deepEqual(parseInput("q"), { type: "quit" });
  assert.deepEqual(parseInput("\x1b"), { type: "quit" });
  assert.deepEqual(parseInput("\x1b[B"), { type: "down" });
  assert.deepEqual(parseInput(" "), { type: "toggle" });
  assert.deepEqual(parseInput("\x1b[<0;10;5M"), { type: "click", row: 5 });
  assert.deepEqual(parseInput("\x1b[<64;1;1M"), { type: "scroll", delta: -3 });
  assert.equal(parseInput("\x1b[<0;10;5m").type, "none", "mouse release is ignored");
});

test("summarizeChanges and renderPlain handle the empty case", () => {
  assert.equal(summarizeChanges([]), "");
  assert.match(renderPlain([]), /No changes/);
  const one = summarizeChanges(parseGitDiff(SAMPLE));
  assert.match(one, /Changed 2 file/);
  assert.match(one, /\/diff to view/);
});
