import type { ToolSkill } from "../tool-skills/ToolSkill.js";
import type { ApprovalPolicy } from "../approval/ApprovalPolicy.js";
import type { WorkspaceSandbox } from "../workspace/WorkspaceSandbox.js";
import type { BackgroundProcessManager } from "../background/BackgroundProcessManager.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ContextEngine } from "../context/ContextEngine.js";
import type { WorkspaceSnapshotStore } from "../workspace/WorkspaceSnapshotStore.js";
import type { ProjectMemory } from "../memory/ProjectMemory.js";
import type { UserProfile } from "../memory/UserProfile.js";
import type { Board } from "../agents/Board.js";
import type { GitService } from "../agents/GitService.js";

/** Spawns a worker sub-agent, runs it to completion, returns its result (subagents-v1). */
export type SpawnWorker = (spec: { name: string; role: string; brief: string }) => Promise<{ prNumber?: number; summary: string }>;

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
  /** Durable project core memory (project-memory.md). */
  memory?: ProjectMemory;
  /** Per-domain user technical level for scoping calibration (scoping-v1). */
  userProfile?: UserProfile;
  /** Ask the interactive user batched conceptual questions (scoping-v1); undefined in one-shot mode. */
  askUser?: (questions: Array<{ question: string; options?: string[] }>) => Promise<Array<{ question: string; answer: string }>>;
  /** Multi-agent collaboration board (subagents-v1). */
  board?: Board;
  /** Git worktree/branch service for parallel isolation (subagents-v1 §7.2). */
  git?: GitService;
  /** This agent's id on the board ("orchestrator" or a worker name). */
  agentId?: string;
  /** Run a worker sub-agent (orchestrator only). */
  spawnWorker?: SpawnWorker;
  /** Spawn a read-only explore agent for cheap context gathering (orchestrator only). */
  explore?: (question: string, thoroughness?: string) => Promise<{ findings: string }>;
  /** Spawn a read-only verifier to audit the integrated result against the task (orchestrator only). */
  verify?: (focus?: string) => Promise<{ verdict: string; pass: boolean }>;
  /** Mailbox for images a tool wants the model to SEE; the loop attaches them to the next turn. */
  images?: Array<{ dataUri: string; note?: string }>;
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
