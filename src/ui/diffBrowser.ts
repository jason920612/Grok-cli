import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";

/**
 * Interactive, full-screen diff browser.
 *
 * The REPL stays line-based (readline), but viewing changes opens this as a
 * temporary alternate-screen overlay: changed files are listed collapsed, and
 * you expand/collapse each one's diff by clicking it (mouse) or pressing
 * space/enter. Quitting (q/Esc) tears down the overlay and restores the normal
 * scrollback untouched. The pure parts (parse / layout / render) are separated
 * from the IO loop so they can be unit-tested.
 */

export type FileDiff = {
  path: string;
  status: "A" | "M" | "D" | "R" | "?";
  additions: number;
  deletions: number;
  body: string;
};

type Entry = FileDiff & { expanded: boolean };
type BrowserState = { entries: Entry[]; selected: number; scroll: number };
type Row = { entry: number; header: boolean; text: string };

const STATUS_LABEL: Record<FileDiff["status"], string> = { A: "A", M: "M", D: "D", R: "R", "?": "?" };

/** Parse `git diff` text into one entry per file. */
export function parseGitDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  const sections = diffText.split(/^diff --git .*$/m).slice(1);
  const headers = [...diffText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  sections.forEach((section, i) => {
    const lines = section.split(/\r?\n/);
    const headerPath = headers[i]?.[2] ?? "(unknown)";
    let status: FileDiff["status"] = "M";
    if (/^new file mode/m.test(section)) status = "A";
    else if (/^deleted file mode/m.test(section)) status = "D";
    else if (/^rename (from|to) /m.test(section)) status = "R";
    let additions = 0;
    let deletions = 0;
    const bodyLines: string[] = [];
    let inHunk = false;
    for (const line of lines) {
      if (line.startsWith("@@")) inHunk = true;
      if (inHunk) bodyLines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    files.push({
      path: headerPath,
      status,
      additions,
      deletions,
      body: bodyLines.join("\n").trim() || "(no textual diff — binary or mode change)"
    });
  });
  return files;
}

/** Collect working-tree changes vs HEAD plus untracked files, for a git repo. */
export function collectWorkingTreeDiff(root: string): FileDiff[] {
  if (!git(["rev-parse", "--is-inside-work-tree"], root).ok) return [];
  const tracked = parseGitDiff(git(["-c", "core.quotepath=false", "diff", "--no-color", "HEAD"], root).stdout);
  const untrackedList = git(["ls-files", "--others", "--exclude-standard"], root).stdout.split(/\r?\n/).filter(Boolean);
  const untracked: FileDiff[] = [];
  for (const rel of untrackedList) {
    const abs = path.join(root, rel);
    let content = "";
    try {
      if (fs.statSync(abs).size > 256 * 1024) {
        untracked.push({ path: rel, status: "A", additions: 0, deletions: 0, body: "(new file too large to preview)" });
        continue;
      }
      content = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    untracked.push({
      path: rel,
      status: "A",
      additions: lines.length,
      deletions: 0,
      body: `@@ new file @@\n${lines.map((l) => `+${l}`).join("\n")}`
    });
  }
  return [...tracked, ...untracked].sort((a, b) => a.path.localeCompare(b.path));
}

function headerLine(entry: Entry, selected: boolean): string {
  const caret = entry.expanded ? "▼" : "▶";
  const counts = `${chalk.green(`+${entry.additions}`)}/${chalk.red(`-${entry.deletions}`)}`;
  const label = `${caret} ${STATUS_LABEL[entry.status]} ${entry.path}  (${counts})`;
  return selected ? chalk.inverse(label) : label;
}

/** Flatten the state into renderable rows, each tagged with its owning entry. */
export function buildRows(state: BrowserState): Row[] {
  const rows: Row[] = [];
  state.entries.forEach((entry, i) => {
    rows.push({ entry: i, header: true, text: headerLine(entry, i === state.selected) });
    if (entry.expanded) {
      for (const line of colorBody(entry.body).split("\n")) rows.push({ entry: i, header: false, text: `  ${line}` });
      rows.push({ entry: i, header: false, text: "" });
    }
  });
  return rows;
}

function colorBody(diff: string): string {
  return diff
    .split(/\r?\n/)
    .map((line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) return chalk.green(line);
      if (line.startsWith("-") && !line.startsWith("---")) return chalk.red(line);
      if (line.startsWith("@@")) return chalk.cyan(line);
      return chalk.dim(line);
    })
    .join("\n");
}

/** Render the full screen frame (title + visible rows + footer) to a string. */
export function renderFrame(state: BrowserState, _width: number, height: number): string {
  const rows = buildRows(state);
  const viewport = Math.max(1, height - 2);
  const visible = rows.slice(state.scroll, state.scroll + viewport);
  const totalAdd = state.entries.reduce((n, e) => n + e.additions, 0);
  const totalDel = state.entries.reduce((n, e) => n + e.deletions, 0);
  const title = chalk.bold(`Changes — ${state.entries.length} file(s), ${chalk.green(`+${totalAdd}`)}/${chalk.red(`-${totalDel}`)}`);
  const footer = chalk.dim("↑/↓ move · space/enter or click to expand · q to close");
  const bodyLines = visible.map((r) => r.text);
  while (bodyLines.length < viewport) bodyLines.push("");
  return [title, ...bodyLines, footer].join("\r\n");
}

/** Plain (non-interactive) fallback rendering. */
export function renderPlain(files: FileDiff[]): string {
  if (files.length === 0) return "No changes in the working tree.";
  return files
    .map((f) => `${STATUS_LABEL[f.status]} ${f.path}  (+${f.additions}/-${f.deletions})\n${colorBody(f.body)}`)
    .join("\n\n");
}

/** Compact one-line-per-file summary for inline display after a task. */
export function summarizeChanges(files: FileDiff[]): string {
  if (files.length === 0) return "";
  const list = files
    .slice(0, 12)
    .map((f, i) => `  ${i + 1}) ${STATUS_LABEL[f.status]} ${f.path} ${chalk.green(`+${f.additions}`)}/${chalk.red(`-${f.deletions}`)}`)
    .join("\n");
  const more = files.length > 12 ? `\n  …and ${files.length - 12} more` : "";
  return `${chalk.bold(`Changed ${files.length} file(s)`)} ${chalk.dim("(/diff to view)")}:\n${list}${more}`;
}

type InputEvent =
  | { type: "quit" }
  | { type: "up" }
  | { type: "down" }
  | { type: "toggle" }
  | { type: "collapse" }
  | { type: "scroll"; delta: number }
  | { type: "click"; row: number }
  | { type: "none" };

/** Decode one raw stdin chunk into a browser event. */
export function parseInput(s: string): InputEvent {
  const mouse = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
  if (mouse) {
    const button = Number(mouse[1]);
    const row = Number(mouse[3]);
    const isPress = mouse[4] === "M";
    if (button === 64) return { type: "scroll", delta: -3 };
    if (button === 65) return { type: "scroll", delta: 3 };
    if (button === 0 && isPress) return { type: "click", row };
    return { type: "none" };
  }
  if (s === "\x1b[A" || s === "k") return { type: "up" };
  if (s === "\x1b[B" || s === "j") return { type: "down" };
  if (s === "\x1b[C" || s === " " || s === "\r" || s === "\n") return { type: "toggle" };
  if (s === "\x1b[D" || s === "h") return { type: "collapse" };
  if (s === "\x1b[5~") return { type: "scroll", delta: -5 };
  if (s === "\x1b[6~") return { type: "scroll", delta: 5 };
  if (s === "q" || s === "\x03" || s === "\x1b") return { type: "quit" };
  return { type: "none" };
}

function clampScrollToSelection(state: BrowserState, height: number): void {
  const rows = buildRows(state);
  const viewport = Math.max(1, height - 2);
  const headerRow = rows.findIndex((r) => r.header && r.entry === state.selected);
  if (headerRow < state.scroll) state.scroll = headerRow;
  else if (headerRow >= state.scroll + viewport) state.scroll = headerRow - viewport + 1;
  state.scroll = Math.max(0, Math.min(state.scroll, Math.max(0, rows.length - viewport)));
}

/** Open the interactive overlay. Falls back to plain print when not a TTY. */
export async function runDiffBrowser(files: FileDiff[]): Promise<void> {
  if (files.length === 0) {
    console.log("No changes in the working tree.");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(renderPlain(files));
    return;
  }
  const state: BrowserState = { entries: files.map((f) => ({ ...f, expanded: false })), selected: 0, scroll: 0 };
  const out = process.stdout;
  const wasRaw = Boolean(process.stdin.isRaw);
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h");
  try {
    process.stdin.setRawMode(true);
  } catch {
    /* ignore */
  }
  process.stdin.resume();

  const height = () => out.rows ?? 24;
  const draw = () => out.write(`\x1b[2J\x1b[H${renderFrame(state, out.columns ?? 80, height())}`);

  return new Promise<void>((resolve) => {
    const finish = () => {
      process.stdin.off("data", onData);
      out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
      try {
        process.stdin.setRawMode(wasRaw);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
      resolve();
    };
    const onData = (buf: Buffer) => {
      const ev = parseInput(buf.toString("utf8"));
      switch (ev.type) {
        case "quit":
          finish();
          return;
        case "up":
          state.selected = Math.max(0, state.selected - 1);
          break;
        case "down":
          state.selected = Math.min(state.entries.length - 1, state.selected + 1);
          break;
        case "toggle":
          state.entries[state.selected].expanded = !state.entries[state.selected].expanded;
          break;
        case "collapse":
          state.entries[state.selected].expanded = false;
          break;
        case "scroll":
          state.scroll = Math.max(0, state.scroll + ev.delta);
          draw();
          return;
        case "click": {
          const rows = buildRows(state);
          const idx = state.scroll + (ev.row - 1 - 1); // -1 screen→0-based, -1 title line
          const target = rows[idx];
          if (target) {
            state.selected = target.entry;
            state.entries[target.entry].expanded = !state.entries[target.entry].expanded;
          }
          break;
        }
        default:
          return;
      }
      clampScrollToSelection(state, height());
      draw();
    };
    process.stdin.on("data", onData);
    draw();
  });
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    return { ok: true, stdout };
  } catch (error: any) {
    return { ok: false, stdout: error?.stdout?.toString() ?? "" };
  }
}
