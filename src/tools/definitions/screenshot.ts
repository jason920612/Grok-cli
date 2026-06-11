import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

/** Launch Chromium; if its browser binary is missing, install it once and retry. */
async function launchChromium(chromium: typeof import("playwright").chromium) {
  try {
    return await chromium.launch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Executable doesn't exist|playwright install|not found/i.test(message)) throw error;
    console.log("Installing the headless browser (Chromium) for screenshots — first time only…");
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
    execFileSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", cwd: path.dirname(fileURLToPath(import.meta.url)) });
    return chromium.launch();
  }
}

/**
 * screenshot — render a local HTML file (or URL) in a headless browser and SEE
 * the result. This lets the agent visually verify a UI it built: capture the
 * page, then inspect the screenshot on the next turn (grok-build-0.1 is
 * multimodal). Requires Playwright + Chromium; degrades with a clear message if
 * unavailable. The capture is queued on the context's image mailbox.
 */
export function screenshotTool(skills: ToolSkillRegistry) {
  return makeTool(
    "screenshot",
    "Render a web page in a headless browser and SEE it, to visually verify a UI you built. target is a local file (e.g. index.html) or an http(s) URL. Use after building/changing a page; describe what to check in note.",
    schemas.object(
      { target: { type: "string" }, fullPage: { type: "boolean" }, note: { type: "string" } },
      ["target"]
    ),
    z.object({ target: z.string().min(1), fullPage: z.boolean().optional(), note: z.string().optional() }),
    skills,
    async (args, ctx) => {
      let chromium: typeof import("playwright").chromium;
      try {
        ({ chromium } = await import("playwright"));
      } catch {
        throw new Error("screenshot requires Playwright (it ships with grok-code; reinstall dependencies if missing).");
      }
      const isUrl = /^https?:\/\//i.test(args.target);
      const url = isUrl ? args.target : pathToFileURL(ctx.sandbox.assertReadableFile(args.target)).href;
      const browser = await launchChromium(chromium);
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        await page.waitForTimeout(300);
        const buf = await page.screenshot({ fullPage: args.fullPage ?? false, type: "png" });
        ctx.images?.push({ dataUri: `data:image/png;base64,${buf.toString("base64")}`, note: args.note ?? `screenshot of ${path.basename(args.target)}` });
        return { captured: args.target, bytes: buf.length, attached: Boolean(ctx.images) };
      } finally {
        await browser.close();
      }
    }
  );
}
