// End-to-end LIVE test of the web UI: real agent + real xAI API, driven headless
// with Playwright. Types a small task, lets multi-agent run, screenshots the real
// chat → activity → change-diff flow.  Run: node scripts/web-live-test.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startWebServer } from "../dist/web/server.js";
import { Agent } from "../dist/agent/Agent.js";
import { createXaiProvider } from "../dist/api/XaiResponsesProvider.js";
import { loadConfig } from "../dist/config/loadConfig.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(projectRoot, "scripts", "screenshots");
fs.mkdirSync(outDir, { recursive: true });

// Load the real API key from the project's .env.
const dotenv = await import("../node_modules/dotenv/lib/main.js");
dotenv.default.config({ path: path.join(projectRoot, ".env") });
if (!process.env.XAI_API_KEY) { console.error("No XAI_API_KEY"); process.exit(2); }

// A throwaway git workspace so working-tree diffs render in the UI.
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-weblive-")));
const git = (...a) => execFileSync("git", a, { cwd: ws, stdio: "ignore" });
git("init", "-q"); git("config", "user.email", "t@t.t"); git("config", "user.name", "t");
git("config", "core.autocrlf", "false"); git("checkout", "-q", "-b", "main");
fs.writeFileSync(path.join(ws, "README.md"), "# demo\n");
git("add", "-A"); git("commit", "-q", "-m", "base");

const TASK = "Create a single self-contained file quote.html: a page with a button that shows a random inspirational quote picked from a built-in array of 5 quotes. Inline CSS/JS, no dependencies.";

async function main() {
  const config = loadConfig(ws, { model: "grok-build-0.1", approval: "auto-all", workspaceTrusted: true });
  const provider = createXaiProvider({ model: config.model });
  const agent = await Agent.create(provider, config, TASK);
  const server = await startWebServer({ agent, multiAgentDefault: true, openBrowser: false });
  console.log("server:", server.url);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await page.goto(server.url, { waitUntil: "load" });
  await page.waitForTimeout(500);

  await page.fill("#input", TASK);
  await page.click("#send");
  console.log("task sent; waiting for multi-agent run…");

  // Screenshot progress while it runs, and detect completion.
  const start = Date.now();
  let done = false;
  let i = 0;
  while (Date.now() - start < 360_000) {
    await page.waitForTimeout(8000);
    const running = await page.evaluate(() => document.body.classList.contains("running"));
    const hasAssistant = await page.evaluate(() => !!document.querySelector(".msg.assistant"));
    const acts = await page.evaluate(() => document.querySelectorAll("#acts .act").length);
    if (i === 1 || (i > 0 && i % 4 === 0)) {
      await page.screenshot({ path: path.join(outDir, `live-progress-${String(i).padStart(2, "0")}.png`) });
    }
    console.log(`  t+${Math.round((Date.now() - start) / 1000)}s running=${running} acts=${acts} answered=${hasAssistant}`);
    if (!running && hasAssistant) { done = true; break; }
    i++;
  }

  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, "live-final.png"), fullPage: false });

  // Expand the first change card's diff if present.
  const hasDiff = await page.evaluate(() => !!document.querySelector(".filecard .fhead"));
  if (hasDiff) {
    const head = page.locator(".filecard .fhead").first();
    await head.scrollIntoViewIfNeeded();
    await head.click();
    await page.waitForTimeout(400);
    await head.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, "live-diff.png") });
  }

  const files = fs.readdirSync(ws).filter((f) => !f.startsWith(".") && f !== "README.md");
  console.log("\nRESULT:");
  console.log("  done:", done);
  console.log("  files created:", files.join(", ") || "(none)");
  console.log("  quote.html present:", files.includes("quote.html"));

  await browser.close();
  await server.close();
  await agent.background.stopAll("done");
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
