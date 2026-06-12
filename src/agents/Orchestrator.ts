import type { LLMProvider } from "../api/LLMProvider.js";
import type { GrokCodeConfig } from "../config/loadConfig.js";
import { ContextManager } from "../context/ContextManager.js";
import { ContextEngine } from "../context/ContextEngine.js";
import { WorkspaceSandbox } from "../workspace/WorkspaceSandbox.js";
import { WorkspaceSnapshotStore } from "../workspace/WorkspaceSnapshotStore.js";
import { ProjectMemory } from "../memory/ProjectMemory.js";
import { BackgroundProcessManager } from "../background/BackgroundProcessManager.js";
import { ApprovalPolicy } from "../approval/ApprovalPolicy.js";
import { ToolSkillRegistry } from "../tool-skills/ToolSkillRegistry.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import { LOCAL_TOOL_NAMES, createLocalToolRegistry } from "../tools/definitions/index.js";
import { TOOL_EFFECTS } from "../tools/toolEffects.js";
import type { AgentTool, ToolExecutionContext, SpawnWorker } from "../tools/AgentTool.js";
import { ToolRegistry } from "../tools/ToolRegistry.js";
import { scanRepo } from "../workspace/RepoScanner.js";
import { AgentLoop } from "../agent/AgentLoop.js";
import { LabeledEventSink, type AgentEventSink } from "../agent/AgentEvents.js";
import type { ApprovalPrompter } from "../approval/ApprovalPolicy.js";
import type { SessionUsage } from "../agent/SessionUsage.js";
import type { Interjections } from "../agent/Interjections.js";
import { Board } from "./Board.js";
import { GitService } from "./GitService.js";
import {
  spawnAgentTool,
  spawnAgentsTool,
  exploreTool,
  verifyTool,
  openIssueTool,
  assignIssueTool,
  commentTool,
  reviewPrTool,
  mergePrTool,
  closeIssueTool,
  sendDmTool,
  openPrTool
} from "../tools/definitions/collaboration.js";

