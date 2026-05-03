export type CommandRisk =
  | "safe"
  | "ask"
  | "deny"
  | "global_environment_change"
  | "destructive"
  | "network"
  | "background";

export function classifyCommand(command: string, background = false): CommandRisk {
  const c = command.trim().toLowerCase();
  if (background) {
    if (/(deploy|publish|git\s+push|rm\s+-rf|sudo|ssh|scp|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|\s-g\b|global\s+add)/.test(c) || isWindowsDestructiveDelete(c)) return "deny";
    if (/(dev|watch|storybook|preview|serve|vite|next|webpack|nodemon|tsx watch)/.test(c)) return "background";
    return "ask";
  }
  if (/(npm\s+(install|i)\s+-g|pnpm\s+add\s+-g|yarn\s+global\s+add|bun\s+install\s+-g|sudo\s+(pip|npm)|brew\s+install|apt(-get)?\s+install|yum\s+install|dnf\s+install|pacman\s+-s|choco\s+install|winget\s+install|\.zshrc|\.bashrc|\.profile|config\.fish|path\s*=)/.test(c)) return "global_environment_change";
  if (/(rm\s+-rf|sudo|chmod\s+-r|chown|ssh|scp|curl\s+.*\|\s*sh|wget\s+.*\|\s*sh|git\s+push|npm\s+publish|deploy)/.test(c) || isWindowsDestructiveDelete(c)) return "deny";
  if (/(curl|wget|git\s+clone|npm\s+install|pnpm\s+install|pnpm\s+add|npm\s+install\s+--save-dev)/.test(c)) return "network";
  if (/^(ls|dir|pwd|rg|grep|git\s+status|git\s+diff|npm\s+test|npm\s+run\s+build|pnpm\s+test|pnpm\s+build|pnpm\s+exec|npm\s+exec|npx|poetry\s+run|uv\s+run|bundle\s+exec|cargo\s+test|go\s+test)/.test(c)) return "safe";
  if (/^(python|node)\s+.+\.(py|js|mjs|cjs|ts)$/.test(c) || /^(git\s+checkout|git\s+commit)/.test(c)) return "ask";
  return "ask";
}

function isWindowsDestructiveDelete(command: string): boolean {
  return /\bremove-item\b[\s\S]*\s-(recurse|r)\b[\s\S]*\s-(force|f)\b/.test(command)
    || /\bdel(?:ete)?\b[\s\S]*(\/s\b[\s\S]*\/q\b|\/q\b[\s\S]*\/s\b)/.test(command)
    || /\brmdir\b[\s\S]*(\/s\b[\s\S]*\/q\b|\/q\b[\s\S]*\/s\b)/.test(command)
    || /\brd\b[\s\S]*(\/s\b[\s\S]*\/q\b|\/q\b[\s\S]*\/s\b)/.test(command);
}
