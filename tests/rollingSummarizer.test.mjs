import test from "node:test";
import assert from "node:assert/strict";
import { RollingSummarizer, mergeSummaries, parseEpisodeSummary, renderSummary, EMPTY_SUMMARY } from "../dist/context/RollingSummarizer.js";

function providerReturning(text) {
  return {
    id: "t",
    capabilities: { serverTools: [], promptCaching: true },
    async complete() {
      return { id: "r", text, toolCalls: [], usage: undefined, warnings: [] };
    }
  };
}

test("summarize parses structured JSON from the provider", async () => {
  const json = JSON.stringify({
    facts: [{ text: "Agent is exported", provenance: "file", confidence: "verified" }],
    filesTouched: [{ path: "a.ts", action: "modified" }],
    decisions: ["use stateless mode"],
    failedAttempts: [{ what: "read missing.ts", why: "not found" }],
    openQuestions: ["which test runner?"]
  });
  const s = new RollingSummarizer(providerReturning(json));
  const result = await s.summarize(["item one", "item two"]);
  assert.equal(result.facts[0].text, "Agent is exported");
  assert.equal(result.filesTouched[0].action, "modified");
  assert.equal(result.failedAttempts[0].why, "not found");
});

test("summarize returns empty summary on no items and on bad output", async () => {
  const s1 = new RollingSummarizer(providerReturning("garbage"));
  assert.deepEqual(await s1.summarize([]), EMPTY_SUMMARY);
  assert.deepEqual(await s1.summarize(["x"]), EMPTY_SUMMARY);
});

test("mergeSummaries is a deterministic deduped union (no LLM)", () => {
  const a = {
    facts: [{ text: "F1", provenance: "x", confidence: "verified" }],
    filesTouched: [{ path: "a.ts", action: "read" }],
    decisions: ["d1"],
    failedAttempts: [{ what: "w1", why: "y1" }],
    openQuestions: ["q1"]
  };
  const b = {
    facts: [{ text: "f1", provenance: "y", confidence: "inferred" }, { text: "F2", provenance: "z", confidence: "uncertain" }],
    filesTouched: [{ path: "a.ts", action: "read" }, { path: "b.ts", action: "modified" }],
    decisions: ["d1", "d2"],
    failedAttempts: [{ what: "w1", why: "y1" }, { what: "w2", why: "y2" }],
    openQuestions: ["q1", "q2"]
  };
  const merged = mergeSummaries(a, b);
  assert.equal(merged.facts.length, 2, "F1/f1 deduped case-insensitively, F2 added");
  assert.deepEqual(merged.filesTouched.map((f) => f.path).sort(), ["a.ts", "b.ts"]);
  assert.deepEqual(merged.decisions, ["d1", "d2"]);
  assert.equal(merged.failedAttempts.length, 2);
  assert.deepEqual(merged.openQuestions, ["q1", "q2"]);

  // merge is order-stable / idempotent on itself
  assert.deepEqual(mergeSummaries(merged, merged), merged);
});

test("renderSummary surfaces failed attempts prominently", () => {
  const text = renderSummary({
    facts: [],
    filesTouched: [],
    decisions: [],
    failedAttempts: [{ what: "edit blind", why: "not read" }],
    openQuestions: []
  });
  assert.match(text, /Failed attempts \(do not repeat\)/);
  assert.match(text, /edit blind — not read/);
});

test("parseEpisodeSummary tolerates partial/malformed fields", () => {
  const s = parseEpisodeSummary('prefix {"facts": [{"text": "ok"}], "decisions": ["d"], "junk": 1} suffix');
  assert.equal(s.facts[0].text, "ok");
  assert.equal(s.facts[0].confidence, "uncertain");
  assert.deepEqual(s.decisions, ["d"]);
  assert.deepEqual(s.failedAttempts, []);
});