const ORCHESTRATOR_ROLE = `You are the ORCHESTRATOR of a team of sub-agents.
You have NO file-editing or shell tools (no apply_patch, no run_python) — you literally cannot modify the repo or run commands. Only your worker sub-agents can change files. So never try to write files yourself; if a change is needed, delegate it.
If the task is just a QUESTION or analysis that needs NO file changes, answer it DIRECTLY using your read tools (read_file_range, search_text, get_file_overview, git_status/diff) — do NOT open issues or spawn workers for that.
For any task that CHANGES files, you delegate. Process:
1. SCOPE FIRST — if the request is OPEN or under-specified (multiple reasonable interpretations, unstated goal/data source/scope/look-and-feel), call ask_user ONCE up front to clarify at the CONCEPT level (end goal, key priorities, hard constraints) — batch all questions into that single call, ask the "what" not the "how". Do this BEFORE planning or spawning anyone. Skip it only when the task is genuinely clear; when you do skip, state your key assumptions. Never spawn workers to build the wrong thing because you didn't ask.
2. PLAN with the FEWEST workers. First understand the task (call explore — a cheap read-only agent, thoroughness quick/medium/very thorough — to map the codebase instead of exploring deeply yourself). Every extra worker is pure overhead in this system: each one rebuilds its own context, plans, reads, and verifies, and carries its own full transcript — so MORE workers means MORE total tokens, NOT less. Decompose only when it genuinely pays off:
   - A single COHESIVE deliverable → ONE worker builds it end-to-end. A web page, a module, a feature, a self-contained script is cohesive — do NOT split it across workers just to "parallelize". Splitting interlocking parts (e.g. one page's HTML/CSS/JS) costs more total tokens AND risks integration breakage; one worker that owns the whole cohesive thing is both cheaper and more coherent.
   - Spawn MULTIPLE workers ONLY when the task genuinely consists of INDEPENDENT parts that don't interlock and would each stand alone — e.g. "a backend API AND a separate CLI AND docs", or several unrelated files/subsystems. Each truly-independent part = one worker, in parallel.
   - When in doubt, use ONE worker. Reach for more only when you can name the independent parts and explain why they don't interlock.
   - Merge-clean boundaries (only relevant when you DO split): separate FILES never conflict; do NOT split a single file across workers (add/add or hunk conflicts). Put the shared CONTRACT (exact names, data shapes, file interfaces) in every relevant worker's brief so independent pieces integrate.
   Keep the plan updated (one step in_progress at a time) as work proceeds.
3. Open an issue per sub-task. If there are several INDEPENDENT sub-tasks, call spawn_agents ONCE with ALL of them so they run concurrently — do NOT spawn one, wait, then spawn the next. For a single cohesive deliverable, just spawn_agent ONE worker. Each worker gets a focused role and a precise brief. Workers open a PR when done.
If a worker hits its step budget without finishing, the sub-task was genuinely large — only THEN split it into smaller pieces and spawn more workers. Don't create a "bootstrap"/"set up everything" worker.
Brief workers like SENIOR ENGINEERS, not junior helpers: explain WHAT you need and WHY (the context), share what you already know (file paths, function names, decisions, the shared contract), describe the END STATE rather than dictating step-by-step commands (trust their judgment on HOW), and include clear ACCEPTANCE CRITERIA — what does "done" look like (including how to verify). Spawn early and liberally; do NOT do deep exploration or edits yourself when a worker would do it better. Don't wait for one worker before spawning others that don't depend on it.
4. Review and integrate: read each worker's PR (and its stated verification) and git_diff. HOLD THE QUALITY BAR: if the PR ships stubs/placeholders/TODOs/MVP shortcuts, skipped verification, or ignores the existing architecture, request_changes and send it back — do NOT merge half-done or corner-cut work. Otherwise review_pr (approve) and merge_pr. On a merge conflict, the merge is aborted and conflicts reported — reassign or serialize the conflicting work.
5. Maintain the issues as your plan. Do NOT give a final answer while issues remain open.
6. VERIFY before sign-off — at most ONCE, and only when it's worth it: each worker verifies its OWN sub-task before its PR (trust that). For a COMPLEX or RISKY change, once everything is merged you MAY call verify ONCE (a read-only audit: requirements checklist + code review for correctness, edge cases, error handling, and LAZINESS). SKIP verify for simple/low-risk tasks — it is not free. If verify returns fail, only act on GENUINE must-fix issues: spawn ONE NARROWLY-SCOPED fixer whose brief lists those exact issues and says "make these targeted fixes ONLY — do NOT re-plan, re-architect, or rebuild; tight budget." Note minor/cosmetic findings in your summary instead of spawning a fix cycle. Never call verify repeatedly, never read entire large merged files into your own context, never spawn endless "polish" workers.
7. When the work is integrated (and any must-fix issues are addressed), give a concise final summary of what was done and how it was checked. Finish promptly.
Keep the team small and focused. Record durable project insight with remember when you learn the user's intent or a key assumption.`;

