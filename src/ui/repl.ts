import chalk from "chalk";
import { select } from "@inquirer/prompts";
import type { Agent } from "../agent/Agent.js";
import { formatContext } from "./formatters.js";
import { PROJECT_UNDERSTANDING_TASK } from "../agent/projectUnderstandingTask.js";
import { colorDiff } from "./diffView.js";
import { readInteractiveLine, runWithEscInterrupt } from "./interactiveInput.js";
import { visibleSlashCommands } from "./slashCommands.js";
import type { ApprovalMode } from "../config/loadConfig.js";
import { formatSessionStatus } from "./terminal.js";
import { chooseWorkspace, formatWorkspaceTrustStatus, manageWorkspaceTrust } from "./workspaceTrust.js";

type ReplOptions = {
  switchWorkspace?: (workspace: string) => Promise<Agent>;
};

export async function startRepl(initialAgent: Agent, options: ReplOptions = {}): Promise<Agent> {
  let agent = initialAgent;
  console.log(chalk.dim("Type /help for commands, /exit to quit."));
  for (;;) {
    const line = await readInteractiveLine("grok-code>");
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit") break;
    if (text.startsWith("/")) {
      const nextAgent = await handleSlash(text, agent, options);
      if (nextAgent) agent = nextAgent;
      continue;
    }
    try {
      console.log(await runWithEscInterrupt((signal) => agent.run(text, false, signal)));
    } catch (error) {
      console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
    }
  }
  return agent;
}

async function handleSlash(command: string, agent: Agent, options: ReplOptions): Promise<Agent | void> {
  const [name, ...rest] = command.split(/\s+/);
  switch (name) {
    case "/help":
      console.log(visibleSlashCommands().map((cmd) => `${cmd.usage.padEnd(24)} ${cmd.description}`).join("\n"));
      break;
    case "/status":
      console.log([formatSessionStatus(agent.config), formatWorkspaceTrustStatus(agent.config.workspaceRoot)].join("\n"));
      break;
    case "/cd":
    case "/workspace":
    case "/change-dir": {
      if (!options.switchWorkspace) {
        console.log("Workspace switching is unavailable in this session.");
        break;
      }
      const workspace = await chooseWorkspace(agent.config.workspaceRoot);
      if (!workspace) {
        console.log("Workspace unchanged.");
        break;
      }
      await agent.background.stopAll("workspace switch cleanup");
      const nextAgent = await options.switchWorkspace(workspace);
      console.log(`Workspace switched to ${nextAgent.config.workspaceRoot}`);
      return nextAgent;
    }
    case "/trust":
    case "/trust-settings":
    case "/workspace-trust":
      console.log(await manageWorkspaceTrust(agent.config.workspaceRoot));
      break;
    case "/git-status":
      console.log(JSON.stringify(await agent.tools.execute("git_status", {}, agent.toolContext()), null, 2));
      break;
    case "/diff":
      console.log(formatDiffResult(await agent.tools.execute("git_diff", {}, agent.toolContext())));
      break;
    case "/approval":
      console.log(await chooseApproval(agent, rest[0]));
      break;
    case "/context":
      console.log(formatContext(agent.context.list()));
      break;
    case "/compact":
      console.log(agent.context.compactContext("interactive session").content);
      break;
    case "/learn-project":
      console.log(await runWithEscInterrupt((signal) => agent.run(PROJECT_UNDERSTANDING_TASK, false, signal)));
      break;
    case "/skills":
      console.log(formatSkills(agent));
      break;
    case "/tools":
      console.log(agent.toolSkills.toolIndex());
      break;
    case "/env":
      console.log(JSON.stringify(await agent.tools.execute("inspect_environment", { includeVersions: true }, agent.toolContext()), null, 2));
      break;
    case "/bg":
      console.log(JSON.stringify(agent.background.list(), null, 2));
      break;
    case "/bg-stop":
      console.log(JSON.stringify(await agent.tools.execute("stop_background_command", { id: rest[0], reason: "user slash command" }, agent.toolContext()), null, 2));
      break;
    case "/bg-stop-all":
      console.log(JSON.stringify(await agent.tools.execute("stop_all_background_commands", { reason: "user slash command" }, agent.toolContext()), null, 2));
      break;
    case "/drop":
      console.log(agent.context.drop(rest[0] ?? "") ? "dropped" : "not dropped");
      break;
    case "/clear":
      agent.context.compactContext("cleared interactive context");
      console.log("context compacted");
      break;
    case "/resume":
      console.log("Use `grok-code resume [session-id]` from the shell.");
      break;
    case "/model":
      console.log("Model changes apply to new CLI invocations in this MVP.");
      break;
    default:
      console.log(`Unknown command: ${name}`);
  }
}

async function chooseApproval(agent: Agent, requestedMode?: string): Promise<string> {
  const modes: ApprovalMode[] = ["on-request", "auto-local", "auto-safe", "auto-all", "never"];
  if (requestedMode) {
    if (!modes.includes(requestedMode as ApprovalMode)) {
      return `Unknown approval mode: ${requestedMode}\nUse one of: ${modes.join(", ")}`;
    }
    return setApproval(agent, requestedMode as ApprovalMode);
  }

  const mode = await select<ApprovalMode>({
    message: `Approval mode (current: ${agent.approval.mode})`,
    choices: modes.map((mode) => ({
      name: `${mode} - ${approvalDescription(mode)}`,
      value: mode
    })),
    default: agent.approval.mode
  });
  return setApproval(agent, mode);
}

function setApproval(agent: Agent, mode: ApprovalMode): string {
  agent.approval.setMode(mode);
  agent.config.approval = mode;
  return `Approval mode set to ${mode}: ${approvalDescription(mode)}`;
}

export function approvalDescription(mode: ApprovalMode): string {
  return {
    "on-request": "Default. Auto-allow workspace file edits and safe local commands; ask for riskier commands.",
    "auto-local": "Auto-allow operations scoped to this workspace/local environment; still asks for global environment changes.",
    "auto-safe": "Auto-allow only safe commands and local patch edits; ask for network/install/unknown commands.",
    "auto-all": "Auto-allow model-requested operations except commands that are hard-denied by the safety policy.",
    never: "Deny approval-required operations."
  }[mode];
}

function formatSkills(agent: Agent): string {
  const active = agent.skillLoader.select("interactive session");
  const activeIds = new Set(active.map((skill) => skill.id));
  const available = agent.skillLoader.loadAll().filter((skill) => !activeIds.has(skill.id));
  const format = (items: typeof active) => items.map((skill) => `- ${skill.id}: ${skill.description}`).join("\n") || "- none";
  return [
    chalk.bold("Loaded for the current interactive baseline:"),
    format(active),
    "",
    chalk.bold("Available to load when triggered:"),
    format(available)
  ].join("\n");
}

function formatDiffResult(result: unknown): string {
  if (typeof result === "object" && result !== null && "ok" in result && (result as any).ok && "data" in result) {
    const data = (result as any).data;
    if (data && typeof data.stat === "string" && typeof data.diff === "string") {
      const text = [`git diff --stat`, data.stat, `git diff`, data.diff].filter(Boolean).join("\n");
      return colorDiff(text);
    }
  }
  return JSON.stringify(result, null, 2);
}
