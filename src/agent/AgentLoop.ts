import ora from "ora";
import chalk from "chalk";
import type { LLMProvider, ModelMessage } from "../api/LLMProvider.js";
import type { ResponseTool } from "../api/responsesClient.js";
import type { GrokCodeConfig } from "../config/loadConfig.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolExecutionContext } from "../tools/AgentTool.js";
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
import type { SessionUsage } from "./SessionUsage.js";
import type { Interjections } from "./Interjections.js";

/**
 * AgentLoop (§7) — pure-stateless orchestrator. No conversation-chain modes;
 * every step rebuilds the full input from the ContextManager and tool-action
 * trace, and the provider abstraction sends it statelessly.
 */
export class AgentLoop {
  private readonly verifier?: VerifierAgent;
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

    // Codex-style transcript: stable system preamble + task, then accumulating
    // assistant / tool_call / tool-result turns. Sent in full each step (no
    // server-side chaining); the model sees everything it has done, so it never
    // has to re-read what it already observed.
    const system = buildSystemPreamble({
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
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
      this.compactTranscript(messages);

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
          // Single-tool discipline (MultiToolGuard) — tell the API not to batch.
          parallelToolCalls: false,
          signal
        });
      } finally {
        if (spinner) spinner.stop();
      }
      this.usage?.record(response.usage);
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

        finalText = response.text;
        break;
      }

      if (response.text) {
        executorTrace.push(response.text);
        this.events.emit({ type: "model_text", message: response.text });
      }

      if (response.toolCalls.length > 1) {
        if (response.text) messages.push({ role: "assistant", content: response.text });
        messages.push({ role: "user", content: this.multiToolGuard.feedback(guardCtx) });
        continue;
      }

      const call = response.toolCalls[0];
      this.events.emit({ type: "tool_batch", step: state.step, message: formatToolBatch(state.step, [call.name]) });
      if (response.text) messages.push({ role: "assistant", content: response.text });
      messages.push({ role: "tool_call", toolCallId: call.id, name: call.name, argsJson: call.argsJson });
      const out = await executor.executeOne(call, state.step, signal);
      messages.push({ role: "tool", toolCallId: call.id, content: out.output });

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
  private compactTranscript(messages: ModelMessage[]): void {
    const budget = TUNING.budget.maxInputTokens - TUNING.budget.reservedForOutput;
    const keepRecent = 10;
    const sizeOf = (m: ModelMessage): number =>
      Math.ceil(("content" in m ? m.content : `${m.name} ${m.argsJson}`).length / TUNING.token.charsPerToken);
    let total = messages.reduce((sum, m) => sum + sizeOf(m), 0);
    if (total <= budget) return;
    for (let i = 2; i < messages.length - keepRecent && total > budget; i++) {
      const m = messages[i];
      if (m.role === "tool" && m.content.length > 120) {
        const before = sizeOf(m);
        m.content = `[older tool result elided to save context — ${m.content.length} chars]`;
        total -= before - sizeOf(m);
      }
    }
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
