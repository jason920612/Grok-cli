import readline from "node:readline";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { SLASH_COMMANDS } from "./slashCommands.js";

export async function readInteractiveLine(prompt = "grok-code>"): Promise<string> {
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
      clearPromptAndMenu();
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write("\n");
      resolve(value);
    };

    const matches = () => {
      if (!buffer.startsWith("/")) return [];
      const [commandPart] = buffer.split(/\s+/, 1);
      const needle = commandPart.toLowerCase();
      return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(needle)).slice(0, 10);
    };

    const clearPromptAndMenu = () => {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
    };

    const render = () => {
      clearPromptAndMenu();
      process.stdout.write(`${chalk.green(prompt)} ${buffer}`);
      const list = matches();
      if (list.length > 0) {
        selected = Math.min(selected, list.length - 1);
        process.stdout.write("\n");
        for (let i = 0; i < list.length; i += 1) {
          const cmd = list[i]!;
          const prefix = i === selected ? chalk.cyan(">") : " ";
          const name = i === selected ? chalk.cyan(cmd.usage) : cmd.usage;
          process.stdout.write(`${prefix} ${name} ${chalk.dim(cmd.description)}\n`);
        }
        readline.moveCursor(process.stdout, 0, -(list.length + 1));
        readline.cursorTo(process.stdout, `${prompt} ${buffer}`.length);
      }
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
    render();
  });
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
