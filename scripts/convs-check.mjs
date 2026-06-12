// Verify the left conversation sidebar: it lists the conversation and collapses.
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
  { type: "chat", role: "user", text: "做一個美股儀表板" }
];
const server = await startWebServer({ agent: fakeAgent, demoEvents: events, openBrowser: false, createAgent: async () => fakeAgent });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.goto(server.url, { waitUntil: "load" });
await page.waitForTimeout(500);

const sidebar = await page.evaluate(() => ({
  present: !!document.getElementById("convs"),
  width: document.getElementById("convs").getBoundingClientRect().width,
  convCount: document.querySelectorAll("#conv-list .conv").length,
  firstTitle: document.querySelector("#conv-list .conv .ctitle")?.textContent || ""
}));
console.log("sidebar:", JSON.stringify(sidebar), (sidebar.present && sidebar.width > 100 && sidebar.convCount >= 1) ? "PASS" : "FAIL");

await page.click("#conv-toggle");
await page.waitForTimeout(250);
const collapsed = await page.evaluate(() => ({
  collapsed: document.body.classList.contains("convs-collapsed"),
  width: document.getElementById("convs").getBoundingClientRect().width
}));
console.log("after collapse:", JSON.stringify(collapsed), (collapsed.collapsed && collapsed.width < 5) ? "PASS" : "FAIL");

await page.click("#conv-toggle");
await page.waitForTimeout(250);
const reopened = await page.evaluate(() => document.getElementById("convs").getBoundingClientRect().width);
console.log("after re-open:", reopened, reopened > 100 ? "PASS" : "FAIL");

await browser.close();
await server.close();
console.log("done");
