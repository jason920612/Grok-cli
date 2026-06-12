import ora from "ora";
import chalk from "chalk";
import type { LLMProvider, ModelMessage } from "../api/LLMProvider.js";
import type { ResponseTool } from "../api/responsesClient.js";
import type { GrokCodeConfig } from "../config/loadConfig.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolExecutionContext } from "../tools/AgentTool.js";
import { TOOL_EFFECTS } from "../tools/toolEffects.js";
import { readTextFile } from "../workspace/FileSystem.js";
import { DoomLoopDetector } from "./DoomLoopDetector.js";
import type { SkillLoader } from "../skills/SkillLoader.js";
import type { ToolSkillRegistry } from "../tool-skills/ToolSkillRegistry.js";
import type { ContextItem } from "../context/ContextItem.js";
import { TUNING } from "../config/tuning.js";
import { buildSystemPreamble } from "./modelInputBuilder.js";
import { finalAnswerGate } from "./finalAnswerGate.js";
import { VerifierAgent, buildVerifierFeedback } from "./VerifierAgent.js";
import type { EvidenceBundle, EvidenceMemoryFact, VerifierVerdict } from "./EvidenceBundle.js";
import { LoopState } from "./LoopState.js";
import { ToolExecutor } from "./ToolExecutor.js";
import { EmptyResponseGuard, PlanOnlyGuard, MultiToolGuard, type ResponseGuard } from "./ResponseGuards.js";
import { RollingSummarizer, mergeSummaries, renderSummary, EMPTY_SUMMARY, type EpisodeSummary } from "../context/RollingSummarizer.js";
export { shouldContinueAfterPlanOnlyResponse } from "./ResponseGuards.js";
import { ConsoleEventSink, type AgentEventSink } from "./AgentEvents.js";
import { formatTotals, type SessionUsage } from "./SessionUsage.js";
import type { Interjections } from "./Interjections.js";

/**
 * Tool results safe to elide from the transcript: re-fetchable READ/SEARCH
 * output whose only value is the data itself (the model can re-run the tool to
 * get it back). Collaboration / state / mutation results are deliberately
 * excluded — they record what the agent DID and are its working memory.
 */
const ELIDABLE_RESULTS = new Set<string>([
  "read_file_range",
  "get_file_overview",
  "get_related_files",
  "search_text",
  "search_code",
  "list_files",
  "read_background_output"
]);

const HANDOFF_SYSTEM =
  "You produce a faithful handoff summary of an in-progress coding agent's conversation so a successor can resume the SAME task seamlessly after the earlier turns are discarded. " +
  "Optimize for COMPLETENESS and precision over brevity — it is far worse to drop a critical detail than to be verbose. " +
  "If the conversation already contains a prior handoff summary, treat it as authoritative for the early history and carry its still-relevant information forward so nothing is lost across successive compactions. Do not solve the task — only summarize state.";

/**
 * AgentLoop (§7) — pure-stateless orchestrator. No conversation-chain modes;
 * every step rebuilds the full input from the ContextManager and tool-action
 * trace, and the provider abstraction sends it statelessly.
 */
