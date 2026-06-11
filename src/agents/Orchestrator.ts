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
  debateDesignTool,
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
1. DEBATE THE DESIGN — for anything beyond a trivial change, call debate_design FIRST: proposer agents argue distinct designs and a judge picks the best. Base your plan on the chosen design. (Skip only for trivial one-file changes.)
2. PLAN — call update_plan with the decomposition: break the task into the SMALLEST independent sub-tasks (by feature / by file / by layer). A large or multi-feature request MUST become several sub-tasks; never treat "add many features" as one lump. Keep the plan updated (one step in_progress at a time) as work proceeds.
3. Open an issue per sub-task, then EXECUTE THEM IN PARALLEL: when sub-tasks touch NON-OVERLAPPING files, call spawn_agents ONCE with ALL of them so the workers run concurrently — do NOT spawn one worker, wait, then spawn the next. Use a single spawn_agent only when there is genuinely just one sub-task. Each worker gets a focused role and a precise, NARROW brief (one sub-task — never hand one worker the whole feature set). When sub-tasks SHARE a contract (an API shape, data structure, or file interface), specify that exact shared contract IN every relevant worker's brief so the parallel pieces integrate. Workers run in isolated git worktrees and open a PR when done.
NEVER pass a big multi-part task to a single worker. If you catch yourself writing a brief with "and also…", split it into more workers. Each worker has a TIGHT step budget (~30 steps) for ONE focused sub-task — do not create a "bootstrap"/"set up everything" worker; if scaffolding is needed, make it one small worker, then spawn the feature workers in parallel. If a worker reports it hit its budget without finishing, split that sub-task further and spawn several workers for the pieces.
4. Each worker's PR is automatically reviewed by INDEPENDENT adversarial critics (and a judge) who hunt for real defects; the worker gets a revision round if changes are requested. Read their review (posted on the PR), then review_pr and, if good, merge_pr. On a merge conflict, the merge is aborted and conflicts reported — reassign or serialize the conflicting work.
5. Maintain the issues as your plan. Do NOT give a final answer while issues remain open.
6. VERIFY before sign-off: every worker's PR must state how it was verified (tests/run/syntax-check). If a worker did not actually exercise its code, send it back or spawn a short verification worker to run the integrated result end-to-end (run tests, execute the program, or syntax-check). Do NOT declare success on unverified code.
7. When all work is integrated and verified, give a concise final summary of what was done and how it was checked.
Keep the team small and focused. Record durable project insight with remember when you learn the user's intent or a key assumption.`;

const WORKER_BASE = (name: string) => `You are worker sub-agent "${name}". Work ONLY on your assigned task (see the Collaboration Board for your issue and brief).
You are in an ISOLATED git worktree — edit files with apply_patch (read the lines first).
VERIFY before you finish: actually exercise what you built with run_python — run the project's tests if any exist; otherwise run the script, call the function, or syntax-check it (e.g. \`node --check file.js\`, \`python -m py_compile\`, \`tsc --noEmit\`). For a web page or visual UI, use the screenshot tool to render it and SEE it (you are multimodal) — confirm it looks right, not just that the JS parses. Do NOT open a PR for code you have not exercised — if verification is blocked (e.g. approval denied), say so explicitly in the PR body.
Discuss on the board (comment) if blocked or you need clarification; @mention the orchestrator.
You have a TIGHT step budget (~30 steps) — your sub-task should be small enough to finish well within it. If you discover it is larger than expected, do the core piece, open a PR for that, and note clearly in the PR body what remains so the orchestrator can spawn follow-up workers. Do not try to do everything yourself.
When your task is complete AND verified, call open_pr with a clear summary that states what you verified and links your issue. That is your completion signal.`;

