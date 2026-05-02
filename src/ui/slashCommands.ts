export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", usage: "/help", description: "Show available commands." },
  { name: "/status", usage: "/status", description: "Show git status." },
  { name: "/diff", usage: "/diff", description: "Show git-style diff for current changes." },
  { name: "/model", usage: "/model <model>", description: "Show model change guidance." },
  { name: "/clear", usage: "/clear", description: "Compact and clear stale context." },
  { name: "/resume", usage: "/resume", description: "Show resume guidance." },
  { name: "/context", usage: "/context", description: "Show context items." },
  { name: "/compact", usage: "/compact", description: "Compact context now." },
  { name: "/learn-project", usage: "/learn-project", description: "Inspect project and update GROK.md." },
  { name: "/skills", usage: "/skills", description: "List loaded skills." },
  { name: "/tools", usage: "/tools", description: "List available tools." },
  { name: "/env", usage: "/env", description: "Inspect environment." },
  { name: "/bg", usage: "/bg", description: "List background commands." },
  { name: "/bg-stop", usage: "/bg-stop <id>", description: "Stop one background command." },
  { name: "/bg-stop-all", usage: "/bg-stop-all", description: "Stop all background commands." },
  { name: "/drop", usage: "/drop <context-item-id>", description: "Drop one context item." },
  { name: "/exit", usage: "/exit", description: "Exit interactive mode." }
];
