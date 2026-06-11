import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

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
        throw new Error("screenshot requires Playwright (npm i -D playwright && npx playwright install chromium).");
      }
      const isUrl = /^https?:\/\//i.test(args.target);
      const url = isUrl ? args.target : pathToFileURL(ctx.sandbox.assertReadableFile(args.target)).href;
      const browser = await chromium.launch();
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