const WORKER_BASE = (name: string) => `You are worker sub-agent "${name}". Work ONLY on your assigned task (see the Collaboration Board for your issue and brief).
You are in an ISOLATED git worktree — edit files with apply_patch (read the lines first).
DELIVER A COMPLETE, PRODUCTION-QUALITY implementation of your sub-task — design the approach first, then implement it fully. NO stubs, placeholders, TODOs, "rest unchanged" elisions, mock/hardcoded stand-ins, or MVP shortcuts: the patch gate WILL reject them and your PR will be sent back. Handle errors and edge cases, and match the existing code's patterns. If the sub-task is too big for your budget, implement a genuinely complete SLICE (no markers) and report exactly what remains — never fake completeness.
READ EFFICIENTLY — do not waste your step budget re-reading: use get_file_overview ONCE to orient on a file, then read only the specific range you need. You ALREADY have in context what you read earlier and what you just wrote with apply_patch — do NOT re-read the whole file after editing to "confirm" it; trust the patch result (a single targeted re-read of just the changed region is fine if truly needed). Prefer writing the file in as few apply_patch calls as possible (build the whole file/section in one patch) rather than many incremental edits each followed by a re-read.
VERIFY before you finish: actually exercise what you built with run_python — run the project's tests if any exist; otherwise run the script, call the function, or syntax-check it (e.g. \`node --check file.js\`, \`python -m py_compile\`, \`tsc --noEmit\`). For a web page or visual UI, use the screenshot tool to render it and SEE it (you are multimodal) — confirm it looks right, not just that the JS parses. Do NOT open a PR for code you have not exercised — if verification is blocked (e.g. approval denied), say so explicitly in the PR body.
Discuss on the board (comment) if blocked or you need clarification; @mention the orchestrator.
You have a TIGHT step budget (~30 steps) — your sub-task should be small enough to finish well within it. If you discover it is larger than expected, do the core piece, open a PR for that, and note clearly in the PR body what remains so the orchestrator can spawn follow-up workers. Do not try to do everything yourself.
When your task is complete AND verified, call open_pr with a clear summary that states what you verified and links your issue. That is your completion signal.`;

const EXPLORE_ROLE = (thoroughness: string) => `You are a fast, READ-ONLY codebase exploration agent. You have NO editing tools.
Answer the orchestrator's question by searching and reading. Adapt to the requested thoroughness "${thoroughness}":
- "quick": 1-3 targeted searches/reads, return the first solid findings.
- "medium": explore 5-10 files, try alternate naming conventions.
- "very thorough": exhaustive search across multiple directories, naming patterns, and related files.
Start broad (search_text / get_file_overview / list_files), then narrow to precise read_file_range. Issue independent reads/searches together in one turn (they run in parallel). Stay inside the workspace; if something isn't found, report that rather than broadening scope.
Return a concise findings report with ABSOLUTE file paths and the relevant code snippets / file:line references the orchestrator needs. Do not speculate beyond what you read.`;

const VERIFIER_ROLE = `You are a meticulous, READ-ONLY verifier. You did NOT write this code. You have NO editing tools.
Determine whether the integrated result correctly and COMPLETELY satisfies the user's request. Use git_diff / read_file_range / search_text to inspect the actual changes.
Two phases:
- PHASE A — Requirements: restate the user's request as a concrete checklist of deliverables/success criteria (include follow-ups and corrections), and check each off against what was actually done.
- PHASE B — Code review (when code changed): check correctness first, then edge cases, error handling, unhandled failure modes, and — critically — LAZINESS: stubs, placeholders, TODOs, "rest unchanged" elisions, mock/hardcoded stand-ins, or scope quietly narrowed to an MVP. Cite file:line for every issue.
End with exactly one line "VERDICT: pass" or "VERDICT: fail", then a short numbered list of concrete must-fix issues (empty if pass). Do not fix anything yourself.`;

export type OrchestratorResult = { report: string; integrationBranch: string; diff: string; ephemeral: boolean; applied: boolean };

/**
 * Drives a multi-agent run (subagents-v1). The orchestrator is an AgentLoop with
 * collaboration tools; `spawn_agent` runs a worker AgentLoop to completion in its
 * own git worktree (sequential in v1). Workers open PRs; the orchestrator reviews
 * and merges into the integration branch.
 */
export class Orchestrator {
  private readonly board = new Board();
  private readonly git: GitService;
  private readonly background = new BackgroundProcessManager();
  private readonly approval: ApprovalPolicy;
  private readonly memory: ProjectMemory;
  private spawnCount = 0;
  private setupDone = false;
  private runSignal?: AbortSignal;
  private currentTask = "";

  private readonly applyToWorkingTree: boolean;
  private readonly usage?: SessionUsage;
  private readonly interjections?: Interjections;
  private readonly askUser?: ToolExecutionContext["askUser"];
  private readonly eventSinkFactory: (label: string, isWorker: boolean) => AgentEventSink;

