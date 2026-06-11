import { select as inquirerSelect } from "@inquirer/prompts";
import chalk from "chalk";

/**
 * Inline single-select prompt with mouse + keyboard support.
 *
 * Unlike the diff browser this renders inline (no alternate screen) because
 * approval / ask_user prompts appear mid-conversation and the surrounding
 * context must stay visible. You move with the arrow keys (or wheel) and pick
 * by pressing Enter or clicking a choice. It can run while another raw-mode
 * reader is active (e.g. the mid-task Esc/interject handler): it stashes the
 * other stdin listeners on entry and restores them on exit, so only one reader
 * touches stdin at a time. Falls back to the keyboard-only inquirer prompt when
 * stdin is not a TTY.
 */

export type SelectChoice = { name: string; value: string; description?: string };

export function renderChoiceLines(choices: SelectChoice[], selected: number): string[] {
  return choices.map((choice, i) => {
    const active = i === selected;
    const pointer = active ? chalk.cyan("❯ ") : "  ";
    const name = active ? chalk.cyan(choice.name) : choice.name;
    const desc = active && choice.description ? chalk.dim(`  — ${choice.description}`) : "";
    return `${pointer}${name}${desc}`;
  });
}

/** Map an absolute click row to a choice index (or -1 if outside the list). */
export function clickIndex(row: number, startRow: number, count: number): number {
  const idx = row - startRow;
  return idx >= 0 && idx < count ? idx : -1;
}

export async function mouseSelect(message: string, choices: SelectChoice[]): Promise<string | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return inquirerSelect({
      message,
      choices: choices.map((c) => ({ name: c.name, value: c.value, description: c.description }))
    });
  }

  const out = process.stdout;
  // Stash other stdin listeners (the keypress decoder + any Esc/interject
  // handlers) so they don't consume our bytes; restore them on exit.
  const stashedData = process.stdin.listeners("data") as Array<(...a: unknown[]) => void>;
  const stashedKeypress = process.stdin.listeners("keypress") as Array<(...a: unknown[]) => void>;
  for (const l of stashedData) process.stdin.off("data", l as never);
  for (const l of stashedKeypress) process.stdin.off("keypress", l as never);
  const wasRaw = Boolean(process.stdin.isRaw);
  try {
    process.stdin.setRawMode(true);
  } catch {
    /* ignore */
  }
  process.stdin.resume();

  console.log(chalk.bold(message));
  const startRow = await queryCursorRow();
  out.write("\x1b[?1000h\x1b[?1006h\x1b[?25l");

  let selected = 0;
  const draw = () => {
    out.write(`\x1b[${startRow};1H\x1b[J`);
    out.write(renderChoiceLines(choices, selected).join("\r\n"));
  };
  draw();

  return new Promise<string | null>((resolve) => {
    const finish = (value: string | null) => {
      process.stdin.off("data", onData);
      out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h");
      out.write(`\x1b[${startRow};1H\x1b[J`); // wipe the menu; caller prints the outcome
      try {
        process.stdin.setRawMode(wasRaw);
      } catch {
        /* ignore */
      }
      for (const l of stashedKeypress) process.stdin.on("keypress", l as never);
      for (const l of stashedData) process.stdin.on("data", l as never);
      if (!wasRaw) process.stdin.pause();
      resolve(value);
    };
    const onData = (buf: Buffer) => {
      const s = buf.toString("utf8");
      const mouse = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      if (mouse) {
        const button = Number(mouse[1]);
        const row = Number(mouse[3]);
        const press = mouse[4] === "M";
        if (button === 0 && press) {
          const idx = clickIndex(row, startRow, choices.length);
          if (idx >= 0) {
            selected = idx;
            finish(choices[idx].value);
          }
        } else if (button === 64) {
          selected = Math.max(0, selected - 1);
          draw();
        } else if (button === 65) {
          selected = Math.min(choices.length - 1, selected + 1);
          draw();
        }
        return;
      }
      if (s === "\x1b[A" || s === "k") {
        selected = Math.max(0, selected - 1);
        draw();
      } else if (s === "\x1b[B" || s === "j") {
        selected = Math.min(choices.length - 1, selected + 1);
        draw();
      } else if (s === "\r" || s === "\n") {
        finish(choices[selected].value);
      } else if (s === "\x03" || s === "\x1b" || s === "q") {
        finish(null);
      }
    };
    process.stdin.on("data", onData);
  });
}

/** Ask the terminal for the cursor row (DSR); fall back fast if it stays silent. */
function queryCursorRow(): Promise<number> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (row: number) => {
      if (settled) return;
      settled = true;
      process.stdin.off("data", onData);
      clearTimeout(timer);
      resolve(row);
    };
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const m = /\x1b\[(\d+);(\d+)R/.exec(buf);
      if (m) done(Number(m[1]));
    };
    const timer = setTimeout(() => done(Math.max(1, (process.stdout.rows ?? 24) - 1)), 250);
    process.stdin.on("data", onData);
    process.stdout.write("\x1b[6n");
  });
}
