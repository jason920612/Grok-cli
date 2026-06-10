import type { ToolSkill } from "../tool-skills/ToolSkill.js";
import type { ApprovalPolicy } from "../approval/ApprovalPolicy.js";
import type { WorkspaceSandbox } from "../workspace/WorkspaceSandbox.js";
import type { BackgroundProcessManager } from "../background/BackgroundProcessManager.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ContextEngine } from "../context/ContextEngine.js";
import type { WorkspaceSnapshotStore } from "../workspace/WorkspaceSnapshotStore.js";

export type ToolExecutionContext = {
  workspaceRoot: string;
  sandbox: WorkspaceSandbox;
  approval: ApprovalPolicy;
  background: BackgroundProcessManager;
  context: ContextManager;
  /** Read/existence provenance tracker, backs read-before-write (§6.6/§9.5). */
  engine?: ContextEngine;
  /** Undo net for destructive operations (§9.6). */
  snapshots?: WorkspaceSnapshotStore;
  /** Monotonic round clock for snapshot retention. */
  round?: () => number;
};

export type ToolExecutor<TArgs = unknown, TResult = unknown> = (
  args: TArgs,
  ctx: ToolExecutionContext
) => Promise<TResult>;

/**
 * Self-declared semantics for a tool. The single source of truth for behaviour
 * the agent loop must reason about, replacing scattered name sniffing
 * (`call.name === "apply_patch"`, `isShellTool(name)`) and the hand-maintained
 * read-only name set.
 */
export type ToolEffects = {
  /** Pure inspection: safe to batch and run in parallel; never mutates state. */
  readOnly: boolean;
  /** Edits tracked files such that a diff preview is warranted (e.g. apply_patch). */
  modifiesWorkspace: boolean;
  /** Runs a shell command whose exit code determines effective success/failure. */
  isShell: boolean;
  /** A successful run clears the repeated-failure progress gate. */
  countsAsProgress: boolean;
};

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
  effects?: ToolEffects;
};

export type ToolResult =
  | { ok: true; data: unknown; summary?: string }
  | { ok: false; error: { code: string; message: string; details?: unknown } };