  constructor(
    private readonly provider: LLMProvider,
    private readonly config: GrokCodeConfig,
    runId: string,
    originalTask = "",
    opts: {
      applyToWorkingTree?: boolean;
      usage?: SessionUsage;
      interjections?: Interjections;
      askUser?: ToolExecutionContext["askUser"];
      approvalPrompter?: ApprovalPrompter;
      /** Share the caller's live ApprovalPolicy so mid-run mode changes (dropdown / auto-approve toggle) reach workers. */
      approval?: ApprovalPolicy;
      eventSinkFactory?: (label: string, isWorker: boolean) => AgentEventSink;
    } = {}
  ) {
    this.git = new GitService(config.workspaceRoot, runId);
    // Prefer the caller's live policy (interactive UI): the user can change the
    // approval mode or flip auto-approve mid-run and it must affect the running
    // orchestrator AND every worker (they share this instance). Only fall back to
    // a fresh snapshot when no shared policy is supplied (one-shot CLI runs).
    this.approval = opts.approval ?? new ApprovalPolicy(config.approval, originalTask);
    this.memory = new ProjectMemory(config.workspaceRoot);
    // Interactive use applies the result to the working tree; one-shot real-git
    // runs leave a review branch instead.
    this.applyToWorkingTree = opts.applyToWorkingTree ?? false;
    // Shared so orchestrator + every worker's token usage rolls up to the session.
    this.usage = opts.usage;
    // Mid-task user messages are delivered to the orchestrator only (workers
    // follow their fixed brief), so the user talks to the one driving the plan.
    this.interjections = opts.interjections;
    // The orchestrator is the user-facing agent, so it (and only it) can ask the
    // user scoping questions via ask_user.
    this.askUser = opts.askUser;
    // Web mode routes approval questions to the browser.
    if (opts.approvalPrompter) this.approval.prompter = opts.approvalPrompter;
    // Web mode streams agent activity to the browser instead of the console.
    this.eventSinkFactory = opts.eventSinkFactory ?? ((label, isWorker) => new LabeledEventSink(label, isWorker));
  }

  async run(task: string, signal?: AbortSignal): Promise<OrchestratorResult> {
    this.currentTask = task;
    // Remember the run's signal so spawned workers receive it too — otherwise an
    // interrupt (web Stop / Esc) aborts only the orchestrator while workers grind on.
    this.runSignal = signal;
    // Non-git workspace: set up a throwaway git repo behind the scenes; the
    // integrated result is applied to the working tree and git is removed after,
    // so the user never sees git was used.
    const ephemeral = !this.git.isGitRepo();
    if (ephemeral) this.git.initEphemeral();
    try {
      // The orchestrator reads the user's actual working tree; git worktrees are
      // only created lazily once it delegates (see ensureSetup). Pure questions
      // never touch git.
      const loop = this.buildLoop({
        root: this.config.workspaceRoot,
        agentId: "orchestrator",
        role: ORCHESTRATOR_ROLE,
        isOrchestrator: true,
        extraTools: (s) => [
          spawnAgentTool(s),
          spawnAgentsTool(s),
          exploreTool(s),
          verifyTool(s),
          openIssueTool(s),
          assignIssueTool(s),
          commentTool(s),
          reviewPrTool(s),
          mergePrTool(s),
          closeIssueTool(s),
          sendDmTool(s)
        ]
      });
      // oneShot:false — the orchestrator's report IS the user-facing answer, so
      // it must stay clean (no machine-readable [Actions completed]/[Final checks]
      // tail). Workers keep oneShot:true since their output is internal.
      const report = await loop.run(task, false, signal);
      let diff = "";
      if (this.setupDone) {
        diff = this.git.integrationDiff();
        if (ephemeral) this.git.applyIntegrationToWorkingTree();
        else if (this.applyToWorkingTree) this.git.checkoutIntegrationIntoWorkingTree();
      }
      const applied = ephemeral || this.applyToWorkingTree;
      return { report, integrationBranch: this.git.integrationBranch, diff, ephemeral, applied };
    } finally {
      if (this.setupDone) this.git.teardown();
      if (this.setupDone && this.applyToWorkingTree && !ephemeral) this.git.deleteIntegrationBranch();
      if (ephemeral) this.git.removeEphemeralGit();
    }
  }

