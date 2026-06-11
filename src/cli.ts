import { Command } from "commander";
import { createXaiProvider } from "./api/XaiResponsesProvider.js";
import { Agent } from "./agent/Agent.js";
import { Orchestrator } from "./agents/Orchestrator.js";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

function isGitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
import { loadConfig, type ApprovalMode, type SandboxProfile, type ToolChoice, type ConversationMode } from "./config/loadConfig.js";
import { startRepl } from "./ui/repl.js";
import { formatSessionStatus, printHeader } from "./ui/terminal.js";
import { SessionStore } from "./session/SessionStore.js";
import { colorDiff } from "./ui/diffView.js";
import { PROJECT_UNDERSTANDING_TASK } from "./agent/projectUnderstandingTask.js";
import { ensureWorkspaceTrusted } from "./ui/workspaceTrust.js";
import { WorkspaceTrustStore } from "./workspace/WorkspaceTrustStore.js";
import { WorkspaceSnapshotStore } from "./workspace/WorkspaceSnapshotStore.js";
import path from "node:path";

type CliOpts = {
  model?: string;
  approval?: ApprovalMode;
  profile?: SandboxProfile;
  toolChoice?: ToolChoice;
  maxSteps?: string;
  serverTools?: boolean;
  webSearch?: boolean;
  xSearch?: boolean;
  conversationMode?: ConversationMode;
  verifier?: boolean;
  agents?: boolean;
};

let activeSigintCleanup: (() => void) | undefined;

export async function main(): Promise<void> {
  const program = new Command();
  program
    .name("grok-code")
    .description("Local coding agent CLI powered by xAI Grok")
    .argument("[task...]", "Task description")
    .option("--model <model>", "Model", "grok-build-0.1")
    .option("--approval <mode>", "on-request|auto-local|auto-safe|auto-all|never", "on-request")
    .option("--profile <profile>", "Sandbox profile: default|build|test|debug|package|docs", "default")
    .option("--tool-choice <choice>", "auto|required|none", "auto")
    .option("--max-steps <number>", "Maximum agent steps", "50")
    .option("--no-server-tools", "Disable xAI server-side tools")
    .option("--no-web-search", "Disable xAI web_search server-side tool")
    .option("--no-x-search", "Disable xAI x_search server-side tool")
    .option("--conversation-mode <mode>", "stateful|stateless|hybrid", "stateless")
    .option("--verifier", "Enable independent verifier agent after each final answer")
    .option("--no-agents", "Disable multi-agent mode and use a single agent (multi-agent is the default for one-shot tasks)");

  program.command("ask <question...>").description("Ask a question").action(async (question: string[]) => runOne(question.join(" "), program.opts<CliOpts>(), "ask"));
  program.command("edit <task...>").description("Run an edit task").action(async (task: string[]) => runOne(task.join(" "), program.opts<CliOpts>(), "edit"));
  program.command("review").description("Review current diff").action(async (_opts: CliOpts) => runOne("Review the current git diff for bugs, regressions, risks, and missing tests.", program.opts<CliOpts>(), "review"));
  program.command("learn-project").description("Inspect this project and write durable notes to GROK.md").action(async (_opts: CliOpts) => runOne(PROJECT_UNDERSTANDING_TASK, program.opts<CliOpts>(), "learn-project"));
  program.command("status").description("Show session status").action(() => localSessionStatus(program.opts<CliOpts>()));
  program.command("git-status").description("Show git status").action(async () => localGitStatus());
  program.command("diff").description("Show git diff").action(async () => localStatus("diff"));
  program.command("resume [sessionId]").description("Resume a session").action(async (sessionId?: string) => runResume(sessionId, program.opts<CliOpts>()));
  program.command("trash").description("List recoverable file snapshots (undo net)").action(() => listTrash());
  program.command("restore <id>").description("Restore a file snapshot by id").action((id: string) => restoreTrash(id));

  program.action(async (taskParts: string[], opts: CliOpts) => {
    const task = taskParts.join(" ").trim();
    if (task) await runOne(task, opts, "task");
    else await runInteractive(opts);
  });

  await program.parseAsync(process.argv);
}