const CRITIC_ROLE = (target: string) => `You are an INDEPENDENT, adversarial code reviewer for worker "${target}". You did NOT write this code.
Read the worker's changes (git_diff, read_file_range) and hunt for REAL problems: bugs, regressions, unhandled cases, missing or fake verification, security issues, scope drift, or claims not backed by evidence. Assume there IS a problem and try to prove it; cite concrete evidence (file:line + the actual code). Do not nitpick style.
End your reply with exactly one line "VERDICT: approve" or "VERDICT: request_changes", then a short numbered list of the concrete must-fix issues (empty if approve).`;

const PROPOSER_ROLE = (angle: string) => `You are a design proposer. Read the relevant code (read_file_range, search_text, get_file_overview) and propose a CONCRETE design for the task, optimized for: ${angle}.
Be specific — name files, structure, key interfaces/data shapes — and cite evidence from the codebase. Note trade-offs honestly. Be concise (no code dumps).`;

const DESIGN_JUDGE_ROLE = `You are a NEUTRAL design judge. Several proposers gave designs for the same task.
Choose the best overall design, or SYNTHESIZE the strongest combination, weighing evidence and trade-offs. Default to where proposers agree, but override with strong concrete evidence (guard against a misled consensus). Be decisive and specific so an implementer can follow it. End with a clear "CHOSEN DESIGN:" section listing the concrete approach + the sub-tasks it implies.`;

