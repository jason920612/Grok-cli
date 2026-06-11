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

async function collectSse(base, token, predicate, timeoutMs = 2500) {
  const res = await fetch(`${base}/api/events?t=${token}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const start = Date.now();
  try {
    while (Date.now() - start < timeoutMs) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (predicate(buf)) return buf;
    }
  } finally {
    await reader.cancel();
  }
  return buf;
}

test("state endpoint exposes the command list and approval modes", async () => {
  await withServer(async ({ base, token }) => {
    const st = await (await fetch(`${base}/api/state?t=${token}`)).json();
    assert.ok(Array.isArray(st.commands) && st.commands.some((c) => c.name === "/status"));
    assert.ok(st.approvalModes.includes("auto-all"));
  });
});

test("a /status command emits an output event over SSE", async () => {
  await withServer(async ({ base, token }) => {
    const sse = collectSse(base, token, (b) => b.includes('"type":"output"'));
    await fetch(`${base}/api/message?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "/status" }) });
    const buf = await sse;
    assert.match(buf, /"type":"output"/);
    assert.match(buf, /Status/);
  });
});

test("a /trust command emits a trust event with the current status", async () => {
  await withServer(async ({ base, token }) => {
    const sse = collectSse(base, token, (b) => b.includes('"type":"trust"'));
    await fetch(`${base}/api/message?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "/trust" }) });
    const buf = await sse;
    assert.match(buf, /"type":"trust"/);
    assert.match(buf, /"current":/);
  });
});

test("/approval command changes the mode", async () => {
  await withServer(async ({ base, token, agent }) => {
    await fetch(`${base}/api/message?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "/approval auto-safe" }) });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(agent.approval.mode, "auto-safe");
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