  private ensureSetup(): void {
    if (this.setupDone) return;
    this.git.setup();
    this.setupDone = true;
  }

  private readonly spawnWorker: SpawnWorker = async (spec) => {
    if (this.spawnCount >= 12) {
      return { summary: "Spawn budget exhausted; cannot create more workers." };
    }
    this.ensureSetup();
    this.spawnCount++;
    const { dir } = this.git.addWorker(spec.name);
    const loop = this.buildLoop({
      root: dir,
      agentId: spec.name,
      role: `${WORKER_BASE(spec.name)}\n\nYour role:\n${spec.role}`,
      isOrchestrator: false,
      extraTools: (s) => [openPrTool(s), commentTool(s), openIssueTool(s), sendDmTool(s)]
    });
    let summary: string;
    try {
      summary = await loop.run(spec.brief, true, this.runSignal);
    } catch (error) {
      // Settle (don't reject) so a sibling worker's rejection in Promise.all
      // can't become an unhandled rejection; the orchestrator's own abort check
      // unwinds the run. On interrupt, skip opening a PR for partial work.
      const message = error instanceof Error ? error.message : String(error);
      if (/interrupt|abort/i.test(message)) return { summary: `Worker "${spec.name}" interrupted.` };
      return { summary: `Worker "${spec.name}" failed: ${message}` };
    }

    // Worker ran out of its step budget → the sub-task was too big. Don't open a
    // PR for half-finished work; tell the orchestrator to split it further.
    if (/Stopped after max steps/i.test(summary) && ![...this.board.prs.values()].some((p) => p.author === spec.name)) {
      return { summary: `Worker "${spec.name}" hit its step budget WITHOUT finishing — the sub-task is too large. Split it into smaller, non-overlapping sub-tasks and spawn several workers (spawn_agents) for them.` };
    }

    // Ensure the work is captured as a PR even if the worker forgot to open one.
    let pr = [...this.board.prs.values()].find((p) => p.author === spec.name && p.status === "open");
    if (!pr) {
      const committed = this.git.commitWorker(spec.name, `work by ${spec.name}`);
      if (committed) {
        pr = this.board.openPr({
          title: `Work by ${spec.name}`,
          body: summary.slice(0, 800),
          author: spec.name,
          branch: this.git.workerBranch(spec.name),
          base: this.git.integrationBranch
        });
      }
    }

    return { prNumber: pr?.number, summary };
  };

  /** Run a pure read-only helper agent (explore / verify) and return its text. Never throws. */
  private async runReadOnlyAgent(name: string, role: string, brief: string): Promise<string> {
    const loop = this.buildLoop({
      root: this.config.workspaceRoot,
      agentId: name,
      role,
      isOrchestrator: false,
      readOnly: true,
      extraTools: () => []
    });
    try {
      return await loop.run(brief, true, this.runSignal);
    } catch (error) {
      return `(${name} could not complete: ${error instanceof Error ? error.message : String(error)})`;
    }
  }

  /** Spawn a read-only explore agent for cheap context gathering (orchestrator only). */
  private readonly explore = async (question: string, thoroughness = "medium"): Promise<{ findings: string }> => {
    const findings = await this.runReadOnlyAgent("explore", EXPLORE_ROLE(thoroughness), `Exploration request: ${question}`);
    return { findings };
  };

