import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { AgentTool } from "../AgentTool.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const PROGRESS = { readOnly: false, modifiesWorkspace: false, isShell: false, countsAsProgress: true };

function withProgress(tool: AgentTool): AgentTool {
  tool.effects = { ...PROGRESS };
  tool.readOnly = false;
  return tool;
}

function requireBoard(ctx: { board?: unknown }): asserts ctx is { board: import("../../agents/Board.js").Board } {
  if (!ctx.board) throw new Error("Collaboration board is not available (not running in multi-agent mode).");
}

export function spawnAgentTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "spawn_agent",
      "Spawn a worker sub-agent in its own git worktree to do an assigned task. You write its role (system prompt) and a focused brief. It works, discusses on the board, and opens a PR. Returns the worker's result.",
      schemas.object({ name: { type: "string" }, role: { type: "string" }, brief: { type: "string" } }, ["name", "role", "brief"]),
      z.object({ name: z.string().min(1), role: z.string().min(1), brief: z.string().min(1) }),
      skills,
      async (args, ctx) => {
        if (!ctx.spawnWorker) throw new Error("Spawning is only available to the orchestrator.");
        const result = await ctx.spawnWorker({ name: args.name, role: args.role, brief: args.brief });
        return { worker: args.name, prNumber: result.prNumber, summary: result.summary };
      }
    )
  );
}

export function exploreTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "explore",
      "Spawn a fast READ-ONLY exploration agent to answer a codebase question (find files, search patterns, understand how something works). Cheaper and more thorough than exploring yourself. Specify thoroughness: 'quick', 'medium', or 'very thorough'. Returns its findings.",
      schemas.object({ question: { type: "string" }, thoroughness: { type: "string" } }, ["question"]),
      z.object({ question: z.string().min(1), thoroughness: z.enum(["quick", "medium", "very thorough"]).optional() }),
      skills,
      async (args, ctx) => {
        if (!ctx.explore) throw new Error("explore is only available to the orchestrator.");
        const { findings } = await ctx.explore(args.question, args.thoroughness);
        return { findings };
      }
    )
  );
}

export function verifyTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "verify",
      "Spawn a READ-ONLY verifier that audits the integrated result against the user's request: a requirements checklist (Phase A) and a code review for correctness/edge-cases/error-handling and LAZINESS — stubs, placeholders, TODOs, MVP shortcuts (Phase B). OPTIONAL — use at most once, for a complex or risky change; skip it for simple tasks (it is not free). Returns a structured verdict (pass/fail + must-fix issues); on fail, spawn ONE narrowly-scoped fixer for the genuine must-fix issues only.",
      schemas.object({ focus: { type: "string" } }, []),
      z.object({ focus: z.string().optional() }),
      skills,
      async (args, ctx) => {
        if (!ctx.verify) throw new Error("verify is only available to the orchestrator.");
        const { verdict, pass } = await ctx.verify(args.focus);
        return { verdict, pass };
      }
    )
  );
}

export function spawnAgentsTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "spawn_agents",
      "Spawn MULTIPLE worker sub-agents that run IN PARALLEL, each in its own git worktree. Use this for independent sub-tasks on NON-OVERLAPPING files. Each worker opens a PR; review and merge them. Returns all workers' results.",
      schemas.object({ workers: { type: "array" } }, ["workers"]),
      z.object({ workers: z.array(z.object({ name: z.string().min(1), role: z.string().min(1), brief: z.string().min(1) })).min(1) }),
      skills,
      async (args, ctx) => {
        if (!ctx.spawnWorker) throw new Error("Spawning is only available to the orchestrator.");
        const spawn = ctx.spawnWorker;
        const results = await Promise.all(args.workers.map((w) => spawn(w)));
        return { workers: args.workers.map((w, i) => ({ name: w.name, prNumber: results[i].prNumber, summary: results[i].summary })) };
      }
    )
  );
}

export function openIssueTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "open_issue",
      "Open a work item on the board. The orchestrator opens issues for sub-tasks; a worker may open one to report a blocker or bug.",
      schemas.object({ title: { type: "string" }, body: { type: "string" }, assignees: { type: "array" }, labels: { type: "array" } }, ["title", "body"]),
      z.object({ title: z.string().min(1), body: z.string(), assignees: z.array(z.string()).optional(), labels: z.array(z.string()).optional() }),
      skills,
      async (args, ctx) => {
        requireBoard(ctx);
        const issue = ctx.board.openIssue({ title: args.title, body: args.body, author: ctx.agentId ?? "?", assignees: args.assignees, labels: args.labels });
        return { number: issue.number, openIssues: ctx.board.openIssues().map((i) => i.number) };
      }
    )
  );
}