const JUDGE_ROLE = `You are a NEUTRAL judge. Several independent reviewers gave verdicts on a PR.
Decide APPROVE or REQUEST_CHANGES. Default to the MAJORITY verdict — BUT weigh the EVIDENCE: if a minority cites decisively stronger, concrete evidence of a real defect, side with them. Explicitly guard against a misled majority (do not just count votes).
Justify briefly citing the strongest evidence. End with exactly one line "DECISION: approve" or "DECISION: request_changes", then the consolidated must-fix issues.`;

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
      eventSinkFactory?: (label: string, isWorker: boolean) => AgentEventSink;
    } = {}
  ) {
    this.git = new GitService(config.workspaceRoot, runId);
    this.approval = new ApprovalPolicy(config.approval, originalTask);
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
          debateDesignTool(s),
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

    // Adversarial PR review (debate-v1): independent critics + judge. On
    // request_changes, give the worker ONE revision round with the feedback.
    if (this.config.enableDebate && pr && !this.runSignal?.aborted) {
      const review = await this.critique(spec, dir);
      this.board.comment("pr", pr.number, { author: `review:${spec.name}`, body: review.feedback.slice(0, 1500) });
      if (review.requestChanges && !this.runSignal?.aborted) {
        const reviseLoop = this.buildLoop({
          root: dir,
          agentId: spec.name,
          role: `${WORKER_BASE(spec.name)}\n\nYour role:\n${spec.role}`,
          isOrchestrator: false,
          extraTools: (s) => [openPrTool(s), commentTool(s), openIssueTool(s), sendDmTool(s)]
        });
        try {
          summary = await reviseLoop.run(`Reviewers requested changes on your PR. Address each point concretely, then re-verify:\n${review.feedback}`, true, this.runSignal);
          this.git.commitWorker(spec.name, `revisions by ${spec.name}`);
          summary += "\n\n[review] changes were requested and addressed in one revision round.";
        } catch (error) {
          summary += `\n\n[review] revision round did not complete: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        summary += "\n\n[review] approved by independent critics.";
      }
    }
    return { prNumber: pr?.number, summary };
  };

  /** Run a read-only discussant (critic / judge) and return its text. Never throws. */
  private async runDiscussant(name: string, role: string, brief: string, root: string): Promise<string> {
    const loop = this.buildLoop({ root, agentId: name, role, isOrchestrator: false, readOnly: true, extraTools: (s) => [commentTool(s)] });
    try {
      return await loop.run(brief, true, this.runSignal);
    } catch (error) {
      return `(${name} could not complete: ${error instanceof Error ? error.message : String(error)})`;
    }
  }

  /**
   * Adversarial PR review (debate-v1 §1): N independent critics hunt for problems
   * in the worker's diff; when there are several, a neutral judge decides with
   * evidence-weighted majority. Returns whether changes are required + feedback.
   */
  private async critique(spec: { name: string; role: string; brief: string }, dir: string): Promise<{ requestChanges: boolean; feedback: string }> {
    const n = Math.max(1, this.config.debateCritics ?? 2);
    const reviews = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        this.runDiscussant(
          `critic:${spec.name}#${i + 1}`,
          CRITIC_ROLE(spec.name),
          `Adversarially review worker "${spec.name}"'s changes (its brief was: ${spec.brief}). Find real defects with evidence.`,
          dir
        )
      )
    );
    const verdicts = reviews.map((r) => /VERDICT:\s*request_changes/i.test(r));
    if (n === 1) return { requestChanges: verdicts[0], feedback: reviews[0] };
    const judgeText = await this.runDiscussant(
      `judge:${spec.name}`,
      JUDGE_ROLE,
      `Reviewers' verdicts on worker "${spec.name}"'s PR:\n\n${reviews.map((r, i) => `--- Reviewer ${i + 1} ---\n${r}`).join("\n\n")}`,
      dir
    );
    return { requestChanges: /DECISION:\s*request_changes/i.test(judgeText), feedback: judgeText };
  }

  /**
   * Design debate (debate-v1 §2): proposer agents argue distinct designs, then a
   * judge picks/synthesizes the best with evidence-weighted reasoning. Runs in
   * the repo root (read-only). Returns the chosen design for decomposition.
   */
  private readonly debateDesign = async (question: string, options?: string[]): Promise<{ design: string }> => {
    const angles = options && options.length > 0
      ? options
      : ["the simplest design that fully meets the requirement", "the most extensible / modular design", "the most robust and correct design"];
    const proposers = angles.slice(0, this.config.debateProposers ?? 2);
    const proposals = await Promise.all(
      proposers.map((angle, i) => this.runDiscussant(`designer#${i + 1}`, PROPOSER_ROLE(angle), `Design question: ${question}`, this.config.workspaceRoot))
    );
    const design = await this.runDiscussant(
      "design-judge",
      DESIGN_JUDGE_ROLE,
      `Task: ${question}\n\nProposals:\n\n${proposals.map((p, i) => `--- Proposal ${i + 1} (${proposers[i]}) ---\n${p}`).join("\n\n")}`,
      this.config.workspaceRoot
    );
    return { design };
  };

  private buildLoop(opts: {
    root: string;
    agentId: string;
    role: string;
    isOrchestrator: boolean;
    /** Read-only discussant (critic/proposer/judge): strip mutating/shell tools like the orchestrator. */
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
    // from TOOL_EFFECTS so new tools are classified automatically).
    const mutating = (name: string) => TOOL_EFFECTS[name]?.modifiesWorkspace || TOOL_EFFECTS[name]?.isShell;
    const stripMutating = opts.isOrchestrator || Boolean(opts.readOnly);
    const allowedNames = stripMutating ? LOCAL_TOOL_NAMES.filter((n) => !mutating(n)) : LOCAL_TOOL_NAMES;
    const toolSkills = new ToolSkillRegistry(opts.root);
    toolSkills.loadBuiltin(allowedNames);
    const fullTools = createLocalToolRegistry(toolSkills);
    const tools = new ToolRegistry();
    for (const tool of fullTools.list()) {
      if (stripMutating && mutating(tool.name)) continue;
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
      debateDesign: opts.isOrchestrator && this.config.enableDebate ? this.debateDesign : undefined,
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
      maxSteps: opts.isOrchestrator ? this.config.maxSteps : Math.min(this.config.maxSteps, 30)
    };
    const events = this.eventSinkFactory(opts.agentId, !opts.isOrchestrator);
    const interjections = opts.isOrchestrator ? this.interjections : undefined;
    return new AgentLoop(this.provider, config, context, tools, toolCtx, skillLoader, toolSkills, opts.role, events, this.usage, opts.agentId, interjections);
  }
}