async function makeAgent(opts: CliOpts, task = "", cwd = process.cwd()): Promise<Agent> {
  const toolOverrides = parseServerToolOverrides(process.argv.slice(2));
  const workspaceTrusted = Boolean(new WorkspaceTrustStore().getTrustFor(cwd));
  const config = loadConfig(cwd, {
    model: opts.model,
    approval: opts.approval,
    sandboxProfile: parseSandboxProfile(opts.profile),
    workspaceTrusted,
    toolChoice: opts.toolChoice,
    maxSteps: parseMaxSteps(opts.maxSteps),
    serverTools: toolOverrides.serverTools,
    enableWebSearch: toolOverrides.enableWebSearch,
    enableXSearch: toolOverrides.enableXSearch,
    conversationMode: parseConversationMode(opts.conversationMode),
    enableVerifier: opts.verifier === true ? true : undefined
  });
  const provider = createXaiProvider({ model: config.model });
  printHeader(config.model, config.workspaceRoot);
  const agent = await Agent.create(provider, config, task);
  activeSigintCleanup?.();
  const sigintHandler = async () => {
    await agent.background.stopAll("Ctrl+C cleanup");
    process.exit(130);
  };
  process.once("SIGINT", sigintHandler);
  activeSigintCleanup = () => {
    process.removeListener("SIGINT", sigintHandler);
    activeSigintCleanup = undefined;
  };
  return agent;
}

export function parseServerToolOverrides(argv: string[]): { serverTools?: boolean; enableWebSearch?: boolean; enableXSearch?: boolean } {
  return {
    serverTools: argv.includes("--no-server-tools") ? false : undefined,
    enableWebSearch: argv.includes("--no-web-search") ? false : undefined,
    enableXSearch: argv.includes("--no-x-search") ? false : undefined
  };
}

export function parseMaxSteps(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  const parsed = Number(normalized);
  if (!/^\d+$/.test(normalized) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("--max-steps must be a positive integer");
  }
  return parsed;
}

export function parseSandboxProfile(value?: string): SandboxProfile | undefined {
  if (value === undefined) return undefined;
  const profiles: SandboxProfile[] = ["default", "build", "test", "debug", "package", "docs"];
  if (!profiles.includes(value as SandboxProfile)) {
    throw new Error(`--profile must be one of: ${profiles.join(", ")}`);
  }
  return value as SandboxProfile;
}

export function parseConversationMode(value?: string): ConversationMode | undefined {
  if (value === undefined) return undefined;
  const modes: ConversationMode[] = ["stateful", "stateless", "hybrid"];
  if (!modes.includes(value as ConversationMode)) {
    throw new Error(`--conversation-mode must be one of: ${modes.join(", ")}`);
  }
  return value as ConversationMode;
}

async function runTeam(task: string, opts: CliOpts): Promise<void> {
  const cwd = process.cwd();
  const workspaceTrusted = Boolean(new WorkspaceTrustStore().getTrustFor(cwd));
  const config = loadConfig(cwd, {
    model: opts.model,
    approval: opts.approval,
    sandboxProfile: parseSandboxProfile(opts.profile),
    workspaceTrusted,
    toolChoice: opts.toolChoice,
    maxSteps: parseMaxSteps(opts.maxSteps),
    enableVerifier: opts.verifier === true ? true : undefined
  });
  const provider = createXaiProvider({ model: config.model });
  printHeader(config.model, config.workspaceRoot);
  console.log("Multi-agent mode: orchestrator + parallel sub-agents (git worktrees).");
  const orchestrator = new Orchestrator(provider, config, randomUUID().slice(0, 8), task);
  const result = await orchestrator.run(task);
  console.log(result.report);
  if (result.ephemeral) {
    if (result.diff) console.log(`\n[Changes applied to your files]\n${result.diff}`);
  } else {
    console.log(`\n[Integration branch] ${result.integrationBranch}`);
    console.log(result.diff ? `[Diff]\n${result.diff}` : "[Diff] (no changes integrated)");
    console.log(`\nReview with: git diff HEAD..${result.integrationBranch}  |  merge with: git merge ${result.integrationBranch}`);
  }
}

