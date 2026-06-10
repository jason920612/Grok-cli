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

/**
 * Risk classification for `run_python` code (§9.4).
 *
 * Arbitrary Python can do anything, so this does not attempt to fully parse
 * semantics — it scans for dangerous *capabilities* and escalates approval
 * accordingly, mirroring the shell classifier's intent. Pure
 * computation/read code stays "safe"; anything that shells out, deletes,
 * installs, or networks is escalated.
 */
export function classifyPythonCode(code: string): CommandRisk {
  const c = code.toLowerCase();
  // Obvious recursive force-deletes embedded in subprocess/os.system strings.
  if (/rm\s+-rf|shutil\.rmtree\s*\(\s*['"]\/?['"]?\s*\)|rmtree\s*\(\s*['"]\/['"]/.test(c)) return "deny";
  if (/\bsudo\b/.test(c)) return "deny";
  // Global environment changes: package installs.
  if (/pip\s+install|pip3\s+install|npm\s+install\s+-g|conda\s+install|apt(-get)?\s+install|brew\s+install/.test(c)) {
    return "global_environment_change";
  }
  // Networking (direct or via subprocess to curl/wget).
  if (/\bimport\s+(requests|urllib|httpx|socket|http\.client|aiohttp)\b|from\s+urllib|requests\.(get|post)|urlopen\(|curl\s|wget\s/.test(c)) {
    return "network";
  }
  // Effectful: shelling out, deleting, or writing files. Needs approval.
  if (/subprocess\.|os\.system\(|os\.popen\(|os\.remove\(|os\.unlink\(|shutil\.(rmtree|move|copy)|\.unlink\(|open\s*\([^)]*['"][wa]\+?b?['"]/.test(c)) {
    return "ask";
  }
  return "safe";
}

function isWindowsDestructiveDelete(command: string): boolean {
  return /\bremove-item\b/.test(command) && /\s-(recurse|r)\b/.test(command) && /\s-(force|f)\b/.test(command)
    || /\bdel(?:ete)?\b[\s\S]*(\/s\b[\s\S]*\/q\b|\/q\b[\s\S]*\/s\b)/.test(command)
    || /\brmdir\b[\s\S]*(\/s\b[\s\S]*\/q\b|\/q\b[\s\S]*\/s\b)/.test(command)
    || /\brd\b[\s\S]*(\/s\b[\s\S]*\/q\b|\/q\b[\s\S]*\/s\b)/.test(command);
}
