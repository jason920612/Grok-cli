import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { input, select } from "@inquirer/prompts";
import { WorkspaceTrustStore, describeTrustEntry, type WorkspaceTrustEntry, type WorkspaceTrustScope } from "../workspace/WorkspaceTrustStore.js";

export async function ensureWorkspaceTrusted(workspace: string, store = new WorkspaceTrustStore()): Promise<boolean> {
  const existing = store.getTrustFor(workspace);
  if (existing) {
    store.rememberWorkspace(workspace);
    return true;
  }

  const scope = await chooseTrustScope(`This directory has not been trusted yet:\n${workspace}\n\nWhat would you like to trust?`);
  if (scope === "cancel") return false;
  const base = scope === "custom-descendants" ? await askDirectory("Trusted base directory", path.dirname(workspace)) : undefined;
  if (base === null) return false;
  const confirmed = await confirmMenu(`Apply trust setting: ${formatTrustPreview(workspace, scope, base)}?`);
  if (!confirmed) return false;
  store.setTrust(workspace, scope, base);
  return true;
}

export async function chooseWorkspace(currentWorkspace: string, store = new WorkspaceTrustStore()): Promise<string | null> {
  const recent = store.recentWorkspaces().filter((item) => item !== currentWorkspace);
  const choice = await select<string>({
    message: `Change workspace (current: ${currentWorkspace})`,
    choices: [
      { name: "Current directory", value: "current" },
      { name: "Parent directory", value: "parent" },
      ...recent.map((workspace) => ({ name: workspace, value: `recent:${workspace}` })),
      { name: "Manually enter a path", value: "manual" },
      { name: "Cancel", value: "cancel" }
    ]
  });
  if (choice === "cancel") return null;
  const selected = choice === "current"
    ? currentWorkspace
    : choice === "parent"
      ? path.dirname(currentWorkspace)
      : choice === "manual"
        ? await askDirectory("Workspace path", currentWorkspace)
        : choice.slice("recent:".length);
  if (!selected) return null;
  if (sameDirectory(selected, currentWorkspace)) return null;
  const trusted = await ensureWorkspaceTrusted(selected, store);
  if (!trusted) return null;
  const confirmed = await confirmMenu(`Switch workspace to ${selected}?`);
  return confirmed ? selected : null;
}

export async function manageWorkspaceTrust(workspace: string, store = new WorkspaceTrustStore()): Promise<string> {
  for (;;) {
    const current = store.getTrustFor(workspace);
    const action = await select<string>({
      message: [
        `Current workspace: ${workspace}`,
        `Current trust setting: ${current ? describeTrustEntry(current) : "none"}`
      ].join("\n"),
      choices: [
        { name: "Keep current setting", value: "keep" },
        { name: "Change trust scope", value: "change" },
        { name: "Change trusted base directory", value: "base", disabled: current?.scope === "custom-descendants" ? false : "Only available for custom base trust" },
        { name: "Clear remembered trust setting", value: "clear" },
        { name: "Cancel", value: "cancel" }
      ]
    });
    if (action === "keep" || action === "cancel") return "Trust settings unchanged.";
    if (action === "clear") {
      if (!current) return "No trust setting was stored for this workspace.";
      const confirmed = await confirmMenu(`Clear remembered trust setting: ${describeTrustEntry(current)}?`);
      if (!confirmed) continue;
      return store.clearTrustEntry(current) ? "Trust setting cleared." : "No trust setting was stored for this workspace.";
    }
    if (action === "base" && current?.scope === "custom-descendants") {
      const base = await askDirectory("Trusted base directory", current.baseDirectory ?? path.dirname(workspace));
      if (!base) continue;
      const confirmed = await confirmMenu(`Apply trust setting: ${formatTrustPreview(workspace, "custom-descendants", base)}?`);
      if (!confirmed) continue;
      const updated = store.setTrust(workspace, "custom-descendants", base);
      return `Trust setting updated: ${describeTrustEntry(updated)}`;
    }
    if (action === "change") {
      const scope = await chooseTrustScope("Choose trust scope");
      if (scope === "cancel") continue;
      const base = scope === "custom-descendants" ? await askDirectory("Trusted base directory", path.dirname(workspace)) : undefined;
      if (base === null) continue;
      const confirmed = await confirmMenu(`Apply trust setting: ${formatTrustPreview(workspace, scope, base)}?`);
      if (!confirmed) continue;
      const updated = store.setTrust(workspace, scope, base);
      return `Trust setting updated: ${describeTrustEntry(updated)}`;
    }
  }
}

export function formatWorkspaceTrustStatus(workspace: string, store = new WorkspaceTrustStore()): string {
  const entry = store.getTrustFor(workspace);
  return entry ? formatEntry(entry) : "workspace trust: none";
}

async function chooseTrustScope(message: string): Promise<WorkspaceTrustScope | "cancel"> {
  return select<WorkspaceTrustScope | "cancel">({
    message,
    choices: [
      { name: "Trust only the current directory", value: "exact" },
      { name: "Trust the current directory and all subdirectories", value: "descendants" },
      { name: "Trust all subdirectories under a specified directory", value: "custom-descendants" },
      { name: "Do not trust / cancel", value: "cancel" }
    ]
  });
}

async function askDirectory(message: string, defaultValue: string): Promise<string | null> {
  const raw = await input({ message, default: defaultValue });
  const resolved = path.resolve(raw.trim() || defaultValue);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.log(chalk.yellow(`Not a directory: ${resolved}`));
    return null;
  }
  return fs.realpathSync(resolved);
}

async function confirmMenu(message: string): Promise<boolean> {
  return select<boolean>({
    message,
    choices: [
      { name: "Apply", value: true },
      { name: "Cancel", value: false }
    ]
  });
}

function formatTrustPreview(workspace: string, scope: WorkspaceTrustScope, base?: string): string {
  return describeTrustEntry({
    workspace,
    scope,
    ...(base ? { baseDirectory: base } : {}),
    updatedAt: new Date().toISOString()
  });
}

function formatEntry(entry: WorkspaceTrustEntry): string {
  return `workspace trust: ${describeTrustEntry(entry)}`;
}

function sameDirectory(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}
