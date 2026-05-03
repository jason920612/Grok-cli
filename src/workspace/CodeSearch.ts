import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { getFileOverviewContent } from "./FileOverview.js";
import { createIgnoreRules } from "./IgnoreRules.js";
import { searchSymbols } from "./SymbolSearch.js";
import type { WorkspaceSandbox } from "./WorkspaceSandbox.js";
import type { RelatedFilesResult, SearchTreeResult } from "../tools/searchTreeInterfaces.js";

const SOURCE_GLOBS = ["**/*.{ts,tsx,js,jsx,mts,cts,json,md,css,scss,html,py,go,rs,rb,java,kt}"];
const TEST_RE = /(\.|-|_)(test|spec)\.[A-Za-z0-9]+$/;

export async function searchCode(sandbox: WorkspaceSandbox, query: string, maxResults = 50): Promise<SearchTreeResult[]> {
  const lower = query.toLowerCase();
  const results: SearchTreeResult[] = [];
  const files = await listSearchableFiles(sandbox);

  for (const rel of files) {
    const pathScore = scorePath(rel, lower);
    if (pathScore > 0) {
      results.push({
        path: rel,
        kind: pathScore >= 2 ? "entrypoint" : "keyword",
        score: pathScore + pathPenalty(rel),
        reason: `Path/name relevance for "${query}".`
      });
    }
  }

  for (const symbol of await searchSymbols(sandbox, query, maxResults)) {
    results.push({
      path: symbol.path,
      startLine: symbol.startLine,
      endLine: symbol.endLine ?? symbol.startLine + 80,
      kind: "symbol",
      score: 4 + pathPenalty(symbol.path),
      reason: `Symbol definition match: ${symbol.kind} ${symbol.name}.`
    });
  }

  for (const rel of files) {
    let text = "";
    try {
      text = await fs.readFile(sandbox.assertReadableFile(rel), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]!.toLowerCase().includes(lower)) continue;
      results.push({
        path: rel,
        startLine: Math.max(1, i + 1 - 40),
        endLine: Math.min(lines.length, i + 1 + 80),
        kind: classifyKeywordHit(rel, lines[i]!),
        score: scoreKeywordHit(rel, lines[i]!) + pathPenalty(rel),
        reason: `Exact keyword match near line ${i + 1}.`
      });
      break;
    }
  }

  return dedupeAndSort(results).slice(0, maxResults);
}

export async function findSymbolCandidates(sandbox: WorkspaceSandbox, name: string, maxResults = 50): Promise<SearchTreeResult[]> {
  const symbols = await searchSymbols(sandbox, name, maxResults);
  return dedupeAndSort(symbols.map((symbol) => ({
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine ?? symbol.startLine + 80,
    kind: "symbol" as const,
    score: 4 + pathPenalty(symbol.path),
    reason: `Symbol definition match: ${symbol.kind} ${symbol.name}.`
  })));
}

export async function getRelatedFiles(sandbox: WorkspaceSandbox, filePath: string, maxResults = 40): Promise<RelatedFilesResult> {
  const abs = sandbox.assertReadableFile(filePath);
  const rel = sandbox.relative(abs);
  const content = await fs.readFile(abs, "utf8");
  const overview = getFileOverviewContent(content);
  const imports = overview.imports
    .map((item) => resolveImport(sandbox, rel, item.text))
    .filter((item): item is string => Boolean(item));
  const files = await listSearchableFiles(sandbox);
  const importedBy: string[] = [];
  for (const candidate of files) {
    if (candidate === rel) continue;
    let text = "";
    try {
      text = await fs.readFile(sandbox.assertReadableFile(candidate), "utf8");
    } catch {
      continue;
    }
    if (text.includes(stripExt(path.basename(rel))) || imports.some((importPath) => text.includes(stripExt(path.basename(importPath))))) {
      importedBy.push(candidate);
    }
    if (importedBy.length >= maxResults) break;
  }
  const base = stripExt(path.basename(rel)).toLowerCase();
  const tests = files.filter((candidate) => {
    const normalized = candidate.toLowerCase();
    return TEST_RE.test(normalized) && normalized.includes(base);
  }).slice(0, maxResults);
  return {
    imports: [...new Set(imports)].slice(0, maxResults),
    exports: overview.exports.map((item) => item.text).slice(0, maxResults),
    importedBy: [...new Set(importedBy)].slice(0, maxResults),
    tests,
    relatedSymbols: overview.symbols.map((symbol) => symbol.name).slice(0, maxResults)
  };
}

async function listSearchableFiles(sandbox: WorkspaceSandbox): Promise<string[]> {
  const ig = createIgnoreRules(sandbox.profile);
  const entries = await fg(SOURCE_GLOBS, { cwd: sandbox.root, dot: true, onlyFiles: true });
  return entries.filter((entry) => !ig.ignores(entry) && !sandbox.isPathDenied(entry, "read"));
}

function scorePath(rel: string, query: string): number {
  const normalized = rel.toLowerCase();
  if (normalized.includes(query)) return 2;
  const terms = query.split(/\W+/).filter((term) => term.length > 2);
  return terms.some((term) => normalized.includes(term)) ? 1 : 0;
}

function scoreKeywordHit(rel: string, line: string): number {
  if (TEST_RE.test(rel)) return 3;
  if (/error|exception|traceback|failed/i.test(line)) return 4;
  if (/\.(md|mdx|txt)$/i.test(rel)) return 1;
  return 3;
}

function classifyKeywordHit(rel: string, line: string): SearchTreeResult["kind"] {
  if (TEST_RE.test(rel)) return "test";
  if (/error|exception|traceback|failed/i.test(line)) return "runtime_error";
  if (/\.(md|mdx|txt)$/i.test(rel)) return "documentation";
  return "keyword";
}

function pathPenalty(rel: string): number {
  if (/(^|\/)(dist|build|coverage|vendor|generated)\//i.test(rel)) return -2;
  if (/(\.min\.(js|css)|lock$|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(rel)) return -2;
  return 0;
}

function dedupeAndSort(results: SearchTreeResult[]): SearchTreeResult[] {
  const byKey = new Map<string, SearchTreeResult>();
  for (const result of results) {
    const key = `${result.path}:${result.startLine ?? 0}:${result.kind}`;
    const existing = byKey.get(key);
    if (!existing || result.score > existing.score) byKey.set(key, result);
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function resolveImport(sandbox: WorkspaceSandbox, fromRel: string, importLine: string): string | undefined {
  const match = importLine.match(/from\s+["']([^"']+)["']/) ?? importLine.match(/import\s+["']([^"']+)["']/);
  const specifier = match?.[1];
  if (!specifier || !specifier.startsWith(".")) return undefined;
  const base = path.posix.dirname(fromRel);
  const candidate = path.posix.normalize(path.posix.join(base, specifier));
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".json"]) {
    const rel = `${candidate}${ext}`;
    try {
      sandbox.assertReadableFile(rel);
      return rel;
    } catch {
      // Try the next extension.
    }
  }
  for (const index of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"]) {
    const rel = `${candidate}${index}`;
    try {
      sandbox.assertReadableFile(rel);
      return rel;
    } catch {
      // Try the next index file.
    }
  }
  return undefined;
}

function stripExt(value: string): string {
  return value.replace(/\.[^.]+$/, "");
}
