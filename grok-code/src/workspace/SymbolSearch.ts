import fs from "node:fs/promises";
import fg from "fast-glob";
import { getFileOverviewContent } from "./FileOverview.js";
import { createIgnoreRules } from "./IgnoreRules.js";
import type { WorkspaceSandbox } from "./WorkspaceSandbox.js";

export async function searchSymbols(sandbox: WorkspaceSandbox, query: string, maxResults = 50) {
  const ig = createIgnoreRules();
  const entries = await fg(["**/*.{ts,tsx,js,jsx,mts,cts}"], {
    cwd: sandbox.root,
    dot: true,
    onlyFiles: true,
    ignore: []
  });
  const results: Array<{ name: string; kind: string; path: string; startLine: number; endLine?: number }> = [];
  for (const rel of entries) {
    if (ig.ignores(rel)) continue;
    const text = await fs.readFile(sandbox.resolvePath(rel), "utf8");
    const overview = getFileOverviewContent(text);
    for (const symbol of overview.symbols) {
      if (symbol.name.toLowerCase().includes(query.toLowerCase())) {
        results.push({ name: symbol.name, kind: symbol.kind, path: rel, startLine: symbol.line });
        if (results.length >= maxResults) return results;
      }
    }
  }
  return results;
}
