import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationStore } from "../dist/web/ConversationStore.js";
import { startWebServer } from "../dist/web/server.js";

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-conv-"));
}
function fakeAgent(root) {
  let mode = "on-request";
  return {
    config: { model: "grok-build-0.1", workspaceRoot: root, approval: "on-request" },
    approval: { get mode() { return mode; }, setMode(m) { mode = m; }, prompter: null },
    usage: { hasData: false, format: () => "", lap: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 }) },
    background: { async stopAll() {} },
    askUser: undefined
  };
}
const conv = (root, id, title) => ({
  id, title, createdAt: 1, lastActivityAt: 2, messageCount: 2, useAgents: false,
  model: "grok-build-0.1", workspace: root, seq: 3,
  buffer: [{ seq: 1, ev: { type: "chat", role: "user", text: "prior message" } }]
});

test("ConversationStore save / loadAll / delete round-trips", () => {
  const root = tmpRoot();
  const store = new ConversationStore(root);
  store.save(conv(root, "c1", "First"));
  store.save(conv(root, "c2", "Second"));
  const all = store.loadAll();
  assert.equal(all.length, 2);
  assert.ok(all.find((c) => c.id === "c1" && c.buffer.length === 1));
  store.delete("c1");
  const after = store.loadAll();
  assert.equal(after.length, 1);
  assert.equal(after[0].id, "c2");
});

test("persisted conversations load as archived and can be deleted via the API", async () => {
  const root = tmpRoot();
  new ConversationStore(root).save(conv(root, "old1", "Old chat"));

  const server = await startWebServer({ agent: fakeAgent(root), openBrowser: false, createAgent: async () => fakeAgent(root) });
  const token = new URL(server.url).searchParams.get("t");
  const base = `http://127.0.0.1:${server.port}`;
  const post = (p, body) => fetch(`${base}${p}?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const list = await (await fetch(`${base}/api/sessions?t=${token}`)).json();
    const old = list.sessions.find((s) => s.id === "old1");
    assert.ok(old, "archived conversation is listed");
    assert.equal(old.archived, true);
    assert.equal(old.title, "Old chat");

    const del = await (await post("/api/sessions/delete", { id: "old1" })).json();
    assert.equal(del.ok, true);
    assert.equal(fs.existsSync(path.join(root, ".grok-code", "conversations", "old1.json")), false, "file removed from disk");
    assert.ok(!del.sessions.some((s) => s.id === "old1"), "no longer in the list");
  } finally {
    await server.close();
  }
});
