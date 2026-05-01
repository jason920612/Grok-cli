import { input } from "@inquirer/prompts";
import chalk from "chalk";
import type { Agent } from "../agent/Agent.js";
import { formatContext } from "./formatters.js";

export async function startRepl(agent: Agent): Promise<void> {
  console.log(chalk.dim("Type /help for commands, /exit to quit."));
  for (;;) {
    const line = await input({ message: "grok-code>" });
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit") break;
    if (text.startsWith("/")) {
      await handleSlash(text, agent);
      continue;
    }
    console.log(await agent.run(text, false));
  }
}

async function handleSlash(command: string, agent: Agent): Promise<void> {
  const [name, ...rest] = command.split(/\s+/);
  switch (name) {
    case "/help":
      console.log(`/help
/status
/diff
/model <model>
/clear
/resume
/context
/compact
/skills
/tools
/env
/bg
/bg-stop <id>
/bg-stop-all
/drop <context-item-id>
/exit`);
      break;
    case "/status":
      console.log(JSON.stringify(await agent.tools.execute("git_status", {}, agent.toolContext()), null, 2));
      break;
    case "/diff":
      console.log(JSON.stringify(await agent.tools.execute("git_diff", {}, agent.toolContext()), null, 2));
      break;
    case "/context":
      console.log(formatContext(agent.context.list()));
      break;
    case "/compact":
      console.log(agent.context.compactContext("interactive session").content);
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
