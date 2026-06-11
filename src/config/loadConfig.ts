import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

export type ApprovalMode = "on-request" | "auto-local" | "auto-safe" | "auto-all" | "never";
export type ToolChoice = "auto" | "required" | "none";
export type SandboxProfile = "default" | "build" | "test" | "debug" | "package" | "docs";
/** Retained for backward-compat config files; the loop is pure-stateless and ignores it. */
export type ConversationMode = "stateful" | "stateless" | "hybrid";

export const GrokCodeConfigSchema = z.object({
  model: z.string().default("grok-build-0.1"),
  approval: z.enum(["on-request", "auto-local", "auto-safe", "auto-all", "never"]).default("on-request"),
  toolChoice: z.enum(["auto", "required", "none"]).default("auto"),
  maxSteps: z.number().int().positive().default(50),
  serverTools: z.boolean().default(true),
  enableWebSearch: z.boolean().default(true),
  enableXSearch: z.boolean().default(true),
  workspaceRoot: z.string(),
  sandboxProfile: z.enum(["default", "build", "test", "debug", "package", "docs"]).default("default"),
  workspaceTrusted: z.boolean().default(false),
  conversationMode: z.enum(["stateful", "stateless", "hybrid"]).default("stateless"),
  hybridResetAfterTurns: z.number().int().positive().default(10),
  hybridResetAfterFailures: z.number().int().positive().default(3),
  enableVerifier: z.boolean().default(false),
  verifierMaxRetries: z.number().int().nonnegative().default(2),
  enableLlmSummary: z.boolean().default(false),
  // Multi-agent debate (debate-v1): adversarial PR critique + evidence-weighted judge.
  enableDebate: z.boolean().default(true),
  debateCritics: z.number().int().min(1).max(5).default(2),
  debateProposers: z.number().int().min(2).max(4).default(2)
});

export type GrokCodeConfig = z.infer<typeof GrokCodeConfigSchema>;

export function loadConfig(cwd = process.cwd(), overrides: Partial<GrokCodeConfig> = {}): GrokCodeConfig {
  dotenv.config({ path: path.join(cwd, ".env"), override: true });
  const projectConfig = readProjectConfig(cwd);
  const cleanOverrides = withoutUndefined(overrides);
  try {
    return GrokCodeConfigSchema.parse({
      workspaceRoot: cwd,
      ...projectConfig,
      ...cleanOverrides
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues.map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`).join("\n");
      throw new Error(`Invalid configuration:\n${details}`);
    }
    throw error;
  }
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
