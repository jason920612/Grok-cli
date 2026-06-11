// Reproduce the "can't scroll down the chat" report. Loads the web UI against a
// demo backend, injects content via the page's global handle(), and measures
// whether #chat can actually reach the bottom + whether auto-follow works.
import { chromium } from "playwright";
import { startWebServer } from "../dist/web/server.js";

const fakeAgent = {
  config: { model: "grok-build-0.1", workspaceRoot: process.cwd(), approval: "on-request" },
  approval: { mode: "on-request", setMode() {}, prompter: null },
  usage: { hasData: false, format: () => "", lap: () => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 }) },
  background: { async stopAll() {} },
  askUser: undefined
};

const server = await startWebServer({ agent: fakeAgent, demoEvents: [{ type: "mode", agents: true, yes: false }], openBrowser: false });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
await page.goto(server.url, { waitUntil: "load" });
await page.waitForTimeout(400);

// Inject many chat messages so #chat overflows the viewport.
await page.evaluate(() => {
  for (let i = 0; i < 30; i++) handle({ type: "chat", role: i % 2 ? "assistant" : "user", text: "message line number " + i + " — lorem ipsum dolor sit amet ".repeat(3) });
});
await page.waitForTimeout(200);

const m = await page.evaluate(() => {
  const c = document.getElementById("chat");
  return { scrollHeight: c.scrollHeight, clientHeight: c.clientHeight, scrollTop: c.scrollTop, overflows: c.scrollHeight > c.clientHeight + 4 };
});
console.log("after 30 msgs:", JSON.stringify(m));

// TEST A — manual scroll to bottom: set scrollTop to max, read back.
const a = await page.evaluate(() => {
  const c = document.getElementById("chat");
  c.scrollTop = 0;
  const top = c.scrollTop;
  c.scrollTop = c.scrollHeight; // try to go to bottom
  const bottom = c.scrollTop;
  const maxScroll = c.scrollHeight - c.clientHeight;
  return { top, bottom, maxScroll, reachedBottom: Math.abs(bottom - maxScroll) < 2 };
});
console.log("TEST A manual scroll:", JSON.stringify(a), a.reachedBottom ? "PASS" : "FAIL (cannot reach bottom)");

// TEST B — auto-follow: at bottom, a new chat message should keep us at bottom.
const b = await page.evaluate(async () => {
  const c = document.getElementById("chat");
  c.scrollTop = c.scrollHeight;
  await new Promise((r) => setTimeout(r, 30));
  handle({ type: "chat", role: "assistant", text: "a brand new message that should auto-follow" });
  await new Promise((r) => setTimeout(r, 60));
  const maxScroll = c.scrollHeight - c.clientHeight;
  return { scrollTop: c.scrollTop, maxScroll, followed: Math.abs(c.scrollTop - maxScroll) < 80 };
});
console.log("TEST B auto-follow:", JSON.stringify(b), b.followed ? "PASS" : "FAIL (did not follow new message)");

// TEST C — viewed-file streaming then a chat msg (the multi-agent drift case).
const cRes = await page.evaluate(async () => {
  const c = document.getElementById("chat");
  c.scrollTop = c.scrollHeight; // user is following at the bottom
  for (let i = 0; i < 12; i++) handle({ type: "viewed", agent: "worker:w1", path: "file" + i + ".ts" });
  await new Promise((r) => setTimeout(r, 60));
  const afterViewed = { scrollTop: c.scrollTop, maxScroll: c.scrollHeight - c.clientHeight };
  handle({ type: "chat", role: "assistant", text: "final summary message after the run" });
  await new Promise((r) => setTimeout(r, 60));
  const afterMsg = { scrollTop: c.scrollTop, maxScroll: c.scrollHeight - c.clientHeight };
  return { afterViewed, afterMsg, followedFinal: Math.abs(afterMsg.scrollTop - afterMsg.maxScroll) < 80 };
});
console.log("TEST C viewed-drift:", JSON.stringify(cRes), cRes.followedFinal ? "PASS (followed final)" : "FAIL (drifted; final msg not in view)");

await browser.close();
await server.close();
console.log("done");
