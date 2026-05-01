import { Command } from "commander";
import { createXaiClient } from "./api/xaiClient.js";
import { Agent } from "./agent/Agent.js";
import { loadConfig, type ApprovalMode, type ToolChoice } from "./config/loadConfig.js";
import { startRepl } from "./ui/repl.js";
import { printHeader } from "./ui/terminal.js";
import { SessionStore } from "./session/SessionStore.js";
import { colorDiff } from "./ui/diffView.js";
import { PROJECT_UNDERSTANDING_TASK } from "./agent/projectUnderstandingTask.js";

type CliOpts = {
  model?: string;
  approval?: ApprovalMode;
  toolChoice?: ToolChoice;
  maxSteps?: string;
  serverTools?: boolean;
  enableWebSearch?: boolean;
  enableXSearch?: boolean;
};

export async function main(): Promise<void> {
  const program = new Command();
  program
    .name("grok-code")
    .description("Local coding agent CLI powered by xAI Grok 4.3")
    .argument("[task...]", "Task description")
    .option("--model <model>", "Model", "grok-4.3")
    .option("--approval <mode>", "on-request|auto-safe|never", "on-request")
    .option("--tool-choice <choice>", "auto|required|none", "auto")
    .option("--max-steps <number>", "Maximum agent steps", "30")
    .option("--no-server-tools", "Disable xAI server-side tools")
    .option("--enable-web-search", "Enable xAI web_search server-side tool")
    .option("--enable-x-search", "Enable xAI x_search server-side tool");

  program.command("ask <question...>").description("Ask a question").action(async (question: string[], opts: CliOpts) => runOne(question.join(" "), opts, "ask"));
  program.command("edit <task...>").description("Run an edit task").action(async (task: string[], opts: CliOpts) => runOne(task.join(" "), opts, "edit"));
  program.command("review").description("Review current diff").action(async (_opts: CliOpts) => runOne("Review the current git diff for bugs, regressions, risks, and missing tests.", program.opts<CliOpts>(), "review"));
  program.command("learn-project").description("Inspect this project and write durable notes to GROK.md").action(async (_opts: CliOpts) => runOne(PROJECT_UNDERSTANDING_TASK, program.opts<CliOpts>(), "learn-project"));
  program.command("status").description("Show git status").action(async () => localStatus("status"));
  program.command("diff").description("Show git diff").action(async () => localStatus("diff"));
  program.command("resume [sessionId]").description("Resume a session").action(async (sessionId?: string) => runResume(sessionId, program.opts<CliOpts>()));

  program.action(async (taskParts: string[], opts: CliOpts) => {
    const task = taskParts.join(" ").trim();
    if (task) await runOne(task, opts, "task");
    else await runInteractive(opts);
  });

  await program.parseAsync(process.argv);
}

async function makeAgent(opts: CliOpts, task = ""): Promise<Agent> {
  const config = loadConfig(process.cwd(), {
    model: opts.model,
    approval: opts.approval,
    toolChoice: opts.toolChoice,
    maxSteps: opts.maxSteps ? Number(opts.maxSteps) : undefined,
    serverTools: opts.serverTools,
    enableWebSearch: opts.enableWebSearch,
    enableXSearch: opts.enableXSearch
  });
  const client = createXaiClient();
  const agent = new Agent(client, config, task);
  printHeader(config.model, config.workspaceRoot);
  await agent.bootstrap();
  process.once("SIGINT", async () => {
    await agent.background.stopAll("Ctrl+C cleanup");
    process.exit(130);
  });
  return agent;
}

async function runOne(task: string, opts: CliOpts, _kind: string): Promise<void> {
  const agent = await makeAgent(opts, task);
  const answer = await agent.run(task, true);
  console.log(answer);
  await agent.background.stopAll("one-shot exit cleanup");
  const store = new SessionStore(process.cwd());
  const session = store.create(agent.config.model, opts.approval ?? "on-request");
  session.contextItems = agent.context.list();
  session.backgroundProcesses = agent.background.list();
  store.save(session);
}

async function runInteractive(opts: CliOpts): Promise<void> {
  const agent = await makeAgent(opts, "interactive session");
  await startRepl(agent);
  await agent.background.stopAll("interactive exit cleanup");
}

async function runResume(sessionId: string | undefined, opts: CliOpts): Promise<void> {
  const store = new SessionStore(process.cwd());
  const session = store.load(sessionId);
  if (!session) throw new Error("No session found.");
  const agent = await makeAgent({ ...opts, model: session.model, approval: session.approval }, session.taskSummary ?? "resume session");
  for (const item of session.contextItems) agent.context.add(item);
  await startRepl(agent);
}

async function localStatus(kind: "status" | "diff"): Promise<void> {
  const config = loadConfig(process.cwd(), {});
  const agent = new Agent({} as any, config, kind);
  const result = await agent.tools.execute(kind === "status" ? "git_status" : "git_diff", {}, agent.toolContext());
  const text = JSON.stringify(result, null, 2);
  console.log(kind === "diff" ? colorDiff(text) : text);
}
