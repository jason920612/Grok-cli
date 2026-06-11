import chalk from "chalk";
import { randomUUID } from "node:crypto";
import { select, input } from "@inquirer/prompts";
import type { Agent } from "../agent/Agent.js";
import { Orchestrator } from "../agents/Orchestrator.js";
import { formatTotals } from "../agent/SessionUsage.js";
import { Interjections } from "../agent/Interjections.js";
import { formatContext } from "./formatters.js";
import { PROJECT_UNDERSTANDING_TASK } from "../agent/projectUnderstandingTask.js";
import { colorDiff } from "./diffView.js";
import { ReplInput, type TranscriptEntry } from "./interactiveInput.js";
import { visibleSlashCommands } from "./slashCommands.js";
import type { ApprovalMode } from "../config/loadConfig.js";
import { formatSessionStatus } from "./terminal.js";
import { chooseWorkspace, formatWorkspaceTrustStatus, manageWorkspaceTrust } from "./workspaceTrust.js";

type ReplOptions = {
  switchWorkspace?: (workspace: string) => Promise<Agent>;
  multiAgentDefault?: boolean;
};

/** Interactive scoping questions (scoping-v1 §6). Asks the user in the REPL. */
function attachAskUser(agent: Agent): void {
  agent.askUser = async (questions) => {
    const answers: Array<{ question: string; answer: string }> = [];
    for (const q of questions) {
      console.log(chalk.cyan(q.question));
      const answer =
        q.options && q.options.length > 0
          ? await select({ message: "Choose:", choices: [...q.options.map((o) => ({ name: o, value: o })), { name: "Other (type my own)", value: "__other__" }] }).then((v) =>
              v === "__other__" ? input({ message: "Your answer:" }) : v
            )
          : await input({ message: "Your answer:" });
      answers.push({ question: q.question, answer });
    }
    return answers;
  };
}

