import readline from "node:readline";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { visibleSlashCommands } from "./slashCommands.js";

export type TranscriptEntry = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type InteractiveLineOptions = {
  /** Shared command history (newest-first), persisted across prompts for up/down recall. */
  history?: string[];
};

/**
 * Read one line of input.
 *
 * Uses Node's readline line editor, which gives correct cursor positioning and
 * in-line editing, repaints only the input line (no flicker), keeps history,
 * and — by staying in normal line mode rather than a full-screen raw capture —
 * leaves the terminal's native mouse (scroll/select) working. Slash commands
 * tab-complete via the completer.
 */
export async function readInteractiveLine(prompt = "grok-code>", options: InteractiveLineOptions = {}): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return input({ message: prompt });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
    completer: slashCompleter
  });
  if (options.history) {
    // Share the history array so up/down recall works across prompts.
    (rl as unknown as { history: string[] }).history = options.history;
  }
  rl.setPrompt(`${chalk.green(prompt)} `);

  return new Promise<string>((resolve) => {
    const finish = (value: string) => {
      rl.close();
      resolve(value);
    };
    rl.prompt();
    rl.on("line", (line) => finish(line));
    rl.on("SIGINT", () => {
      process.stdout.write("\n");
      finish("/exit");
    });
  });
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

export async function runWithEscInterrupt<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (!process.stdin.isTTY) {
    return work(new AbortController().signal);
  }
  const controller = new AbortController();
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write(chalk.dim("Press Esc to interrupt the running request.\n"));
  const onKeypress = (_str: string, key: readline.Key) => {
    if (key.name === "escape") controller.abort();
  };
  process.stdin.on("keypress", onKeypress);
  try {
    return await work(controller.signal);
  } finally {
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(wasRaw);
  }
}
