import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export type ApprovalMode = "on-request" | "auto-local" | "auto-safe" | "auto-all" | "never";
export type ToolChoice = "auto" | "required" | "none";

export type GrokCodeConfig = {
  model: string;
  approval: ApprovalMode;
  toolChoice: ToolChoice;
  maxSteps: number;
  serverTools: boolean;
  enableWebSearch: boolean;
  enableXSearch: boolean;
  workspaceRoot: string;
};

export function loadConfig(cwd = process.cwd(), overrides: Partial<GrokCodeConfig> = {}): GrokCodeConfig {
  dotenv.config({ path: path.join(cwd, ".env"), override: true });
  const projectConfig = readProjectConfig(cwd);
  return {
    model: "grok-4.3",
    approval: "on-request",
    toolChoice: "auto",
    maxSteps: 30,
    serverTools: true,
    enableWebSearch: true,
    enableXSearch: true,
    workspaceRoot: cwd,
    ...projectConfig,
    ...overrides
  };
}

function readProjectConfig(cwd: string): Partial<GrokCodeConfig> {
  const configPath = path.join(cwd, ".grok-code", "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<GrokCodeConfig>;
  } catch {
    return {};
  }
}