export function assignIssueTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "assign_issue",
      "Assign an issue to one or more agents.",
      schemas.object({ number: { type: "number" }, assignees: { type: "array" } }, ["number", "assignees"]),
      z.object({ number: z.number().int().positive(), assignees: z.array(z.string()).min(1) }),
      skills,
      async (args, ctx) => {
        requireBoard(ctx);
        const issue = ctx.board.assignIssue(args.number, args.assignees);
        return { number: issue.number, assignees: issue.assignees };
      }
    )
  );
}

export function commentTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "comment",
      "Comment on an issue or PR thread. Use mention to @-notify specific agents.",
      schemas.object({ on: { type: "string" }, number: { type: "number" }, body: { type: "string" }, mention: { type: "array" } }, ["on", "number", "body"]),
      z.object({ on: z.enum(["issue", "pr"]), number: z.number().int().positive(), body: z.string().min(1), mention: z.array(z.string()).optional() }),
      skills,
      async (args, ctx) => {
        requireBoard(ctx);
        const c = ctx.board.comment(args.on, args.number, { author: ctx.agentId ?? "?", body: args.body, mentions: args.mention });
        return { id: c.id };
      }
    )
  );
}

export function openPrTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "open_pr",
      "Open a pull request for your completed work (commits your worktree and proposes a merge). This is your completion signal. Provide a clear summary in the body and link the issue you resolved.",
      schemas.object({ title: { type: "string" }, body: { type: "string" }, linkedIssue: { type: "number" } }, ["title", "body"]),
      z.object({ title: z.string().min(1), body: z.string().min(1), linkedIssue: z.number().int().positive().optional() }),
      skills,
      async (args, ctx) => {
        requireBoard(ctx);
        if (!ctx.git || !ctx.agentId) throw new Error("open_pr requires a worktree-backed worker.");
        const committed = ctx.git.commitWorker(ctx.agentId, args.title);
        const pr = ctx.board.openPr({
          title: args.title,
          body: args.body,
          author: ctx.agentId,
          branch: ctx.git.workerBranch(ctx.agentId),
          base: ctx.git.integrationBranch,
          linkedIssue: args.linkedIssue
        });
        return { number: pr.number, committed };
      }
    )
  );
}

export function reviewPrTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "review_pr",
      "Review a PR: approve, request_changes, or comment.",
      schemas.object({ number: { type: "number" }, verdict: { type: "string" }, body: { type: "string" } }, ["number", "verdict", "body"]),
      z.object({ number: z.number().int().positive(), verdict: z.enum(["approve", "request_changes", "comment"]), body: z.string().min(1) }),
      skills,
      async (args, ctx) => {
        requireBoard(ctx);
        ctx.board.reviewPr(args.number, { by: ctx.agentId ?? "?", verdict: args.verdict, body: args.body });
        return { number: args.number, verdict: args.verdict };
      }
    )
  );
}

export function mergePrTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "merge_pr",
      "Merge an approved PR into the integration branch. On a merge conflict the merge is aborted and the conflicting files are reported so you can resolve (reassign / serialize).",
      schemas.object({ number: { type: "number" } }, ["number"]),
      z.object({ number: z.number().int().positive() }),
      skills,
      async (args, ctx) => {
        requireBoard(ctx);
        if (!ctx.git) throw new Error("merge_pr requires git.");
        const pr = ctx.board.requirePr(args.number);
        const merge = ctx.git.mergeWorker(pr.author);
        if (!merge.ok) {
          ctx.board.comment("pr", args.number, { author: ctx.agentId ?? "orchestrator", body: `Merge conflict in: ${merge.conflicts?.join(", ")}` });
          return { merged: false, conflicts: merge.conflicts };
        }
        ctx.board.mergePr(args.number);
        return { merged: true, closedIssue: pr.linkedIssue };
      }
    )
  );
}

export function closeIssueTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "close_issue",
      "Close an issue (work item done or no longer needed).",
      schemas.object({ number: { type: "number" } }, ["number"]),
      z.object({ number: z.number().int().positive() }),
      skills,
      async (args, ctx) => {
        requireBoard(ctx);
        ctx.board.closeIssue(args.number);
        return { number: args.number, openIssues: ctx.board.openIssues().map((i) => i.number) };
      }
    )
  );
}

export function sendDmTool(skills: ToolSkillRegistry) {
  return withProgress(
    makeTool(
      "send_dm",
      "Send a private direct message to another agent (off the public threads).",
      schemas.object({ to: { type: "string" }, body: { type: "string" } }, ["to", "body"]),
      z.object({ to: z.string().min(1), body: z.string().min(1) }),
      skills,
      async (args, ctx) => {
        requireBoard(ctx);
        ctx.board.sendDm({ from: ctx.agentId ?? "?", to: args.to, body: args.body });
        return { to: args.to };
      }
    )
  );
}
