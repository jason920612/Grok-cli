import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fg from "fast-glob";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { commandExists, makeTool } from "./helpers.js";
import { createIgnoreRules } from "../../workspace/IgnoreRules.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const execFileAsync = promisify(execFile);

export function searchTextTool(skills: ToolSkillRegistry) {
  return makeTool(
    "search_text",
    "Find exact strings, error messages, config keys, routes, or test names without returning whole files.",
    schemas.object({ query: schemas.string("Search query."), glob: schemas.string("Glob pattern."), path: schemas.string("Path scope."), maxResults: schemas.number("Maximum results.") }, ["query"]),
    z.object({ query: z.string().min(1), glob: z.string().optional(), path: z.string().optional(), maxResults: z.number().int().positive().max(500).optional() }),
    skills,
    async (args, ctx) => {
      const max = args.maxResults ?? 100;
      const base = args.path ?? ".";
      ctx.sandbox.resolvePath(base);
      const results = await (await commandExists("rg") ? rgSearch(ctx, args.query, base, args.glob, max) : nodeSearch(ctx, args.query, base, args.glob, max));
      ctx.context.add({ type: "search_result", content: `search_text ${args.query}\n${results.map((r) => `${r.path}:${r.line}: ${r.preview}`).join("\n")}`, priority: 55, expiresAfterSteps: 3 });
      return { results };
    }
  );
}

async function rgSearch(ctx: any, query: string, base: string, glob: string | undefined, max: number) {
  const rgArgs = ["--line-number", "--fixed-strings", "--color", "never", query, base];
  if (glob) rgArgs.splice(0, 0, "--glob", glob);
  try {
    const { stdout } = await execFileAsync("rg", rgArgs, { cwd: ctx.workspaceRoot, timeout: 30_000, maxBuffer: 2_000_000, windowsHide: true });
    return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
      const [file, lineNo, ...rest] = line.split(":");
      return { path: file ?? "", line: Number(lineNo), preview: rest.join(":").trim() };
    }).filter((result) => !ctx.sandbox.isPathDenied(result.path, "read")).slice(0, max);
  } catch (error: any) {
    if (error?.code === 1) return [];
    throw error;
  }
}

async function nodeSearch(ctx: any, query: string, base: string, glob: string | undefined, max: number) {
  const ig = createIgnoreRules(ctx.sandbox.profile);
  const entries = await fg(glob ?? "**/*", { cwd: ctx.sandbox.resolvePath(base), onlyFiles: true, dot: true });
  const results: Array<{ path: string; line: number; preview: string }> = [];
  for (const entry of entries) {
    const rel = base === "." ? entry : `${base}/${entry}`;
    if (ig.ignores(rel) || ctx.sandbox.isPathDenied(rel, "read")) continue;
    let text = "";
    try { text = await fs.readFile(ctx.sandbox.assertReadableFile(rel), "utf8"); } catch { continue; }
    text.split(/\r?\n/).forEach((line, index) => {
      if (results.length < max && line.includes(query)) results.push({ path: rel, line: index + 1, preview: line.trim().slice(0, 300) });
    });
    if (results.length >= max) break;
  }
  return results;
}
