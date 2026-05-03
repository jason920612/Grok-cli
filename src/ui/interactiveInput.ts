import readline from "node:readline";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { visibleSlashCommands } from "./slashCommands.js";
import type { SlashCommand } from "./slashCommands.js";

export type TranscriptEntry = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type InteractiveLineOptions = {
  transcript?: TranscriptEntry[];
};

export async function readInteractiveLine(prompt = "grok-code>", options: InteractiveLineOptions = {}): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return input({ message: prompt });
  }

  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve) => {
    let buffer = "";
    let selected = 0;

    const cleanup = (value: string) => {
      clearLayout();
      process.stdin.off("keypress", onKeypress);
      process.stdout.off("resize", render);
      process.stdin.setRawMode(wasRaw);
      resolve(value);
    };

    const matches = () => {
      if (!buffer.startsWith("/")) return [];
      const [commandPart] = buffer.split(/\s+/, 1);
      const needle = commandPart.toLowerCase();
      return visibleSlashCommands().filter((cmd) => cmd.name.startsWith(needle)).slice(0, 8);
    };

    const clearLayout = () => {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
    };

    const moveCursorToInput = () => {
      const rows = process.stdout.rows ?? 24;
      const cols = process.stdout.columns ?? 80;
      const suggestionLines = matches().length > 0 ? matches().length + 1 : 0;
      const transcriptHeight = Math.max(4, rows - suggestionLines - 5);
      const inputRow = Math.min(rows - 1, transcriptHeight + 2);
      readline.cursorTo(process.stdout, Math.min(`${prompt} ${buffer}`.length + 2, Math.max(2, cols - 2)), inputRow);
    };

    const render = () => {
      clearLayout();
      const list = matches();
      if (list.length > 0) {
        selected = Math.min(selected, list.length - 1);
      }
      process.stdout.write(
        buildInteractiveLayout({
          transcript: options.transcript ?? [],
          input: buffer,
          prompt,
          suggestions: list,
          selectedSuggestion: selected,
          columns: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24
        })
      );
      moveCursorToInput();
    };

    const acceptSelectedCommand = () => {
      const list = matches();
      if (list.length === 0) return false;
      const selectedCommand = list[selected]!;
      buffer = selectedCommand.name;
      return true;
    };

    const onKeypress = (str: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") cleanup("/exit");
      else if (key.name === "return") {
        if (buffer.startsWith("/") && matches().length > 0 && buffer.trim() !== matches()[selected]?.name) {
          acceptSelectedCommand();
        }
        cleanup(buffer);
      } else if (key.name === "escape") {
        buffer = "";
        selected = 0;
        render();
      } else if (key.name === "up") {
        const list = matches();
        if (list.length > 0) selected = (selected - 1 + list.length) % list.length;
        render();
      } else if (key.name === "down") {
        const list = matches();
        if (list.length > 0) selected = (selected + 1) % list.length;
        render();
      } else if (key.name === "tab") {
        acceptSelectedCommand();
        render();
      } else if (key.name === "backspace") {
        buffer = buffer.slice(0, -1);
        selected = 0;
        render();
      } else if (!key.ctrl && !key.meta && str && str >= " ") {
        buffer += str;
        selected = 0;
        render();
      }
    };

    process.stdin.on("keypress", onKeypress);
    process.stdout.on("resize", render);
    render();
  });
}

export function buildInteractiveLayout({
  transcript,
  input,
  prompt,
  suggestions,
  selectedSuggestion,
  columns,
  rows
}: {
  transcript: TranscriptEntry[];
  input: string;
  prompt: string;
  suggestions: SlashCommand[];
  selectedSuggestion: number;
  columns: number;
  rows: number;
}): string {
  const width = Math.max(32, columns);
  const suggestionLines = suggestions.length > 0 ? suggestions.length + 1 : 0;
  const transcriptHeight = Math.max(4, rows - suggestionLines - 5);
  const contentWidth = width - 2;
  const outputLines = transcript.flatMap((entry) => wrapLine(`${roleLabel(entry.role)}: ${entry.content}`, contentWidth - 2));
  const visibleOutput = outputLines.slice(-Math.max(1, transcriptHeight - 2));
  const paddedOutput = [...visibleOutput];
  while (paddedOutput.length < transcriptHeight - 2) paddedOutput.unshift("");

  const lines = [
    `┌${"─".repeat(width - 2)}┐`,
    ...paddedOutput.map((line) => `│ ${padOrTrim(line, contentWidth - 2)} │`),
    `└${"─".repeat(width - 2)}┘`,
    "",
    `╭${"─".repeat(width - 2)}╮`,
    `│ ${padOrTrim(`${prompt} ${input}`, contentWidth - 2)} │`,
    `╰${"─".repeat(width - 2)}╯`
  ];

  if (suggestions.length > 0) {
    lines.push("Commands:");
    suggestions.forEach((command, index) => {
      const marker = index === selectedSuggestion ? ">" : " ";
      const usage = command.usage.padEnd(16);
      lines.push(padOrTrim(`  ${marker} ${usage} ${command.description}`, width));
    });
  }

  return `${lines.slice(0, rows).join("\n")}`;
}

function roleLabel(role: TranscriptEntry["role"]): string {
  return {
    user: "User",
    assistant: "Assistant",
    system: "System"
  }[role];
}

function wrapLine(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const source = text.replace(/\r?\n/g, " ");
  const lines: string[] = [];
  for (let index = 0; index < source.length; index += width) {
    lines.push(source.slice(index, index + width));
  }
  return lines.length > 0 ? lines : [""];
}

function padOrTrim(text: string, width: number): string {
  if (text.length > width) return text.slice(0, Math.max(0, width - 1)) + "…";
  return text.padEnd(width);
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
