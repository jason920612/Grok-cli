import test from "node:test";
import assert from "node:assert/strict";
import { ContextManager } from "../dist/context/ContextManager.js";

function advance(manager, count) {
  for (let i = 0; i < count; i += 1) {
    manager.nextStep("test task");
  }
}

test("step expiration is relative to item creation step", () => {
  const context = new ContextManager();
  advance(context, 10);

  const item = context.add({
    type: "file_range",
    content: "src/index.ts:1\ncontent",
    priority: 70,
    expiresAfterSteps: 5
  });

  advance(context, 5);
  assert.ok(context.list().some((entry) => entry.id === item.id));

  advance(context, 1);
  assert.equal(context.list().some((entry) => entry.id === item.id), false);
});

test("newly added expiring item is not pruned immediately when manager step is high", () => {
  const context = new ContextManager();
  advance(context, 20);

  const item = context.add({
    type: "file_range",
    content: "src/cli.ts:1\ncontent",
    priority: 70,
    expiresAfterSteps: 5
  });

  advance(context, 1);
  assert.ok(context.list().some((entry) => entry.id === item.id));
});

test("pinned items are not pruned by step expiration", () => {
  const context = new ContextManager();
  const item = context.add({
    type: "environment_summary",
    content: "node 20",
    priority: 90,
    pinned: true,
    expiresAfterSteps: 1
  });

  advance(context, 10);
  assert.ok(context.list().some((entry) => entry.id === item.id));
});

test("budget eviction still removes the lowest-priority non-pinned item first", () => {
  const context = new ContextManager();
  const low = context.add({
    type: "search_result",
    content: "low priority",
    priority: 1,
    tokensEstimate: 60_000
  });
  const high = context.add({
    type: "file_range",
    content: "high priority",
    priority: 90,
    tokensEstimate: 60_000
  });

  const ids = context.list().map((item) => item.id);
  assert.equal(ids.includes(low.id), false);
  assert.equal(ids.includes(high.id), true);
});