async function runOne(task: string, opts: CliOpts, _kind: string): Promise<void> {
  // Multi-agent is the default for one-shot tasks. A non-git workspace gets a
  // throwaway git repo behind the scenes (removed after). Only fall back to a
  // single agent if git is not installed at all, or multi-agent is disabled.
  if (opts.agents !== false) {
    if (isGitAvailable()) return runTeam(task, opts);
    console.log("(git is not installed — using a single agent)");
  }
  const agent = await makeAgent(opts, task);
  const answer = await agent.run(task, true);
  console.log(answer);
  await agent.background.stopAll("one-shot exit cleanup");
  const store = new SessionStore(process.cwd());
  const session = store.create(agent.config.model, opts.approval ?? "on-request");
  session.taskSummary = task;
  session.contextItems = agent.context.list();
  session.backgroundProcesses = agent.background.list();
  store.save(session);
}

async function runInteractive(opts: CliOpts): Promise<void> {
  if (!(await ensureWorkspaceTrusted(process.cwd()))) return;
  const agent = await makeAgent(opts, "interactive session");
  const finalAgent = await startRepl(agent, {
    switchWorkspace: async (workspace) => {
      const next = await makeAgent(opts, "interactive session", workspace);
      process.chdir(workspace);
      return next;
    }
  });
  await finalAgent.background.stopAll("interactive exit cleanup");
}

async function runResume(sessionId: string | undefined, opts: CliOpts): Promise<void> {
  if (!(await ensureWorkspaceTrusted(process.cwd()))) return;
  const store = new SessionStore(process.cwd());
  const session = store.load(sessionId);
  if (!session) throw new Error("No session found.");
  const agent = await makeAgent({ ...opts, model: session.model, approval: session.approval }, session.taskSummary ?? "resume session");
  for (const item of session.contextItems) agent.context.add(item);
  const finalAgent = await startRepl(agent, {
    switchWorkspace: async (workspace) => {
      const next = await makeAgent({ ...opts, model: session.model, approval: session.approval }, "interactive session", workspace);
      process.chdir(workspace);
      return next;
    }
  });
  await finalAgent.background.stopAll("resume exit cleanup");
}

function listTrash(): void {
  const entries = new WorkspaceSnapshotStore(process.cwd()).list();
  if (entries.length === 0) {
    console.log("No snapshots. Destructive file operations are backed up here automatically.");
    return;
  }
  console.log("Recoverable snapshots (most recent first):");
  for (const e of entries) {
    console.log(`  ${e.id}  ${e.op.padEnd(9)} ${e.path}  (round ${e.round}, ${e.bytes}B)`);
  }
  console.log("\nRestore with: grok-code restore <id>");
}

function restoreTrash(id: string): void {
  const store = new WorkspaceSnapshotStore(process.cwd());
  const entry = store.list().find((e) => e.id === id);
  if (!entry) {
    console.log(`No snapshot with id ${id}. Run 'grok-code trash' to list snapshots.`);
    return;
  }
  const target = path.join(process.cwd(), entry.path);
  if (store.restore(id, target)) console.log(`Restored ${entry.path} from snapshot ${id}.`);
  else console.log(`Could not restore snapshot ${id}.`);
}

function localSessionStatus(opts: CliOpts): void {
  const toolOverrides = parseServerToolOverrides(process.argv.slice(2));
  const config = loadConfig(process.cwd(), {
    model: opts.model,
    approval: opts.approval,
    sandboxProfile: parseSandboxProfile(opts.profile),
    workspaceTrusted: Boolean(new WorkspaceTrustStore().getTrustFor(process.cwd())),
    toolChoice: opts.toolChoice,
    maxSteps: parseMaxSteps(opts.maxSteps),
    serverTools: toolOverrides.serverTools,
    enableWebSearch: toolOverrides.enableWebSearch,
    enableXSearch: toolOverrides.enableXSearch,
    conversationMode: parseConversationMode(opts.conversationMode)
  });
  console.log(formatSessionStatus(config));
}

async function localGitStatus(): Promise<void> {
  const config = loadConfig(process.cwd(), {});
  const agent = new Agent({} as any, config, "git-status");
  const result = await agent.tools.execute("git_status", {}, agent.toolContext());
  console.log(JSON.stringify(result, null, 2));
}

async function localStatus(kind: "status" | "diff"): Promise<void> {
  const config = loadConfig(process.cwd(), {});
  const agent = new Agent({} as any, config, kind);
  const result = await agent.tools.execute(kind === "status" ? "git_status" : "git_diff", {}, agent.toolContext());
  const text = JSON.stringify(result, null, 2);
  console.log(kind === "diff" ? colorDiff(text) : text);
}
