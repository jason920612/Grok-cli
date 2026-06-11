import readline from "node:readline";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { visibleSlashCommands } from "./slashCommands.js";

export type TranscriptEntry = {
  role: "user" | "assistant" | "system";
  content: string;
};

/**
 * Persistent line reader for the interactive REPL.
 *
 * A single readline interface lives for the whole session (created lazily,
 * closed on exit) instead of being rebuilt for every prompt. Rebuilding per
 * line left stdin in an inconsistent flowing/raw state between prompts on
 * Windows Terminal, which swallowed the first Enter of the next line and kept
 * the event loop alive after exit (process hung until Ctrl+C).
 *
 * One invariant fixes both: while we are reading a line we own stdin (raw line
 * editing, resumed, buffer cleared); the rest of the time stdin is "parked"
 * (paused, cooked). Long tasks (runWithEscInterrupt) and inquirer menus each
 * take stdin only while we are parked, so no two readers fight over it.
 */
export class ReplInput {
  private rl: readline.Interface | null = null;
  private readonly fallback: boolean;

  constructor(private readonly history: string[] = []) {
    this.fallback = !process.stdin.isTTY || !process.stdout.isTTY;
  }

  private ensure(): readline.Interface {
    if (this.rl) return this.rl;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 200,
      completer: slashCompleter
    });
    // Share the history array so up/down recall works across prompts.
    (rl as unknown as { history: string[] }).history = this.history;
    this.rl = rl;
    return rl;
  }

  /** Read one line. Reclaims stdin in raw mode and clears any stray buffer first. */
  async readLine(prompt = "grok-code>"): Promise<string> {
    if (this.fallback) return input({ message: prompt });
    const rl = this.ensure();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* not all TTYs support raw mode */
      }
    }
    // Drop anything another reader (a finished task or inquirer menu) may have
    // left in the line buffer, so the next keystroke is the start of the line.
    const editable = rl as unknown as { line: string; cursor: number };
    editable.line = "";
    editable.cursor = 0;
    process.stdin.resume();

    return new Promise<string>((resolve) => {
      const done = (value: string) => {
        rl.removeListener("SIGINT", onSigint);
        this.park();
        resolve(value);
      };
      const onSigint = () => {
        process.stdout.write("\n");
        done("/exit");
      };
      rl.once("SIGINT", onSigint);
      rl.question(`${chalk.green(prompt)} `, (answer) => done(answer));
    });
  }

  /**
   * Run a long task while watching for Esc to abort it (and optionally capturing
   * typed interjection lines). The line reader is torn down for the duration so
   * it can't process keystrokes; the next readLine() builds a fresh interface.
   */
  async runWithEscInterrupt<T>(
    work: (signal: AbortSignal) => Promise<T>,
    opts: { onInterject?: (text: string) => void } = {}
  ): Promise<T> {
    if (this.fallback) return work(new AbortController().signal);
    const controller = new AbortController();
    // Fully tear down the line reader for the duration of the task. If it merely
    // stayed paused, readline would keep processing keystrokes (we resume stdin
    // here for Esc/interject) and leave its line state dirty, so the next prompt
    // swallows its first Enter. With no interface alive, only our raw handler
    // reads stdin; the next readLine() builds a fresh, clean interface.
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    readline.emitKeypressEvents(process.stdin);
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* not all TTYs support raw mode */
    }
    process.stdin.resume();
    process.stdout.write(
      chalk.dim(
        opts.onInterject
          ? "Esc/Ctrl+C interrupts · type a message + Enter to send it to the agent mid-task.\n"
          : "Press Esc or Ctrl+C to interrupt the running request.\n"
      )
    );
    let buffer = "";
    const onKeypress = (str: string, key: readline.Key) => {
      // Raw mode suppresses the automatic SIGINT, so handle Ctrl+C here too —
      // a graceful abort instead of an abrupt exit 130 mid-task.
      if (key && (key.name === "escape" || (key.ctrl && key.name === "c"))) {
        controller.abort();
        return;
      }
      if (!opts.onInterject) return;
      if (key && (key.name === "return" || key.name === "enter")) {
        const text = buffer;
        buffer = "";
        process.stdout.write("\n");
        if (text.trim()) opts.onInterject(text);
        return;
      }
      if (key && key.name === "backspace") {
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write("\b \b");
        }
        return;
      }
      // Accumulate + echo printable characters as the user types an interjection.
      if (str && !key?.ctrl && !key?.meta && str >= " ") {
        buffer += str;
        process.stdout.write(str);
      }
    };
    process.stdin.on("keypress", onKeypress);
    try {
      return await work(controller.signal);
    } finally {
      process.stdin.off("keypress", onKeypress);
      this.park();
    }
  }

  /**
   * Park stdin between reads: pause the reader and the stream, drop raw mode.
   * Whatever reads next (readLine, an inquirer menu, runWithEscInterrupt)
   * resumes it explicitly, so only one reader is ever live at a time.
   */
  private park(): void {
    if (this.rl) this.rl.pause();
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* not all TTYs support raw mode */
      }
    }
    process.stdin.pause();
  }

  /**
   * Final teardown when the REPL loop ends. Closes the interface and removes the
   * keypress decoder so the resumed/raw terminal stream no longer keeps the
   * event loop alive — otherwise the process hangs after exit until Ctrl+C.
   */
  close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* not all TTYs support raw mode */
      }
    }
    // Remove both the keypress consumers AND the 'data' keypress decoder that
    // emitKeypressEvents installs (a 'data' listener keeps the stream flowing /
    // the event loop alive). unref() is the belt-and-suspenders guarantee that a
    // lingering stdin handle never blocks process exit.
    process.stdin.removeAllListeners("keypress");
    process.stdin.removeAllListeners("data");
    process.stdin.pause();
    process.stdin.unref?.();
  }
}

function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const [cmd] = line.split(/\s+/, 1);
  const needle = cmd.toLowerCase();
  const hits = visibleSlashCommands()
    .map((c) => c.name)
    .filter((name) => name.startsWith(needle));
  return [hits, cmd];
}