export async function startRepl(initialAgent: Agent, options: ReplOptions = {}): Promise<Agent> {
  let agent = initialAgent;
  attachAskUser(agent);
  const transcript: TranscriptEntry[] = [];
  const history: string[] = [];
  const replInput = new ReplInput(history);
  let useAgents = options.multiAgentDefault ?? false;

  console.log(chalk.dim(`Type ${chalk.cyan("/help")} for commands, ${chalk.cyan("/exit")} to quit. Esc or Ctrl+C interrupts a running task.`));
  for (;;) {
    let line: string;
    try {
      line = await replInput.readLine(useAgents ? "grok-code ⚡" : "grok-code>");
    } catch {
      break; // stdin closed
    }
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit" || text === "/quit") break;
    remember(transcript, "user", text);

    if (text === "/agents" || text.startsWith("/agents ")) {
      const arg = text.split(/\s+/)[1]?.toLowerCase();
      useAgents = arg === "on" ? true : arg === "off" ? false : !useAgents;
      const msg = `Multi-agent mode ${useAgents ? chalk.green("ON") : chalk.yellow("OFF")} — ${useAgents ? "orchestrator delegates to parallel sub-agents (changes applied to your files)" : "single agent"}.`;
      remember(transcript, "system", msg);
      console.log(msg);
      continue;
    }

    if (text.startsWith("/")) {
      const nextAgent = await handleSlash(text, agent, options, replInput, (content) => remember(transcript, "system", content));
      if (nextAgent) {
        agent = nextAgent;
        attachAskUser(agent);
      }
      continue;
    }

    try {
      const interjections = new Interjections();
      const response = await replInput.runWithEscInterrupt(
        (signal) => (useAgents ? runReplTeam(agent, text, signal, interjections) : agent.run(text, false, signal, interjections)),
        {
          onInterject: (msg) => {
            interjections.push(msg);
            console.log(chalk.dim(`  💬 queued for the agent: ${msg}`));
          }
        }
      );
      remember(transcript, "assistant", String(response));
      console.log(`\n${response}\n`);
      const lap = agent.usage.lap();
      if (lap.calls > 0) console.log(chalk.dim(formatTotals(lap)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      remember(transcript, "system", message);
      const interrupted = /interrupt|abort/i.test(message);
      console.log(interrupted ? chalk.yellow("Interrupted.") : chalk.red(`Error: ${message}`));
    }
  }
  console.log(chalk.dim("Goodbye."));
  replInput.close();
  return agent;
}

async function runReplTeam(agent: Agent, task: string, signal: AbortSignal, interjections?: Interjections): Promise<string> {
  console.log(chalk.dim("Multi-agent: orchestrator + parallel sub-agents…"));
  const orchestrator = new Orchestrator(agent.provider, agent.config, randomUUID().slice(0, 8), task, { applyToWorkingTree: true, usage: agent.usage, interjections });
  const result = await orchestrator.run(task, signal);
  if (result.applied && result.diff) return `${result.report}\n\n${chalk.dim("[changes applied to your working tree]")}\n${result.diff}`;
  if (!result.applied) return `${result.report}\n\n${chalk.dim(`[review branch] ${result.integrationBranch}`)}`;
  return result.report;
}

async function handleSlash(command: string, agent: Agent, options: ReplOptions, replInput: ReplInput, emit: (content: string) => void): Promise<Agent | void> {
  const [name, ...rest] = command.split(/\s+/);
  const output = (content: string) => {
    emit(content);
    console.log(content);
  };
  switch (name) {
    case "/help":
      output(visibleSlashCommands().map((cmd) => `${cmd.usage.padEnd(24)} ${cmd.description}`).join("\n"));
      break;
    case "/status":
      output([
        formatSessionStatus(agent.config),
        formatWorkspaceTrustStatus(agent.config.workspaceRoot),
        agent.usage.hasData ? agent.usage.format() : "tokens this session: none yet"
      ].join("\n"));
      break;
    case "/cd":
    case "/workspace":
    case "/change-dir": {
      if (!options.switchWorkspace) {
        output("Workspace switching is unavailable in this session.");
        break;
      }
      const workspace = await chooseWorkspace(agent.config.workspaceRoot);
      if (!workspace) {
        output("Workspace unchanged.");
        break;
      }
      await agent.background.stopAll("workspace switch cleanup");
      const nextAgent = await options.switchWorkspace(workspace);
      output(`Workspace switched to ${nextAgent.config.workspaceRoot}`);
      return nextAgent;
    }
    case "/trust":
    case "/trust-settings":
    case "/workspace-trust":
      output(await manageWorkspaceTrust(agent.config.workspaceRoot));
      break;
    case "/git-status":
      output(JSON.stringify(await agent.tools.execute("git_status", {}, agent.toolContext()), null, 2));
      break;
    case "/diff":
      output(formatDiffResult(await agent.tools.execute("git_diff", {}, agent.toolContext())));
      break;
    case "/approval":
      output(await chooseApproval(agent, rest[0]));
      break;
    case "/context":
      output(formatContext(agent.context.list()));
      break;
    case "/compact":
      output(agent.context.compactContext("interactive session").content);
      break;
    case "/learn-project":
      output(await replInput.runWithEscInterrupt((signal) => agent.run(PROJECT_UNDERSTANDING_TASK, false, signal)));
      break;
    case "/skills":
      output(formatSkills(agent));
      break;
    case "/tools":
      output(agent.toolSkills.toolIndex());
      break;
    case "/env":
      output(JSON.stringify(await agent.tools.execute("inspect_environment", { includeVersions: true }, agent.toolContext()), null, 2));
      break;
    case "/bg":
      output(JSON.stringify(agent.background.list(), null, 2));
      break;
    case "/bg-stop":
      output(JSON.stringify(await agent.tools.execute("stop_background_command", { id: rest[0], reason: "user slash command" }, agent.toolContext()), null, 2));
      break;
    case "/bg-stop-all":
      output(JSON.stringify(await agent.tools.execute("stop_all_background_commands", { reason: "user slash command" }, agent.toolContext()), null, 2));
      break;
    case "/drop":
      output(agent.context.drop(rest[0] ?? "") ? "dropped" : "not dropped");
      break;
    case "/clear":
      agent.context.compactContext("cleared interactive context");
      output("Context compacted — stale items summarized, pinned items kept.");
      break;
    case "/resume":
      output("Use `grok-code resume [session-id]` from the shell.");
      break;
    case "/model":
      output("Model changes apply to new CLI invocations in this MVP.");
      break;
    default:
      output(`Unknown command: ${name}`);
  }
}

function remember(transcript: TranscriptEntry[], role: TranscriptEntry["role"], content: string): void {
  transcript.push({ role, content });
  if (transcript.length > 40) transcript.splice(0, transcript.length - 40);
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
