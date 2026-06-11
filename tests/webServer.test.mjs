import test from "node:test";
import assert from "node:assert/strict";
import { startWebServer } from "../dist/web/server.js";

function fakeAgent() {
  let mode = "on-request";
  return {
    config: { model: "grok-build-0.1", workspaceRoot: process.cwd(), approval: "on-request" },
    approval: {
      get mode() { return mode; },
      setMode(m) { mode = m; },
      prompter: null
    },
    usage: { hasData: false, format: () => "", lap: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 }) },
    background: { async stopAll() {} },
    askUser: undefined
  };
}

async function withServer(fn) {
  const agent = fakeAgent();
  const server = await startWebServer({ agent, demoEvents: [{ type: "mode", agents: true, yes: false }], openBrowser: false });
  const token = new URL(server.url).searchParams.get("t");
  const base = `http://127.0.0.1:${server.port}`;
  try {
    await fn({ agent, server, token, base });
  } finally {
    await server.close();
  }
}

test("requests without the session token are rejected", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 403);
  });
});

test("state endpoint returns config with a valid token", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/api/state?t=${token}`);
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.equal(state.model, "grok-build-0.1");
    assert.equal(state.agents, true);
  });
});

test("SSE stream replays the buffered events on connect", async () => {
  await withServer(async ({ base, token }) => {
    const res = await fetch(`${base}/api/events?t=${token}`);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /"type":"mode"/);
    await reader.cancel();
  });
});

test("toggle flips always-approve to auto-all and back", async () => {
  await withServer(async ({ base, token, agent }) => {
    await fetch(`${base}/api/toggle?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ yes: true }) });
    assert.equal(agent.approval.mode, "auto-all");
    await fetch(`${base}/api/toggle?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ yes: false }) });
    assert.equal(agent.approval.mode, "on-request");
  });
});