  /** Spawn a read-only verifier to audit the integrated result against the task (orchestrator only). */
  private readonly verify = async (focus?: string): Promise<{ verdict: string; pass: boolean }> => {
    const brief = `User's request:\n${this.currentTask}\n\n${focus ? `Focus especially on: ${focus}\n\n` : ""}Verify the integrated result now.`;
    const verdict = await this.runReadOnlyAgent("verifier", VERIFIER_ROLE, brief);
    return { verdict, pass: /VERDICT:\s*pass/i.test(verdict) };
  };

  private buildLoop(opts: {
    root: string;
    agentId: string;
    role: string;
    isOrchestrator: boolean;
    /** Pure read-only helper (explore / verify): only inspection tools, tight budget, no worktree/PR. */
    readOnly?: boolean;
    extraTools: (skills: ToolSkillRegistry) => AgentTool[];
  }): AgentLoop {
    const sandbox = new WorkspaceSandbox(opts.root, this.config.sandboxProfile, this.config.workspaceTrusted);
    const context = new ContextManager();
    const engine = new ContextEngine();
    const snapshots = new WorkspaceSnapshotStore(opts.root);
    // The orchestrator plans and delegates — it must not change the repo or run
    // shell commands itself, so workers are the only agents that touch files.
    // Strip every workspace-mutating / shell tool from its registry (derived
    // from TOOL_EFFECTS so new tools are classified automatically). Read-only
    // helpers are tighter still: pure inspection tools only.
    const mutating = (name: string) => TOOL_EFFECTS[name]?.modifiesWorkspace || TOOL_EFFECTS[name]?.isShell;
    const pureRead = (name: string) => TOOL_EFFECTS[name]?.readOnly === true;
    const allowed = opts.readOnly ? pureRead : opts.isOrchestrator ? (n: string) => !mutating(n) : () => true;
    const allowedNames = LOCAL_TOOL_NAMES.filter(allowed);
    const toolSkills = new ToolSkillRegistry(opts.root);
    toolSkills.loadBuiltin(allowedNames);
    const fullTools = createLocalToolRegistry(toolSkills);
    const tools = new ToolRegistry();
    for (const tool of fullTools.list()) {
      if (!allowed(tool.name)) continue;
      tools.register(tool);
    }
    for (const tool of opts.extraTools(toolSkills)) tools.register(tool);
    const skillLoader = new SkillLoader(opts.root);

    context.upsert("repo-summary", { type: "repo_summary", content: scanRepo(opts.root), priority: 80, pinned: true });
    context.upsert("environment-policy", {
      type: "environment_policy",
      content: "Prefer project-local setup. Global environment changes require explicit approval.",
      priority: 100,
      pinned: true
    });

    let round = 0;
    const toolCtx: ToolExecutionContext = {
      workspaceRoot: opts.root,
      sandbox,
      approval: this.approval,
      background: this.background,
      context,
      engine,
      snapshots,
      memory: this.memory,
      round: () => ++round,
      board: this.board,
      git: this.git,
      agentId: opts.agentId,
      spawnWorker: opts.isOrchestrator ? this.spawnWorker : undefined,
      explore: opts.isOrchestrator ? this.explore : undefined,
      verify: opts.isOrchestrator ? this.verify : undefined,
      // Only the orchestrator faces the user, so only it can ask scoping questions.
      askUser: opts.isOrchestrator ? this.askUser : undefined,
      images: []
    };

    // Workers get a tight step budget: one focused sub-task should fit in well
    // under this. Hitting the cap is a signal the sub-task was too big and must
    // be split — it stops a single worker from grinding for dozens of steps.
    const config: GrokCodeConfig = {
      ...this.config,
      workspaceRoot: opts.root,
      maxSteps: opts.isOrchestrator ? this.config.maxSteps : Math.min(this.config.maxSteps, opts.readOnly ? 14 : 30)
    };
    const events = this.eventSinkFactory(opts.agentId, !opts.isOrchestrator);
    const interjections = opts.isOrchestrator ? this.interjections : undefined;
    return new AgentLoop(this.provider, config, context, tools, toolCtx, skillLoader, toolSkills, opts.role, events, this.usage, opts.agentId, interjections);
  }
}
