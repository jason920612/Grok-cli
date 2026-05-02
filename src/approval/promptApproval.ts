import { input, select } from "@inquirer/prompts";
import chalk from "chalk";
import type { CommandRisk } from "./RiskClassifier.js";

export type ApprovalPromptDecision =
  | { approved: true; rememberSimilar: boolean }
  | { approved: false; rememberSimilar: false; guidance?: string };

export async function promptApproval(command: string, reason: string, risk: CommandRisk): Promise<ApprovalPromptDecision> {
  console.log(chalk.yellow("Approval required"));
  console.log(`Command: ${command}`);
  console.log(`Reason: ${reason}`);
  console.log(`Risk: ${risk}`);
  if (risk === "global_environment_change") {
    console.log("This may modify global tools, shell profiles, PATH, package managers, or system-level runtime state.");
    console.log("Project-local setup was not sufficient or was not selected by the model.");
    console.log("Rollback depends on the package manager or file changed.");
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      approved: false,
      rememberSimilar: false,
      guidance: "Approval requires an interactive terminal. Use a safer approach or rerun in interactive mode."
    };
  }
  const choice = await select({
    message: "Choose how to handle this request",
    choices: [
      {
        name: "Allow this time",
        value: "allow_once",
        description: "Run this exact request once."
      },
      {
        name: "Allow and remember similar requests",
        value: "allow_similar",
        description: "Run this request and auto-approve similar requests in this session."
      },
      {
        name: "No, use another approach",
        value: "deny_with_guidance",
        description: "Deny this request and tell the model what to try instead."
      }
    ]
  });
  if (choice === "allow_once") return { approved: true, rememberSimilar: false };
  if (choice === "allow_similar") return { approved: true, rememberSimilar: true };
  const guidance = await input({
    message: "What should the model do instead?",
    default: "Use a safer project-local approach that does not require this approval."
  });
  return { approved: false, rememberSimilar: false, guidance };
}
