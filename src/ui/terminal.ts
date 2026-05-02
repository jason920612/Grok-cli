import chalk from "chalk";

export function printHeader(model: string, workspace: string): void {
  console.log(chalk.bold("grok-code"));
  console.log(chalk.dim(`model ${model} | workspace ${workspace}`));
}

export function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(message));
}
