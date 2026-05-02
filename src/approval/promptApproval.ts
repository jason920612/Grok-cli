import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type { CommandRisk } from "./RiskClassifier.js";

export async function promptApproval(command: string, reason: string, risk: CommandRisk): Promise<boolean> {
  console.log(chalk.yellow("Approval required"));
  console.log(`Command: ${command}`);
  console.log(`Reason: ${reason}`);
  console.log(`Risk: ${risk}`);
  if (risk === "global_environment_change") {
    console.log("This may modify global tools, shell profiles, PATH, package managers, or system-level runtime state.");
    console.log("Project-local setup was not sufficient or was not selected by the model.");
    console.log("Rollback depends on the package manager or file changed.");
  }
  return confirm({ message: "Allow this action?", default: false });
}
