import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool, commandExists } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const execFileAsync = promisify(execFile);

export function inspectEnvironmentTool(skills: ToolSkillRegistry) {
  return makeTool(
    "inspect_environment",
    "Inspect the local development environment: OS, shell, installed runtimes, package managers, key tools, network availability, and workspace metadata.",
    schemas.object({
      includeNetworkCheck: schemas.boolean("Whether to check if outbound network access appears available."),
      includeVersions: schemas.boolean("Whether to collect versions for common runtimes and tools.")
    }),
    z.object({ includeNetworkCheck: z.boolean().optional(), includeVersions: z.boolean().optional() }),
    skills,
    async (args, ctx) => {
      const names = ["git", "node", "npm", "pnpm", "yarn", "bun", "python", "python3", "go", "cargo", "rg", "docker", "make"];
      const versions: Record<string, string> = {};
      for (const name of names) {
        const available = await commandExists(name);
        versions[name] = available ? "available" : "missing";
        if (available && args.includeVersions) {
          try {
            const { stdout, stderr } = await execFileAsync(name, ["--version"], { timeout: 5000, windowsHide: true });
            versions[name] = (stdout || stderr).split(/\r?\n/)[0] ?? "available";
          } catch {
            versions[name] = "available";
          }
        }
      }
      let branch = "unknown";
      if (versions.git !== "missing") {
        try {
          const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: ctx.workspaceRoot, timeout: 5000, windowsHide: true });
          branch = stdout.trim() || "detached-or-none";
        } catch {
          branch = "not-a-git-repo";
        }
      }
      const networkStatus = args.includeNetworkCheck ? await networkCheck() : "unknown";
      const result = {
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        shell: process.env.SHELL ?? process.env.ComSpec ?? "unknown",
        workspaceRoot: ctx.workspaceRoot,
        git: { available: versions.git !== "missing", branch },
        packageManagers: pick(versions, ["npm", "pnpm", "yarn", "bun"]),
        runtimes: pick(versions, ["node", "python", "python3", "go", "cargo"]),
        tools: pick(versions, ["git", "rg", "docker", "make"]),
        networkStatus
      };
      ctx.context.upsert("environment-summary", { type: "environment_summary", content: JSON.stringify(result, null, 2), priority: 100, pinned: true });
      return result;
    }
  );
}

function pick(obj: Record<string, string>, keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, obj[key] ?? "missing"]));
}

async function networkCheck(): Promise<"available" | "unavailable" | "unknown"> {
  try {
    await execFileAsync(process.execPath, ["-e", "fetch('https://api.x.ai').then(()=>process.exit(0)).catch(()=>process.exit(2))"], { timeout: 8000, windowsHide: true });
    return "available";
  } catch {
    return "unavailable";
  }
}
