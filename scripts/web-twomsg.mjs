// Reproduce: after one task completes, does a SECOND message get a response?
// Uses a scripted provider (no real API) through the real multi-agent path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startWebServer } from "../dist/web/server.js";
import { SessionUsage } from "../dist/agent/SessionUsage.js";
import { ApprovalPolicy } from "../dist/approval/ApprovalPolicy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-2msg-")));
const git = (...a) => execFileSync("git", a, { cwd: ws, stdio: "ignore" });
git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
git("config", "core.autocrlf", "false"); git("checkout", "-q", "-b", "main");
fs.writeFileSync(path.join(ws, "README.md"), "# r\n"); git("add", "-A"); git("commit", "-q", "-m", "base");

// Scripted provider: always answers directly (no tool calls) → fast orchestrator run.
const provider = {
  id: "fake",
  capabilities: { serverTools: [], promptCaching: true },
  async complete() {
    return { id: "r", text: "Task done.", toolCalls: [], usage: { inputTokens: 10, outputTokens: 2 }, warnings: [] };
  }
};
const config = {
  model: "fake", approval: "auto-all", toolChoice: "auto", maxSteps: 6, serverTools: false,
  enableWebSearch: false, enableXSearch: false, workspaceRoot: ws, sandboxProfile: "default",
  workspaceTrusted: true, conversationMode: "stateless", enableVerifier: false, verifierMaxRetries: 2, enableLlmSummary: false
};
const agent = { provider, config, usage: new SessionUsage(), approval: new ApprovalPolicy("auto-all"), background: { async stopAll() {} }, askUser: undefined };

function countAssistant(buf) { return (buf.match(/"role":"assistant"/g) || []).length; }

async function main() {
  const server = await startWebServer({ agent, multiAgentDefault: true, openBrowser: false });
  const token = new URL(server.url).searchParams.get("t");
  const base = `http://127.0.0.1:${server.port}`;

  const res = await fetch(`${base}/api/events?t=${token}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = (async () => { while (true) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); } })();

  const send = (text) => fetch(`${base}/api/message?t=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const waitFor = async (n, label) => {
    const start = Date.now();
    while (Date.now() - start < 20000) { if (countAssistant(buf) >= n) return; await new Promise((r) => setTimeout(r, 100)); }
    throw new Error(`timeout: ${label} (assistant replies so far: ${countAssistant(buf)})`);
  };

  await send("first message");
  await waitFor(1, "first reply");
  console.log("first reply OK");

  await new Promise((r) => setTimeout(r, 500));
  await send("second message");
  await waitFor(2, "second reply");
  console.log("second reply OK");

  await reader.cancel().catch(() => {});
  await server.close();
  console.log("\nRESULT: both messages responded ✓");
  process.exit(0);
}
main().catch((e) => { console.error("\nREPRO FAILED:", e.message); process.exit(1); });
