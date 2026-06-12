// Verify the split preview pane: clicking a changed-file row opens #preview and
// shows its diff; close hides it.
import { chromium } from "playwright";
import { startWebServer } from "../dist/web/server.js";

const fakeAgent = {
  config: { model: "grok-build-0.1", workspaceRoot: process.cwd(), approval: "on-request" },
  approval: { mode: "on-request", setMode() {}, prompter: null },
  usage: { hasData: false, format: () => "", lap: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 }) },
  background: { async stopAll() {} },
  askUser: undefined
};
const events = [
  { type: "mode", agents: true, yes: false },
  { type: "viewed", agent: "worker:w1", path: "src/cli.ts" },
  { type: "changes", files: [
    { path: "index.html", status: "A", additions: 3, deletions: 0, body: "@@ new file @@\n+<!doctype html>\n+<title>hi</title>\n+<h1>hello</h1>" }
  ] }
];

const server = await startWebServer({ agent: fakeAgent, demoEvents: events, openBrowser: false });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.goto(server.url, { waitUntil: "load" });
await page.waitForTimeout(400);

const beforeVisible = await page.evaluate(() => getComputedStyle(document.getElementById("preview")).display);
console.log("preview before click:", beforeVisible, beforeVisible === "none" ? "PASS (hidden)" : "FAIL");

await page.locator(".filecard .fhead").first().click();
await page.waitForTimeout(150);
const afterClick = await page.evaluate(() => ({
  previewing: document.body.classList.contains("previewing"),
  display: getComputedStyle(document.getElementById("preview")).display,
  name: document.getElementById("pname").textContent,
  bodyText: document.getElementById("pbody").innerText.slice(0, 60),
  activeRows: document.querySelectorAll(".filecard.active").length
}));
console.log("after click:", JSON.stringify(afterClick), (afterClick.previewing && afterClick.display !== "none" && afterClick.name && afterClick.bodyText.length > 0 && afterClick.activeRows === 1) ? "PASS" : "FAIL");

// Click the changed file (index.html) and confirm its diff renders.
await page.locator(".filecard .fhead", { hasText: "index.html" }).click();
await page.waitForTimeout(120);
const diffView = await page.evaluate(() => ({ name: document.getElementById("pname").textContent, body: document.getElementById("pbody").innerText }));
console.log("changed-file diff:", JSON.stringify({ name: diffView.name, has: diffView.body.includes("hello") }), (diffView.name === "index.html" && diffView.body.includes("hello")) ? "PASS" : "FAIL");

await page.locator("#pclose").click();
await page.waitForTimeout(100);
const afterClose = await page.evaluate(() => ({ previewing: document.body.classList.contains("previewing"), display: getComputedStyle(document.getElementById("preview")).display }));
console.log("after close:", JSON.stringify(afterClose), (!afterClose.previewing && afterClose.display === "none") ? "PASS" : "FAIL");

await browser.close();
await server.close();
console.log("done");
