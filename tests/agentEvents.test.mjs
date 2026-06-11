import { test } from "node:test";
import assert from "node:assert/strict";
import { LabeledEventSink } from "../dist/agent/AgentEvents.js";

function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("LabeledEventSink prefixes every line with the agent label", () => {
  const sink = new LabeledEventSink("orchestrator", false);
  const lines = capture(() => {
    sink.emit({ type: "tool_batch", step: 1, message: "step 1: open_issue" });
    sink.emit({ type: "warn", message: "heads up" });
  });
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /\[orchestrator\]/);
  assert.match(lines[0], /open_issue/);
});

test("worker output is indented to distinguish it from the orchestrator", () => {
  const sink = new LabeledEventSink("fixer", true);
  const [line] = capture(() => sink.emit({ type: "tool_batch", step: 2, message: "step 2: apply_patch" }));
  assert.match(line, /^\s{2}\[fixer\]/);
});

test("model_text is collapsed to a single truncated line", () => {
  const sink = new LabeledEventSink("planner", false);
  const long = "a".repeat(500).split("").join(" "); // forces whitespace collapse + length
  const [line] = capture(() => sink.emit({ type: "model_text", message: `line one\nline two ${long}` }));
  assert.doesNotMatch(line, /\n/);
  assert.ok(line.includes("…"), "should be truncated with an ellipsis");
});
