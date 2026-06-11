import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

/**
 * Desktop computer-use (Windows, via built-in PowerShell + .NET — no native deps).
 *
 * capture_window: screenshots a window (or the full screen) AND enumerates
 *   clickable UI Automation elements with their center coordinates. The image is
 *   attached to the next model turn (multimodal), so the model SEES the UI and
 *   gets exact button coordinates.
 * click_desktop: clicks an element. A named element that supports the UIA Invoke
 *   pattern is invoked WITHOUT moving the cursor or stealing focus; otherwise it
 *   falls back to a real cursor click. Gated by the approval policy.
 */

function winScript(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "..", "win", name), path.join(here, "..", "..", "..", "src", "tools", "win", name)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`PowerShell helper not found: ${name}`);
}

function runPs(script: string, args: string[]): any {
  // The script writes UTF-8 JSON to this temp file (stdout encoding on Windows
  // PowerShell mangles non-ASCII window/element names).
  const outFile = path.join(os.tmpdir(), `grok-cu-${randomUUID().slice(0, 8)}.json`);
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args, "-Out", outFile],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60_000 }
    );
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8").trim() : "";
    return text ? JSON.parse(text) : {};
  } finally {
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

const requireWindows = () => {
  if (process.platform !== "win32") throw new Error("Desktop computer-use is only available on Windows.");
};

export function listWindowsTool(skills: ToolSkillRegistry) {
  return makeTool(
    "list_windows",
    "List the open top-level desktop windows (title + position/size). Call this FIRST when doing desktop automation so you know what windows exist and their exact titles to pass to capture_window / click_desktop.",
    schemas.object({}, []),
    z.object({}),
    skills,
    async () => {
      requireWindows();
      const r = runPs(winScript("list.ps1"), []);
      const windows = Array.isArray(r) ? r : [];
      return { count: windows.length, windows };
    }
  );
}

export function captureWindowTool(skills: ToolSkillRegistry) {
  return makeTool(
    "capture_window",
    "Screenshot a desktop window (match by title substring) or the full screen, and list its clickable UI elements with center coordinates. You SEE the screenshot next step. Use to inspect any app's UI before clicking.",
    schemas.object({ window: { type: "string" }, fullScreen: { type: "boolean" }, note: { type: "string" } }, []),
    z.object({ window: z.string().optional(), fullScreen: z.boolean().optional(), note: z.string().optional() }),
    skills,
    async (args, ctx) => {
      requireWindows();
      const psArgs = args.fullScreen ? ["-FullScreen"] : args.window ? ["-Window", args.window] : [];
      const r = runPs(winScript("capture.ps1"), psArgs);
      if (r.image && ctx.images) {
        ctx.images.push({ dataUri: `data:image/png;base64,${r.image}`, note: args.note ?? `screen: ${r.window ?? "full"}` });
      }
      const elements = Array.isArray(r.elements) ? r.elements.slice(0, 80) : [];
      return {
        window: r.window,
        bounds: r.bounds,
        elementCount: Array.isArray(r.elements) ? r.elements.length : 0,
        elements: elements.map((e: any) => ({ name: e.name, type: e.type, x: e.cx, y: e.cy, invokable: e.invokable }))
      };
    }
  );
}

export function clickDesktopTool(skills: ToolSkillRegistry) {
  return makeTool(
    "click_desktop",
    "Click a desktop UI element: by name (preferred — uses accessibility Invoke, no cursor movement) or by x/y coordinates. button is left or right. Always pass the element name from capture_window when possible so the click doesn't disturb the user's cursor.",
    schemas.object(
      { window: { type: "string" }, name: { type: "string" }, x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, reason: { type: "string" } },
      ["reason"]
    ),
    z.object({
      window: z.string().optional(),
      name: z.string().optional(),
      x: z.number().int().optional(),
      y: z.number().int().optional(),
      button: z.enum(["left", "right"]).optional(),
      reason: z.string().min(1)
    }).refine((v) => v.name || (typeof v.x === "number" && typeof v.y === "number"), { message: "Provide an element name or x and y coordinates." }),
    skills,
    async (args, ctx) => {
      requireWindows();
      const button = args.button ?? "left";
      const target = args.name ? `"${args.name}"` : `(${args.x},${args.y})`;
      const approval = await ctx.approval.approveCommand(`desktop ${button}-click ${target} in ${args.window ?? "screen"}`, args.reason);
      if (!approval.approved) throw new Error(approval.message ?? "Click was not approved.");
      const psArgs: string[] = ["-Button", button];
      if (args.window) psArgs.push("-Window", args.window);
      if (args.name) psArgs.push("-Name", args.name);
      if (typeof args.x === "number") psArgs.push("-X", String(args.x));
      if (typeof args.y === "number") psArgs.push("-Y", String(args.y));
      return runPs(winScript("click.ps1"), psArgs);
    }
  );
}
