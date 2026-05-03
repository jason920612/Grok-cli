import chalk from "chalk";
import type { GrokCodeConfig } from "../config/loadConfig.js";

export function printHeader(model: string, workspace: string): void {
  console.log(chalk.bold("grok-code"));
  console.log(chalk.dim(`model ${model} | workspace ${workspace}`));
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
