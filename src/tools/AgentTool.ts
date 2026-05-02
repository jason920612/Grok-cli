import type { ToolSkill } from "../tool-skills/ToolSkill.js";
import type { ApprovalPolicy } from "../approval/ApprovalPolicy.js";
import type { WorkspaceSandbox } from "../workspace/WorkspaceSandbox.js";
import type { BackgroundProcessManager } from "../background/BackgroundProcessManager.js";
import type { ContextManager } from "../context/ContextManager.js";

export type ToolExecutionContext = {
  workspaceRoot: string;
  sandbox: WorkspaceSandbox;
  approval: ApprovalPolicy;
  background: BackgroundProcessManager;
  context: ContextManager;
};

export type ToolExecutor<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
  ctx: ToolExecutionContext
) => Promise<TResult>;

export type AgentTool = {
  name: string;
  description: string;
  schema: {
    type: "function";
    name: string;
    description: string;
    parameters: unknown;
  };
  execute: ToolExecutor;
  skill: ToolSkill;
  locality: "local" | "server";
  readOnly: boolean;
};

export type ToolResult =
  | { ok: true; data: unknown; summary?: string }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
