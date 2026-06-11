import chalk from "chalk";
import { createRequire } from "node:module";
import type { GrokCodeConfig } from "../config/loadConfig.js";

let cachedVersion: string | undefined;
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const require = createRequire(import.meta.url);
    cachedVersion = (require("../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    cachedVersion = "0.0.0";
  }
  return cachedVersion;
}

export function printHeader(config: GrokCodeConfig, opts: { multiAgent?: boolean } = {}): void {
  const mode = opts.multiAgent ? chalk.magenta("multi-agent ⚡") : "single agent";
  console.log(`${chalk.bold.cyan("grok-code")} ${chalk.dim(`v${packageVersion()}`)}`);
  console.log(chalk.dim(`${config.model} · xAI · ${mode} · approval ${config.approval}`));
  console.log(chalk.dim(config.workspaceRoot));
}

export function formatSessionStatus(config: GrokCodeConfig): string {
  return [
    `model:        ${config.model}`,
    `provider:     xAI`,
    `workspace:    ${config.workspaceRoot}`,
    `trusted:      ${config.workspaceTrusted ? "yes" : "no"}`,
    `approval:     ${config.approval}`,
    `profile:      ${config.sandboxProfile}`,
    `tool choice:  ${config.toolChoice}`,
    `max steps:    ${config.maxSteps}`,
    `web search:   ${config.serverTools && config.enableWebSearch ? "enabled" : "disabled"}`,
    `x search:     ${config.serverTools && config.enableXSearch ? "enabled" : "disabled"}`
  ].join("\n");
}

export function printError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(chalk.red(message));
}
