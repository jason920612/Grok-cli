// Renders the web UI against a demo-mode backend (pre-baked events, no live
// agent/API) and captures PNG screenshots with Playwright. The screenshots are
// for visual self-review during development and as a manual regression artifact.
//
// Run:  node scripts/web-screenshot.mjs   (build first: npm run build)
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { startWebServer } from "../dist/web/server.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(projectRoot, "scripts", "screenshots");
fs.mkdirSync(outDir, { recursive: true });

// A fake agent — demo mode never calls it, but startWebServer reads config/usage.
const fakeAgent = {
  config: { model: "grok-build-0.1", workspaceRoot: process.cwd(), approval: "on-request" },
  approval: { mode: "on-request", setMode() {}, prompter: null },
  usage: { hasData: false, format: () => "", lap: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 }) },
  background: { async stopAll() {} },
  askUser: undefined
};

const DEMO_EVENTS = [
  { type: "mode", agents: true, yes: false },
  { type: "usage", line: "in 18.4k (cached 14.2k, 77% hit) · out 2.1k · 9 calls" },
  { type: "chat", role: "user", text: "做一個能夠抓取美國 SEC 公開的上市公司相關資訊的網頁" },
  { type: "activity", agent: "orchestrator", kind: "tool_batch", message: "step 1: inspect_environment" },
  { type: "activity", agent: "orchestrator", kind: "tool_batch", message: "step 2: open_issue #1 (scrape SEC EDGAR)" },
  { type: "activity", agent: "orchestrator", kind: "tool_batch", message: "step 3: spawn_agents (html, js)" },
  { type: "activity", agent: "worker:html", kind: "tool_batch", message: "step 1: apply_patch index.html" },
  { type: "activity", agent: "worker:js", kind: "tool_batch", message: "step 1: apply_patch app.js" },
  { type: "activity", agent: "worker:js", kind: "warn", message: "EDGAR rate limit — added 100ms backoff" },
  {
    type: "request",
    id: "req1",
    kind: "approval",
    payload: { operation: "run shell command", command: "pip install requests", reason: "fetch EDGAR JSON over HTTPS", risk: "network or dependency operation" }
  },
  { type: "chat", role: "assistant", text: "完成了。建立了一個查詢 SEC EDGAR 的網頁：輸入公司 **ticker** 後抓取最新申報文件清單並顯示。改了 2 個檔案，下面可以展開看 diff。" },
  {
    type: "changes",
    files: [
      { path: "index.html", status: "A", additions: 28, deletions: 0, body: "@@ new file @@\n+<!DOCTYPE html>\n+<html>\n+<head><title>SEC Lookup</title></head>\n+<body>\n+  <input id=ticker placeholder=\"AAPL\">\n+  <button onclick=search()>Search</button>\n+  <ul id=results></ul>\n+</body>\n+</html>" },
      { path: "app.js", status: "A", additions: 34, deletions: 0, body: "@@ new file @@\n+async function search() {\n+  const t = document.getElementById('ticker').value;\n+  const r = await fetch('https://data.sec.gov/...' + t);\n+  const data = await r.json();\n+  render(data.filings);\n+}" }
    ]
  }
];

const ASK_EVENT = {
  type: "request",
  id: "ask1",
  kind: "ask_user",
  payload: {
    questions: [
      { question: "你想用哪種方式查詢公司？", options: ["用 ticker 代號 (如 AAPL)", "用公司名稱", "用 CIK 編號"] },
      { question: "結果要顯示哪些申報類型？", options: ["全部", "只要 10-K / 10-Q", "只要 8-K"] }
    ]
  }
};

async function shot(page, server, events, name, mutate) {
  // Reset by reloading; demoEvents are replayed from the buffer on connect.
  await page.goto(server.url, { waitUntil: "load" });
  await page.waitForTimeout(600);
  if (mutate) await mutate(page);
  await page.waitForTimeout(300);
  const file = path.join(outDir, name);
  await page.screenshot({ path: file, fullPage: false });
  console.log("wrote", path.relative(projectRoot, file));
}

async function main() {
  const server = await startWebServer({ agent: fakeAgent, demoEvents: DEMO_EVENTS, openBrowser: false });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });

  // 1. Default view: chat + activity + approval card + change cards collapsed.
  await shot(page, server, DEMO_EVENTS, "01-default.png");

  // 2. Diff expanded (click the first file card header).
  await shot(page, server, DEMO_EVENTS, "02-diff-expanded.png", async (p) => {
    await p.locator(".filecard .fhead").first().click();
  });

  // 3. Commands menu open (GUI access to all slash commands).
  await shot(page, server, DEMO_EVENTS, "04-commands-menu.png", async (p) => {
    await p.click("#cmds");
  });

  // 4. ask_user card.
  const serverAsk = await startWebServer({ agent: fakeAgent, demoEvents: [...DEMO_EVENTS.slice(0, 3), ASK_EVENT], openBrowser: false });
  await shot(page, serverAsk, [], "03-ask-user.png");

  await browser.close();
  await server.close();
  await serverAsk.close();
  console.log("\nScreenshots in scripts/screenshots/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