export class AgentLoop {
  private readonly verifier?: VerifierAgent;
  /** This agent's own cumulative token usage, surfaced per-call so each agent's progress is visible. */
  private readonly ownUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, calls: 0 };
  /** Detects the model thrashing on the same operation/cycle (grok-build doom-loop). */
  private readonly doomLoop = new DoomLoopDetector();
  private readonly emptyGuard = new EmptyResponseGuard();
  private readonly planOnlyGuard = new PlanOnlyGuard();
  private readonly multiToolGuard = new MultiToolGuard();

  constructor(
    private readonly provider: LLMProvider,
    private readonly config: GrokCodeConfig,
    private readonly context: ContextManager,
    private readonly tools: ToolRegistry,
    private readonly toolCtx: ToolExecutionContext,
    private readonly skillLoader: SkillLoader,
    private readonly toolSkills: ToolSkillRegistry,
    private readonly projectInstructions: string,
    private readonly events: AgentEventSink = new ConsoleEventSink(),
    private readonly usage?: SessionUsage,
    /** Agent label for multi-agent runs; when set, live spinners are suppressed. */
    private readonly label?: string,
    /** Mid-task user messages, drained at the top of each step. */
    private readonly interjections?: Interjections
  ) {
    this.verifier = config.enableVerifier ? new VerifierAgent(provider, config) : undefined;
    this.summarizer = config.enableLlmSummary ? new RollingSummarizer(provider) : undefined;
  }

  private readonly summarizer?: RollingSummarizer;
  private history: EpisodeSummary = EMPTY_SUMMARY;

  async run(task: string, oneShot: boolean, signal?: AbortSignal): Promise<string> {
    this.context.upsert("user-task", { type: "user_task", content: task, priority: 100, pinned: true });

    const state = new LoopState(this.config.maxSteps, signal);
    const executor = new ToolExecutor(this.tools, this.toolCtx, this.context);
    const guards: ResponseGuard[] = [this.emptyGuard, this.planOnlyGuard];
    const executorTrace: string[] = [];
    let verifierAttempts = 0;
    let lastVerifierVerdict: VerifierVerdict | undefined;
    let finalText = "";
    let noProgressStreak = 0;
    let todoGateNudges = 0;

    // Codex-style transcript: stable system preamble + task, then accumulating
    // assistant / tool_call / tool-result turns. Sent in full each step (no
    // server-side chaining); the model sees everything it has done, so it never
    // has to re-read what it already observed.
    const system = buildSystemPreamble({
      toolIndex: this.toolSkills.toolIndex(),
      // Keep the (cached) preamble lean: the tool index already lists every tool
      // tersely, so include only the few most-relevant full skills, not the max.
      generalSkills: this.skillLoader.select(task, 3),
      toolSkills: this.toolSkills.select(task, [], 4),
      projectInstructions: this.projectInstructions,
      projectMemory: this.toolCtx.memory?.toPreamble(),
      userProfile: this.toolCtx.userProfile?.toPreamble(),
      boardView: this.toolCtx.board?.viewFor(this.toolCtx.agentId ?? "?", this.toolCtx.agentId === "orchestrator"),
      workspaceContext: this.workspaceContext()
    });
    const messages: ModelMessage[] = [
      { role: "system", content: system },
      { role: "user", content: `<Current Task>\n${task}\n</Current Task>` }
    ];

    while (state.advance()) {
      this.context.nextStep(task);
      // Deliver any mid-task messages the user typed since the last step.
      for (const note of this.interjections?.drain() ?? []) {
        messages.push({ role: "user", content: `<User interjection (mid-task)>\n${note}\n</User interjection>` });
        this.events.emit({ type: "info", message: `↪ picked up your message: "${note}"` });
      }
      this.repairTranscript(messages);
      this.compactTranscript(messages);
      // When the transcript is still large after mechanical eliding (lots of
      // state/mutation turns that elision can't touch), summarize the old part
      // into a handoff brief and re-hydrate the key files (Codex-style).
      await this.maybeCompactTranscript(messages, task);

      // No live spinner when (a) labeled multi-agent — concurrent workers would
      // corrupt each other's spinner on one TTY — or (b) an interjection channel
      // exists: the user may type mid-task and ora's line redraw would erase
      // their echoed keystrokes. Those modes get a plain step line instead.
      // discardStdin:false — the REPL owns stdin (raw mode, interjection); ora's
      // default stdin grab leaves a lingering handle that hangs process exit.
      const liveSpinner = !this.label && !this.interjections;
      const spinner = liveSpinner ? ora({ text: `Grok thinking (step ${state.step})`, discardStdin: false }).start() : null;
      if (!spinner && !this.label) {
        this.events.emit({ type: "step", step: state.step, message: chalk.dim(`Grok thinking (step ${state.step})…`) });
      }
      let response;
      try {
        response = await this.provider.complete({
          messages,
          tools: this.tools.schemas(serverTools(this.config)),
          toolChoice: this.config.toolChoice,
          // Allow the model to batch READ-ONLY tools in one turn (executed in
          // parallel below) to cut round-trips; mutating/shell tools are kept to
          // one per turn by the read-only-batch check after the response.
          parallelToolCalls: true,
          signal
        });
      } finally {
        if (spinner) spinner.stop();
      }
      this.usage?.record(response.usage);
      if (response.usage) {
        this.ownUsage.calls += 1;
        this.ownUsage.inputTokens += response.usage.inputTokens ?? 0;
        this.ownUsage.outputTokens += response.usage.outputTokens ?? 0;
        this.ownUsage.cachedInputTokens += response.usage.cachedInputTokens ?? 0;
        this.events.emit({ type: "usage", message: formatTotals(this.ownUsage), ...this.ownUsage });
      }
      state.throwIfAborted();
      for (const warning of response.warnings) this.events.emit({ type: "warn", message: warning });

      const guardCtx = {
        text: response.text,
        toolCallCount: response.toolCalls.length,
        task,
        actionCount: executor.summaries.length
      };

      if (response.text || response.toolCalls.length > 0) state.resetReprompt(this.emptyGuard.id);

      if (response.toolCalls.length === 0) {
        const blocked = this.applyZeroToolGuards(guards, guardCtx, state, executorTrace);
        if (blocked.action === "reprompt") {
          if (response.text) messages.push({ role: "assistant", content: response.text });
          messages.push({ role: "user", content: blocked.feedback });
          continue;
        }
        if (blocked.action === "terminate") {
          finalText = blocked.message;
          break;
        }

        // Verifier quality gate (§7.3) — audits even zero-tool answers.
        if (this.verifier) {
          if (verifierAttempts < this.config.verifierMaxRetries) {
            const verdict = await this.verifier.verify(
              this.buildBundle(task, response.text, executorTrace, executor.summaries)
            );
            verifierAttempts++;
            lastVerifierVerdict = verdict;
            if (verdict.verdict !== "pass") {
              const feedback = buildVerifierFeedback(verdict);
              this.events.emit({ type: "verifier", message: `[Verifier] ${verdict.verdict} (confidence: ${verdict.confidence}): ${verdict.reason}` });
              recordVerifierTasks(this.context, verdict);
              if (response.text) messages.push({ role: "assistant", content: response.text });
              messages.push({ role: "user", content: feedback });
              continue;
            }
            this.events.emit({ type: "verifier", message: `[Verifier] pass (confidence: ${verdict.confidence})` });
          } else if (lastVerifierVerdict && lastVerifierVerdict.verdict !== "pass") {
            finalText = buildVerifierExhaustedReport(response.text, lastVerifierVerdict);
            break;
          }
        }

        // TodoGate (grok-build): don't let the turn end while the plan still has
        // open steps. Nudge the model to finish them; fall through after a couple
        // of tries so it can't be trapped forever.
        const plan = this.context.list().find((i) => i.type === "plan" && i.pinned);
        const openSteps = plan ? (plan.content.match(/\[ \]|\[~\]/g) || []).length : 0;
        if (openSteps > 0 && todoGateNudges < 2) {
          todoGateNudges++;
          if (response.text) messages.push({ role: "assistant", content: response.text });
          messages.push({
            role: "user",
            content:
              `Your plan still has ${openSteps} step(s) pending or in_progress, but you are ending the turn. ` +
              "Advance the remaining steps now — do the work, then mark them completed with update_plan. " +
              "If a step is genuinely already done, update the plan to reflect that. If the task truly cannot proceed, state why."
          });
          continue;
        }

        finalText = response.text;
        break;
      }

      if (response.text) {
        executorTrace.push(response.text);
        this.events.emit({ type: "model_text", message: response.text });
      }

      // Read-only tools are side-effect-free and safe to run together, so let the
      // model batch them in one turn (executed in parallel) to cut round-trips.
      // A mutating/shell tool — or a mix — must stay one per turn (order + side
      // effects matter), so reject those batches and guide toward read-only-only.
      const calls = response.toolCalls;
      const allReadOnly = calls.every((c) => TOOL_EFFECTS[c.name]?.readOnly === true);
      if (calls.length > 1 && !allReadOnly) {
        if (response.text) messages.push({ role: "assistant", content: response.text });
        messages.push({ role: "user", content: this.multiToolGuard.feedback(guardCtx) });
        continue;
      }

      this.events.emit({ type: "tool_batch", step: state.step, message: formatToolBatch(state.step, calls.map((c) => c.name)) });
      if (response.text) messages.push({ role: "assistant", content: response.text });
      for (const c of calls) messages.push({ role: "tool_call", toolCallId: c.id, name: c.name, argsJson: c.argsJson });
      const outs = calls.length === 1
        ? [await executor.executeOne(calls[0], state.step, signal)]
        : await Promise.all(calls.map((c) => executor.executeOne(c, state.step, signal)));
      for (let k = 0; k < calls.length; k++) messages.push({ role: "tool", toolCallId: calls[k].id, content: outs[k].output });

      // A tool (view_image / screenshot) may have produced images for the model
      // to SEE — attach each as an image-bearing user message for the next turn.
      const pendingImages = this.toolCtx.images;
      if (pendingImages && pendingImages.length > 0) {
        for (const img of pendingImages.splice(0)) {
          messages.push({ role: "user", content: `[Image${img.note ? `: ${img.note}` : ""}]`, images: [img.dataUri] });
        }
      }

      for (const call of calls) {
        // Surface files the agent looks at, so the UI can show their contents.
        if (call.name === "read_file_range" || call.name === "get_file_overview") {
          try {
            const p = JSON.parse(call.argsJson)?.path;
            if (typeof p === "string" && p) this.events.emit({ type: "file_viewed", message: `viewed ${p}`, path: p });
          } catch {
            /* ignore */
          }
        }
        // Surface the maintained plan to the UI (progress panel) when it changes.
        if (call.name === "update_plan") {
          try {
            const parsed = JSON.parse(call.argsJson);
            if (Array.isArray(parsed?.plan)) {
              const done = parsed.plan.filter((p: { status: string }) => p.status === "completed").length;
              this.events.emit({ type: "plan", message: `Plan ${done}/${parsed.plan.length} done`, steps: parsed.plan });
            }
          } catch {
            /* ignore malformed plan args */
          }
        }
      }

      // Analysis-paralysis nudge: after a run of inspection with no mutation.
      noProgressStreak = executor.lastProgress ? 0 : noProgressStreak + 1;
      if (noProgressStreak >= TUNING.guard.actionNudgeAfterNoProgress) {
        messages.push({
          role: "user",
          content:
            `You have run ${noProgressStreak} inspection steps without changing anything. ` +
            "Stop gathering context now. If the task requires an edit, read the exact target lines if you have not, then make the change with apply_patch this turn. " +
            "If the task is already answerable, give the final answer. Do not repeat reads or searches whose results are already above."
        });
        noProgressStreak = 0;
      }

      // Doom-loop guard: warn once, then terminate the turn if the model keeps
      // repeating the same operation/cycle (ported from grok-build's detector).
      const loopSig = calls.map((c) => `${c.name}:${(c.argsJson || "").replace(/\s+/g, "").slice(0, 200)}`).join("|");
      const verdict = this.doomLoop.record(loopSig);
      if (verdict.action === "warn") {
        messages.push({ role: "user", content: DoomLoopDetector.corrective(verdict.count) });
        this.events.emit({ type: "warn", message: `Doom-loop warning: same operation repeated ${verdict.count}×` });
      } else if (verdict.action === "terminate") {
        this.events.emit({ type: "warn", message: `Doom-loop: turn terminated after ${verdict.count} repeats of the same operation` });
        finalText = finalText || "Stopped: I was repeating the same operation without making progress. Please re-scope the task or give more guidance.";
        break;
      }
    }

    const gate = await finalAnswerGate({
      oneShot,
      background: this.toolCtx.background,
      tools: this.tools,
      toolCtx: this.toolCtx,
      hasModifiedFiles: executor.hasModifiedFiles
    });
    // One-shot (CLI) keeps the full machine-readable tail: action log, inline
    // diff preview, final checks. Interactive mode omits all of it — the REPL
    // shows a compact changed-files summary and the clickable /diff browser
    // instead, so the conversation stays clean.
    const actionSection =
      oneShot && executor.summaries.length > 0 ? `\n\n[Actions completed]\n${formatActionSummary(executor.summaries)}` : "";
    const diffSection = oneShot && gate.diffPreview ? `\n\n[Diff preview]\n${gate.diffPreview}` : "";
    const checks = oneShot ? `\n\n[Final checks]\nBackground: ${gate.backgroundStatus}\nDiff checked: ${gate.diffChecked ? "yes" : "not needed"}` : "";
    const suffix = `${actionSection}${diffSection}${checks}`;
    return finalText ? `${finalText}${suffix}` : `Stopped after max steps without a final model message.${suffix}`;
  }

  private applyZeroToolGuards(
    guards: ResponseGuard[],
    guardCtx: { text: string; toolCallCount: number; task: string; actionCount: number },
    state: LoopState,
    executorTrace: string[]
  ): { action: "reprompt"; feedback: string } | { action: "terminate"; message: string } | { action: "proceed" } {
    for (const guard of guards) {
      if (!guard.blocks(guardCtx)) continue;
      if (state.repromptCount(guard.id) < guard.maxReprompts) {
        state.recordReprompt(guard.id);
        if (guard.id === this.planOnlyGuard.id) {
          executorTrace.push(guardCtx.text);
          this.events.emit({ type: "model_text", message: guardCtx.text });
          this.events.emit({ type: "info", message: "Grok provided a plan without tool calls; asking it to continue with the required tools." });
        } else {
          this.events.emit({ type: "warn", message: "Empty response from model. Requesting continuation." });
        }
        return { action: "reprompt", feedback: guard.feedback(guardCtx) };
      }
      if (guard.onExhausted === "terminate") return { action: "terminate", message: guard.terminalMessage() };
    }
    return { action: "proceed" };
  }

  /**
   * §6.3 LLM rolling summary — opt-in (config.enableLlmSummary). Distills the
   * action trace into a structured summary, merged deterministically into a
   * single pinned history item when the context budget is pressured.
   */
  private async maybeSummarize(summaries: ToolExecutor["summaries"]): Promise<void> {
    if (!this.summarizer) return;
    const totalTokens = (this.context as { totalTokens?: () => number }).totalTokens;
    if (typeof totalTokens !== "function") return;
    if (totalTokens.call(this.context) <= TUNING.budget.warningLimit) return;
    const episode = await this.summarizer.summarize(
      summaries.map((s) => `${s.name} ${s.ok ? "ok" : "failed"}: ${s.summary}`)
    );
    this.history = mergeSummaries(this.history, episode);
    this.context.upsert("history-summary", {
      type: "task_summary",
      content: renderSummary(this.history),
      priority: 96,
      pinned: true
    });
  }

  /** Pinned workspace context (repo summary, environment) for the stable system preamble. */
  private workspaceContext(): string[] {
    return this.context
      .list()
      .filter((item) => item.pinned && PREAMBLE_CONTEXT_TYPES.has(item.type))
      .map((item) => `<${item.type}>\n${item.content}`);
  }

  /**
   * Keep the transcript bounded. When over budget, elide the content of the
   * OLDEST tool-result turns (keeping system, task, and the most recent turns),
   * so the model retains recent observations while old bulk is dropped.
   */
  /**
   * Conversation repair (grok-build): keep the tool_call ↔ tool_result pairing
   * valid before each send. Drop orphan/duplicate tool results, and give any
   * dangling tool_call (e.g. after an interrupt) a synthetic result — a
   * function_call with no output is an API error.
   */
  private repairTranscript(messages: ModelMessage[]): void {
    const callIds = new Set<string>();
    for (const m of messages) if (m.role === "tool_call") callIds.add(m.toolCallId);
    const haveResult = new Set<string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "tool") continue;
      if (!callIds.has(m.toolCallId) || haveResult.has(m.toolCallId)) messages.splice(i, 1); // orphan or duplicate
      else haveResult.add(m.toolCallId);
    }
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role !== "tool_call" || haveResult.has(m.toolCallId)) continue;
      messages.splice(i + 1, 0, { role: "tool", toolCallId: m.toolCallId, content: JSON.stringify({ ok: false, error: { code: "no_result", message: "(no result recorded — the call was interrupted)" } }) });
      haveResult.add(m.toolCallId);
    }
  }

  private compactTranscript(messages: ModelMessage[]): void {
    const budget = TUNING.budget.maxInputTokens - TUNING.budget.reservedForOutput;
    const keepRecent = 10;
    const sizeOf = (m: ModelMessage): number =>
      Math.ceil(("content" in m ? m.content : `${m.name} ${m.argsJson}`).length / TUNING.token.charsPerToken);
    const callFor = (toolCallId: string): Extract<ModelMessage, { role: "tool_call" }> | undefined =>
      messages.find((x): x is Extract<ModelMessage, { role: "tool_call" }> => x.role === "tool_call" && x.toolCallId === toolCallId);

    // Proactively elide LARGE older tool results — do NOT wait for budget pressure.
    // A big read/search result re-sent verbatim every step is the main driver of a
    // growing (slow, costly) transcript. Replace it with a pointer that names how
    // to get the data back, and free the duplicate-read guard for elided reads so
    // the model can actually re-fetch it if it still needs it (never lost).
    //
    // ONLY elide re-fetchable READ/SEARCH results. Never elide collaboration /
    // state results (spawn_agent, open_pr, review_pr, merge_pr, comment, …): those
    // ARE the agent's working memory of what it has done — eliding them makes the
    // orchestrator lose the thread and flail (re-planning instead of merging).
    const LARGE = 1500; // chars (~375 tokens): only big, re-sendable blobs
    const isElidable = (tc: Extract<ModelMessage, { role: "tool_call" }> | undefined): boolean =>
      tc !== undefined && ELIDABLE_RESULTS.has(tc.name);
    for (let i = 2; i < messages.length - keepRecent; i++) {
      const m = messages[i];
      if (m.role !== "tool" || m.content.length <= LARGE) continue;
      const tc = callFor(m.toolCallId);
      if (!isElidable(tc)) continue;
      m.content = this.elisionPointer(tc, m.content.length);
      if (tc?.name === "read_file_range") {
        try {
          const a = JSON.parse(tc.argsJson) as { path?: string; startLine?: number; endLine?: number };
          if (a.path && a.startLine && a.endLine) this.toolCtx.engine?.staleRead(a.path, a.startLine, a.endLine);
        } catch {
          /* keep the pointer even if args don't parse */
        }
      }
    }

    // Safety net: if even after that the transcript is over budget, keep eliding
    // more elidable results (oldest first), still leaving the recent window and
    // all state/collaboration results intact.
    let total = messages.reduce((sum, m) => sum + sizeOf(m), 0);
    for (let i = 2; i < messages.length - keepRecent && total > budget; i++) {
      const m = messages[i];
      if (m.role !== "tool" || m.content.length <= 120 || m.content.startsWith("[elided")) continue;
      const tc = callFor(m.toolCallId);
      if (!isElidable(tc)) continue;
      const before = sizeOf(m);
      m.content = this.elisionPointer(tc, m.content.length);
      total -= before - sizeOf(m);
    }
  }

  /** A short stand-in that tells the model the data is gone but how to get it back. */
  private elisionPointer(tc: Extract<ModelMessage, { role: "tool_call" }> | undefined, chars: number): string {
    if (tc?.name === "read_file_range") {
      const p = (() => { try { return JSON.parse(tc.argsJson)?.path as string; } catch { return undefined; } })();
      return `[elided to save context — earlier read of ${p ?? "a file"}; call read_file_range again if you still need those lines]`;
    }
    if (tc) return `[elided to save context — earlier ${tc.name} result (${chars} chars); re-run ${tc.name} if you still need it]`;
    return `[elided to save context — ${chars} chars]`;
  }

  /**
   * Codex-style auto-compaction. When the transcript is still over the compact
   * threshold after mechanical eliding, ask the model for a handoff summary of
   * the OLD turns, replace them with that summary, re-hydrate the few key files
   * the agent was working with, and carry the current plan forward (so plan
   * state survives compaction — the grok-build "reseed" principle). The recent
   * window is kept verbatim. Best-effort: any failure leaves the transcript
   * untouched rather than crashing the run.
   */
  private async maybeCompactTranscript(messages: ModelMessage[], task: string): Promise<void> {
    const budget = TUNING.budget.maxInputTokens - TUNING.budget.reservedForOutput;
    const threshold = Math.floor(budget * TUNING.compact.atFraction);
    const cpt = TUNING.token.charsPerToken;
    const textOf = (m: ModelMessage): string => ("content" in m ? m.content : `${m.name} ${m.argsJson}`);
    const total = messages.reduce((s, m) => s + Math.ceil(textOf(m).length / cpt), 0);
    if (total <= threshold) return;

    // Walk back from the end to find where the verbatim "recent window" starts.
    let acc = 0;
    let recentStart = messages.length;
    for (let i = messages.length - 1; i >= 2; i--) {
      acc += textOf(messages[i]).length;
      recentStart = i;
      if (acc >= TUNING.compact.keepRecentChars) break;
    }
    if (recentStart <= 2) return; // nothing old enough to compact

    const oldMessages = messages.slice(2, recentStart);
    const serialize = (m: ModelMessage): string =>
      m.role === "tool_call" ? `[tool_call ${m.name}] ${m.argsJson}` : m.role === "tool" ? `[tool_result] ${m.content}` : `[${m.role}] ${m.content}`;
    const oldText = oldMessages.map(serialize).join("\n");

    let summary: string;
    try {
      const resp = await this.provider.complete({
        messages: [
          { role: "system", content: HANDOFF_SYSTEM },
          {
            role: "user",
            content:
              `<Task>\n${task}\n</Task>\n\n<Conversation so far>\n${oldText}\n</Conversation so far>\n\n` +
              "Write a handoff summary so another agent can resume WITHOUT re-reading the above. Concisely include: " +
              "1) progress and key decisions; 2) important context, constraints, user preferences; 3) what remains (clear next steps); " +
              "4) critical specifics to continue — file paths, identifiers, commands, data, open issues/PRs. Return only the summary."
          }
        ],
        tools: [],
        toolChoice: "none",
        parallelToolCalls: false
      });
      this.usage?.record(resp.usage);
      summary = (resp.text ?? "").trim();
      if (!summary) return;
    } catch {
      return; // keep the full transcript if summarization fails
    }

    // ② Re-hydrate the key files (read directly, bypassing the duplicate-read
    // guard, so the model keeps concrete context — not just prose).
    const fileMsgs: ModelMessage[] = [];
    for (const p of this.toolCtx.engine?.recentReadPaths(TUNING.compact.rehydrateFiles) ?? []) {
      try {
        const content = await readTextFile(this.toolCtx.sandbox, p);
        const head = content.split(/\r?\n/).slice(0, TUNING.compact.rehydrateLines).join("\n");
        fileMsgs.push({ role: "user", content: `<Re-hydrated key file ${p} (first ${TUNING.compact.rehydrateLines} lines)>\n${head}\n</Re-hydrated key file>` });
      } catch {
        /* file may have been moved/deleted — skip it */
      }
    }

    // Carry the current plan across the compaction (it survives as durable state).
    const plan = this.context.list().find((i) => i.type === "plan" && i.pinned);
    const planMsg: ModelMessage | null = plan
      ? { role: "user", content: `<Current plan (carried across compaction)>\n${plan.content}\n</Current plan>` }
      : null;

    const handoff: ModelMessage = {
      role: "user",
      content:
        `<Context compacted to save tokens — handoff summary of the earlier conversation>\n${summary}\n</Context compacted>\n` +
        "The raw earlier turns were removed. Trust this summary; re-read a file or re-run a tool if you need a detail it omits."
    };

    messages.splice(2, recentStart - 2, handoff, ...fileMsgs, ...(planMsg ? [planMsg] : []));
    this.events.emit({
      type: "info",
      message: chalk.dim(`↯ compacted context: summarized ${oldMessages.length} earlier turns, re-hydrated ${fileMsgs.length} file(s)`)
    });
  }

  private buildBundle(task: string, claim: string, trace: string[], summaries: ToolExecutor["summaries"]): EvidenceBundle {
    return {
      userTask: task,
      executorClaim: claim,
      executorTrace: claim ? [...trace, claim] : trace,
      evidenceItems: summaries.map((s) => ({ toolName: s.name, ok: s.ok, args: s.args, summary: s.summary })),
      memoryFacts: buildVerifierMemoryFacts(this.context.relevant(task, TUNING.context.verifierMemoryTokens))
    };
  }
}

