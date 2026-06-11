/**
 * Codex-style apply_patch envelope (context-located, not line-numbered).
 *
 * Format:
 *   *** Begin Patch
 *   *** Add File: path
 *   +new line
 *   *** Update File: path
 *   *** Move to: newpath        (optional)
 *   @@ optional locator header
 *    context line (space prefix)
 *   -removed line
 *   +added line
 *   *** Delete File: path
 *   *** End Patch
 *
 * Hunks are located by matching their context+removed lines against the file
 * content (exact, then whitespace-tolerant), so the model never has to compute
 * line numbers — the failure mode of strict unified diff.
 */

export type LineRange = { startLine: number; endLine: number };
export type CodexChange = { kind: "context" | "del" | "add"; text: string };
export type CodexHunk = { header?: string; changes: CodexChange[] };
export type CodexAction =
  | { type: "add"; path: string; lines: string[] }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; movePath?: string; hunks: CodexHunk[] };
export type CodexPatch = { actions: CodexAction[] };

const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";

export function parseCodexPatch(text: string): CodexPatch {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const beginIdx = raw.findIndex((l) => l.trim() === "*** Begin Patch");
  if (beginIdx === -1) throw new Error('Patch must start with "*** Begin Patch".');

  const actions: CodexAction[] = [];
  let current: CodexAction | null = null;
  let hunk: CodexHunk | null = null;

  const flushHunk = () => {
    if (current?.type === "update" && hunk) current.hunks.push(hunk);
    hunk = null;
  };
  const flushAction = () => {
    flushHunk();
    if (current) actions.push(current);
    current = null;
  };

  for (let i = beginIdx + 1; i < raw.length; i++) {
    const line = raw[i];
    const trimmed = line.trim();
    if (trimmed === "*** End Patch") {
      flushAction();
      return { actions };
    }
    if (line.startsWith(ADD)) {
      flushAction();
      current = { type: "add", path: line.slice(ADD.length).trim(), lines: [] };
      continue;
    }
    if (line.startsWith(DELETE)) {
      flushAction();
      current = { type: "delete", path: line.slice(DELETE.length).trim() };
      continue;
    }
    if (line.startsWith(UPDATE)) {
      flushAction();
      current = { type: "update", path: line.slice(UPDATE.length).trim(), hunks: [] };
      continue;
    }
    if (line.startsWith(MOVE)) {
      if (current?.type === "update") current.movePath = line.slice(MOVE.length).trim();
      continue;
    }
    if (!current) continue; // stray lines before the first action
    if (current.type === "add") {
      current.lines.push(line.startsWith("+") ? line.slice(1) : line);
      continue;
    }
    if (current.type === "update") {
      if (trimmed.startsWith("@@")) {
        flushHunk();
        const header = line.replace(/^\s*@@/, "").trim();
        hunk = { header: header || undefined, changes: [] };
        continue;
      }
      if (!hunk) hunk = { changes: [] };
      hunk.changes.push(parseChangeLine(line));
    }
  }
  throw new Error('Patch must end with "*** End Patch".');
}

function parseChangeLine(line: string): CodexChange {
  if (line === "") return { kind: "context", text: "" };
  const c = line[0];
  if (c === " ") return { kind: "context", text: line.slice(1) };
  if (c === "-") return { kind: "del", text: line.slice(1) };
  if (c === "+") return { kind: "add", text: line.slice(1) };
  // Lenient: a change line missing its prefix is treated as context.
  return { kind: "context", text: line };
}

/**
 * Apply a file's hunks. Returns the new content and the matched line ranges in
 * the ORIGINAL file (for read-before-write). Throws if a hunk cannot be located.
 */
export function applyCodexUpdate(content: string, hunks: CodexHunk[]): { result: string; ranges: LineRange[] } {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();

  const ranges: LineRange[] = [];
  let cursor = 0;
  let delta = 0; // mutatedIndex - originalIndex

  for (const hunk of hunks) {
    const before = hunk.changes.filter((c) => c.kind !== "add").map((c) => c.text);
    const after = hunk.changes.filter((c) => c.kind !== "del").map((c) => c.text);

    let from = cursor;
    if (hunk.header) {
      const h = findLine(lines, hunk.header, from);
      if (h >= 0) from = h;
    }

    let at: number;
    if (before.length === 0) {
      at = Math.min(from, lines.length); // pure insertion — no context to check
    } else {
      at = findBlock(lines, before, from);
      if (at < 0) throw new Error(`Could not locate context for hunk${hunk.header ? ` "@@ ${hunk.header}"` : ""}.`);
      ranges.push({ startLine: at - delta + 1, endLine: at - delta + before.length });
    }

    lines.splice(at, before.length, ...after);
    cursor = at + after.length;
    delta += after.length - before.length;
  }

  let result = lines.join("\n");
  if (hadTrailingNewline) result += "\n";
  return { result, ranges };
}

function findLine(lines: string[], header: string, from: number): number {
  const needle = header.trim();
  const order = [...range(from, lines.length), ...range(0, from)];
  for (const i of order) {
    if (lines[i].trim() === needle || lines[i].includes(header)) return i;
  }
  return -1;
}

type MatchMode = "exact" | "rstrip" | "strip";

function findBlock(lines: string[], before: string[], from: number): number {
  const modes: MatchMode[] = ["exact", "rstrip", "strip"];
  for (const mode of modes) {
    for (let i = from; i + before.length <= lines.length; i++) {
      if (blockMatches(lines, before, i, mode)) return i;
    }
    for (let i = 0; i < from && i + before.length <= lines.length; i++) {
      if (blockMatches(lines, before, i, mode)) return i;
    }
  }
  return -1;
}

function blockMatches(lines: string[], before: string[], at: number, mode: MatchMode): boolean {
  for (let j = 0; j < before.length; j++) {
    if (!lineEquals(lines[at + j], before[j], mode)) return false;
  }
  return true;
}

function lineEquals(fileLine: string, patchLine: string, mode: MatchMode): boolean {
  if (mode === "exact") return fileLine === patchLine;
  if (mode === "rstrip") return fileLine.replace(/\s+$/, "") === patchLine.replace(/\s+$/, "");
  return fileLine.trim() === patchLine.trim();
}

function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

export function codexPatchMetadata(actions: CodexAction[]): Array<{
  path: string;
  operation: "create" | "modify" | "delete";
  additions: number;
  deletions: number;
}> {
  return actions.map((action) => {
    if (action.type === "add") return { path: action.path, operation: "create", additions: action.lines.length, deletions: 0 };
    if (action.type === "delete") return { path: action.path, operation: "delete", additions: 0, deletions: 0 };
    let additions = 0;
    let deletions = 0;
    for (const hunk of action.hunks) {
      for (const change of hunk.changes) {
        if (change.kind === "add") additions++;
        else if (change.kind === "del") deletions++;
      }
    }
    return { path: action.movePath ?? action.path, operation: "modify", additions, deletions };
  });
}
