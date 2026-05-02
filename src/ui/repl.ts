import chalk from "chalk";
import type { Agent } from "../agent/Agent.js";
import { formatContext } from "./formatters.js";
import { PROJECT_UNDERSTANDING_TASK } from "../agent/projectUnderstandingTask.js";
import { colorDiff } from "./diffView.js";
import { readInteractiveLine, runWithEscInterrupt } from "./interactiveInput.js";
import { SLASH_COMMANDS } from "./slashCommands.js";

export async function startRepl(agent: Agent): Promise<void> {
  console.log(chalk.dim("Type /help for commands, /exit to quit."));
  for (;;) {
    const line = await readInteractiveLine("grok-code>");
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit") break;
    if (text.startsWith("/")) {
      await handleSlash(text, agent);
      continue;
    }
    try {
      console.log(await runWithEscInterrupt((signal) => agent.run(text, false, signal)));
    } catch (error) {
      console.log(chalk.yellow(error instanceof Error ? error.message : String(error)));
    }
  }
}

async function handleSlash(command: string, agent: Agent): Promise<void> {
  const [name, ...rest] = command.split(/\s+/);
  switch (name) {
    case "/help":
      console.log(SLASH_COMMANDS.map((cmd) => `${cmd.usage.padEnd(24)} ${cmd.description}`).join("\n"));
      break;
    case "/status":
      console.log(JSON.stringify(await agent.tools.execute("git_status", {}, agent.toolContext()), null, 2));
      break;
    case "/diff":
      console.log(formatDiffResult(await agent.tools.execute("git_diff", {}, agent.toolContext())));
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
      console.log(agent.skillLoader.loadAll().map((skill) => `${skill.id}: ${skill.description}`).join("\n"));
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
