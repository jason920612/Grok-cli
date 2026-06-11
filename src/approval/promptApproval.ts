import { input } from "@inquirer/prompts";
import chalk from "chalk";
import type { CommandRisk } from "./RiskClassifier.js";
import { mouseSelect } from "../ui/mouseSelect.js";

export type ApprovalPromptDetails = {
  operation?: string;
  policy?: string;
  scope?: string;
  rememberKey?: string;
  files?: Array<{
    path: string;
    operation: "create" | "modify" | "delete";
    additions: number;
    deletions: number;
  }>;
};

export type ApprovalPromptDecision =
  | { approved: true; rememberSimilar: boolean }
  | { approved: false; rememberSimilar: false; guidance?: string };

export async function promptApproval(command: string, reason: string, risk: CommandRisk, details: ApprovalPromptDetails = {}): Promise<ApprovalPromptDecision> {
  console.log(formatApprovalPrompt(command, reason, risk, details));
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      approved: false,
      rememberSimilar: false,
      guidance: "Approval requires an interactive terminal. Use a safer approach or rerun in interactive mode."
    };
  }
  const choice = await mouseSelect("Approve this operation? (click or arrows + Enter)", [
    {
      name: "Yes, allow this time",
      value: "allow_once",
      description: "Approve only this exact operation."
    },
    {
      name: "Yes, and remember similar",
      value: "allow_similar",
      description: "Approve now and auto-approve the displayed operation type in this session."
    },
    {
      name: "No, tell the model what to do instead",
      value: "deny_with_guidance",
      description: "Deny this request and tell the model what to try instead."
    }
  ]);
  if (choice === "allow_once") return { approved: true, rememberSimilar: false };
  if (choice === "allow_similar") return { approved: true, rememberSimilar: true };
  if (choice === null) {
    // Esc/cancel — deny cleanly without forcing the user to type guidance.
    return { approved: false, rememberSimilar: false, guidance: "User dismissed the approval prompt. Use a safer project-local approach that does not require this approval." };
  }
  const guidance = await input({
    message: "What should the model do instead?",
    default: "Use a safer project-local approach that does not require this approval."
  });
  return { approved: false, rememberSimilar: false, guidance };
}

export function formatApprovalPrompt(command: string, reason: string, risk: CommandRisk, details: ApprovalPromptDetails = {}): string {
  const lines = [
    chalk.yellow.bold("Approval required"),
    `${chalk.bold("Operation:")} ${details.operation ?? riskLabel(risk)}`,
    `${chalk.bold("Request:")} ${command}`,
    `${chalk.bold("Reason:")} ${reason}`,
    `${chalk.bold("Risk:")} ${riskLabel(risk)}`
  ];

  if (details.scope) lines.push(`${chalk.bold("Scope:")} ${details.scope}`);
  if (details.policy) lines.push(`${chalk.bold("Policy:")} ${details.policy}`);
  if (details.rememberKey) lines.push(`${chalk.bold("Remember rule:")} ${details.rememberKey}`);

  const impact = riskImpact(risk);
  if (impact) lines.push(`${chalk.bold("Impact:")} ${impact}`);

  if (details.files?.length) {
    lines.push(chalk.bold("Files:"));
    for (const file of details.files.slice(0, 8)) {
      lines.push(`  ${file.operation.padEnd(6)} ${file.path} (+${file.additions}/-${file.deletions})`);
    }
    if (details.files.length > 8) lines.push(`  ... ${details.files.length - 8} more`);
  }

  return lines.join("\n");
}

function riskLabel(risk: CommandRisk): string {
  return {
    safe: "safe local operation",
    ask: "approval-required operation",
    deny: "blocked operation",
    global_environment_change: "global environment change",
    destructive: "destructive operation",
    network: "network or dependency operation",
    background: "background process"
  }[risk];
}

function riskImpact(risk: CommandRisk): string | undefined {
  return {
    safe: undefined,
    ask: "This is outside the default safe set and needs your decision before it runs.",
    deny: "This operation is blocked by policy.",
    destructive: "This may delete or overwrite data and is blocked by policy.",
    network: "This may download code or modify local dependencies.",
    background: "This starts a long-running process that may continue until stopped.",
    global_environment_change: "This may modify global tools, shell profiles, PATH, package managers, or system-level runtime state."
  }[risk];
}