function formatToolBatch(step: number, toolNames: string[]): string {
  return `Grok requested tool batch ${step}: ${[...new Set(toolNames)].join(", ")}`;
}

function formatActionSummary(actions: ToolExecutor["summaries"]): string {
  return actions
    .map((action) => `- step ${action.step}: ${action.name} ${action.ok ? "ok" : "failed"} - ${action.summary}`)
    .join("\n");
}

function buildVerifierMemoryFacts(items: ContextItem[]): EvidenceMemoryFact[] {
  return items
    .filter((item) =>
      [
        "file_range",
        "file_overview",
        "search_result",
        "shell_output",
        "background_output_summary",
        "patch",
        "test_result",
        "environment_summary",
        "project_tooling_summary",
        "task_summary"
      ].includes(item.type)
    )
    .slice(-TUNING.context.verifierMemoryFactLimit)
    .map((item) => ({
      type: item.type,
      content: oneLine(item.content, 500),
      factSource: item.factSource,
      factConfidence: item.factConfidence ?? "uncertain",
      source: item.source
    }));
}

const PREAMBLE_CONTEXT_TYPES = new Set<ContextItem["type"]>([
  "repo_summary",
  "environment_policy",
  "environment_summary",
  "project_tooling_summary"
]);

function recordVerifierTasks(context: ContextManager, verdict: VerifierVerdict): void {
  const tasks = [
    ...verdict.requiredNextActions,
    ...verdict.unsupportedAssumptions.map((item) => item.requiredVerification)
  ].filter((item): item is string => Boolean(item.trim()));
  for (const task of [...new Set(tasks)]) {
    context.add({
      type: "verification_task",
      content: task,
      priority: 90,
      expiresAfterSteps: TUNING.expiry.verificationTask,
      factSource: "model_inference",
      factConfidence: "uncertain"
    });
  }
}

function oneLine(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max)}...` : compact;
}

function buildVerifierExhaustedReport(executorClaim: string, lastVerdict: VerifierVerdict): string {
  const lines = [
    "[Verifier] Retry budget exhausted. The executor's final claim could not be independently verified.",
    `Last verifier verdict: ${lastVerdict.verdict} (confidence: ${lastVerdict.confidence})`,
    `Reason: ${lastVerdict.reason}`
  ];
  if (lastVerdict.unsupportedClaims.length > 0) {
    lines.push("Unresolved unsupported claims:");
    for (const c of lastVerdict.unsupportedClaims) lines.push(`  - ${c}`);
  }
  if (lastVerdict.missingEvidence.length > 0) {
    lines.push("Missing evidence:");
    for (const e of lastVerdict.missingEvidence) lines.push(`  - ${e}`);
  }
  lines.push("", "Executor's unverified final answer (treat as partial progress):", executorClaim);
  return lines.join("\n");
}

function serverTools(config: GrokCodeConfig): ResponseTool[] {
  if (!config.serverTools) return [];
  const tools: ResponseTool[] = [];
  if (config.enableWebSearch) tools.push({ type: "web_search" });
  if (config.enableXSearch) tools.push({ type: "x_search" });
  return tools;
}
