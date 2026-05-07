import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export type ApprovalMode = "on-request" | "auto-local" | "auto-safe" | "auto-all" | "never";
export type ToolChoice = "auto" | "required" | "none";
export type SandboxProfile = "default" | "build" | "test" | "debug" | "package" | "docs";
export type ConversationMode = "stateful" | "stateless" | "hybrid";

export type GrokCodeConfig = {
  model: string;
  approval: ApprovalMode;
  toolChoice: ToolChoice;
  maxSteps: number;
  serverTools: boolean;
  enableWebSearch: boolean;
  enableXSearch: boolean;
  workspaceRoot: string;
  sandboxProfile: SandboxProfile;
  workspaceTrusted: boolean;
  conversationMode: ConversationMode;
  hybridResetAfterSteps: number;
  hybridResetAfterFailures: number;
  enableVerifier: boolean;
  verifierModel: string;
  maxVerifierReprompts: number;
};

export function loadConfig(cwd = process.cwd(), overrides: Partial<GrokCodeConfig> = {}): GrokCodeConfig {
  dotenv.config({ path: path.join(cwd, ".env"), override: true });
  const projectConfig = readProjectConfig(cwd);
  const cleanOverrides = withoutUndefined(overrides);
  return {
    model: "grok-4.3",
    approval: "on-request",
    toolChoice: "auto",
    maxSteps: 30,
    serverTools: true,
    enableWebSearch: true,
    enableXSearch: true,
    workspaceRoot: cwd,
    sandboxProfile: "default",
    workspaceTrusted: false,
    conversationMode: "stateful",
    hybridResetAfterSteps: 10,
    hybridResetAfterFailures: 3,
    enableVerifier: false,
    verifierModel: "grok-4.3",
    maxVerifierReprompts: 2,
    ...projectConfig,
    ...cleanOverrides
  };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
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
