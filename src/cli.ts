import { Command } from "commander";
import { createXaiClient } from "./api/xaiClient.js";
import { Agent } from "./agent/Agent.js";
import { loadConfig, type ApprovalMode, type SandboxProfile, type ToolChoice } from "./config/loadConfig.js";
import { startRepl } from "./ui/repl.js";
import { formatSessionStatus, printHeader } from "./ui/terminal.js";
import { SessionStore } from "./session/SessionStore.js";
import { colorDiff } from "./ui/diffView.js";
import { PROJECT_UNDERSTANDING_TASK } from "./agent/projectUnderstandingTask.js";
import { ensureWorkspaceTrusted } from "./ui/workspaceTrust.js";

type CliOpts = {
  model?: string;
  approval?: ApprovalMode;
  profile?: SandboxProfile;
  toolChoice?: ToolChoice;
  maxSteps?: string;
  serverTools?: boolean;
  webSearch?: boolean;
  xSearch?: boolean;
};

let activeSigintCleanup: (() => void) | undefined;

export async function main(): Promise<void> {
  const program = new Command();
  program
    .name("grok-code")
    .description("Local coding agent CLI powered by xAI Grok 4.3")
    .argument("[task...]", "Task description")
    .option("--model <model>", "Model", "grok-4.3")
    .option("--approval <mode>", "on-request|auto-local|auto-safe|auto-all|never", "on-request")
    .option("--profile <profile>", "Sandbox profile: default|build|test|debug|package|docs", "default")
    .option("--tool-choice <choice>", "auto|required|none", "auto")
    .option("--max-steps <number>", "Maximum agent steps", "30")
    .option("--no-server-tools", "Disable xAI server-side tools")
    .option("--no-web-search", "Disable xAI web_search server-side tool")
    .option("--no-x-search", "Disable xAI x_search server-side tool");

  program.command("ask <question...>").description("Ask a question").action(async (question: string[]) => runOne(question.join(" "), program.opts<CliOpts>(), "ask"));
  program.command("edit <task...>").description("Run an edit task").action(async (task: string[]) => runOne(task.join(" "), program.opts<CliOpts>(), "edit"));
  program.command("review").description("Review current diff").action(async (_opts: CliOpts) => runOne("Review the current git diff for bugs, regressions, risks, and missing tests.", program.opts<CliOpts>(), "review"));
  program.command("learn-project").description("Inspect this project and write durable notes to GROK.md").action(async (_opts: CliOpts) => runOne(PROJECT_UNDERSTANDING_TASK, program.opts<CliOpts>(), "learn-project"));
  program.command("status").description("Show session status").action(() => localSessionStatus(program.opts<CliOpts>()));
  program.command("git-status").description("Show git status").action(async () => localGitStatus());
  program.command("diff").description("Show git diff").action(async () => localStatus("diff"));
  program.command("resume [sessionId]").description("Resume a session").action(async (sessionId?: string) => runResume(sessionId, program.opts<CliOpts>()));

  program.action(async (taskParts: string[], opts: CliOpts) => {
    const task = taskParts.join(" ").trim();
    if (task) await runOne(task, opts, "task");
    else await runInteractive(opts);
  });

  await program.parseAsync(process.argv);
}

async function makeAgent(opts: CliOpts, task = "", cwd = process.cwd()): Promise<Agent> {
  const toolOverrides = parseServerToolOverrides(process.argv.slice(2));
  const config = loadConfig(cwd, {
    model: opts.model,
    approval: opts.approval,
    sandboxProfile: parseSandboxProfile(opts.profile),
    toolChoice: opts.toolChoice,
    maxSteps: parseMaxSteps(opts.maxSteps),
    serverTools: toolOverrides.serverTools,
    enableWebSearch: toolOverrides.enableWebSearch,
    enableXSearch: toolOverrides.enableXSearch
  });
  const client = createXaiClient();
  const agent = new Agent(client, config, task);
  printHeader(config.model, config.workspaceRoot);
  await agent.bootstrap();
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

async function runOne(task: string, opts: CliOpts, _kind: string): Promise<void> {
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

function localSessionStatus(opts: CliOpts): void {
  const toolOverrides = parseServerToolOverrides(process.argv.slice(2));
  const config = loadConfig(process.cwd(), {
    model: opts.model,
    approval: opts.approval,
    sandboxProfile: parseSandboxProfile(opts.profile),
    toolChoice: opts.toolChoice,
    maxSteps: parseMaxSteps(opts.maxSteps),
    serverTools: toolOverrides.serverTools,
    enableWebSearch: toolOverrides.enableWebSearch,
    enableXSearch: toolOverrides.enableXSearch
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
