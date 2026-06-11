export type SlashCommand = {
  name: string;
  usage: string;
  description: string;
  hidden?: boolean;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", usage: "/help", description: "Show available commands." },
  { name: "/status", usage: "/status", description: "Show session status." },
  { name: "/cd", usage: "/cd", description: "Change workspace directory from a menu." },
  { name: "/workspace", usage: "/workspace", description: "Change workspace directory from a menu.", hidden: true },
  { name: "/change-dir", usage: "/change-dir", description: "Change workspace directory from a menu.", hidden: true },
  { name: "/trust", usage: "/trust", description: "View or change workspace trust settings." },
  { name: "/trust-settings", usage: "/trust-settings", description: "View or change workspace trust settings.", hidden: true },
  { name: "/workspace-trust", usage: "/workspace-trust", description: "View or change workspace trust settings.", hidden: true },
  { name: "/git-status", usage: "/git-status", description: "Show git status." },
  { name: "/diff", usage: "/diff", description: "Open the changed-files diff browser (click/space to expand, q to close)." },
  { name: "/approval", usage: "/approval", description: "Choose approval mode from a menu." },
  { name: "/agents", usage: "/agents [on|off]", description: "Toggle multi-agent mode (orchestrator + parallel sub-agents) for tasks." },
  { name: "/yes", usage: "/yes [on|off]", description: "Toggle always-approve (auto-approve every prompt; destructive commands still blocked)." },
  { name: "/clear", usage: "/clear", description: "Compact and clear stale context." },
  { name: "/model", usage: "/model <model>", description: "Show model change guidance.", hidden: true },
  { name: "/resume", usage: "/resume", description: "Show resume guidance.", hidden: true },
  { name: "/context", usage: "/context", description: "Show context items.", hidden: true },
  { name: "/compact", usage: "/compact", description: "Compact context now.", hidden: true },
  { name: "/learn-project", usage: "/learn-project", description: "Inspect project and update GROK.md." },
  { name: "/skills", usage: "/skills", description: "List loaded skills." },
  { name: "/tools", usage: "/tools", description: "List available tools.", hidden: true },
  { name: "/env", usage: "/env", description: "Inspect environment.", hidden: true },
  { name: "/bg", usage: "/bg", description: "List background commands.", hidden: true },
  { name: "/bg-stop", usage: "/bg-stop <id>", description: "Stop one background command.", hidden: true },
  { name: "/bg-stop-all", usage: "/bg-stop-all", description: "Stop all background commands.", hidden: true },
  { name: "/drop", usage: "/drop <context-item-id>", description: "Drop one context item.", hidden: true },
  { name: "/exit", usage: "/exit", description: "Exit interactive mode." }
];

export function visibleSlashCommands(): SlashCommand[] {
  return SLASH_COMMANDS.filter((command) => !command.hidden);
}
