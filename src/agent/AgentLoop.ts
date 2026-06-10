import ora from "ora";
import type { LLMProvider } from "../api/LLMProvider.js";
import type { ResponseTool } from "../api/responsesClient.js";
import type { GrokCodeConfig } from "../config/loadConfig.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolExecutionContext } from "../tools/AgentTool.js";
import type { SkillLoader } from "../skills/SkillLoader.js";
import type { ToolSkillRegistry } from "../tool-skills/ToolSkillRegistry.js";
import type { ContextItem } from "../context/ContextItem.js";
import { TUNING } from "../config/tuning.js";
import { buildStatelessInput } from "./modelInputBuilder.js";
import { finalAnswerGate } from "./finalAnswerGate.js";
import { VerifierAgent, buildVerifierFeedback } from "./VerifierAgent.js";
import type { EvidenceBundle, EvidenceMemoryFact, VerifierVerdict } from "./EvidenceBundle.js";
import { LoopState } from "./LoopState.js";
import { ToolExecutor } from "./ToolExecutor.js";
import { EmptyResponseGuard, PlanOnlyGuard, MultiToolGuard, type ResponseGuard } from "./ResponseGuards.js";
import { RollingSummarizer, mergeSummaries, renderSummary, EMPTY_SUMMARY, type EpisodeSummary } from "../context/RollingSummarizer.js";
export { shouldContinueAfterPlanOnlyResponse } from "./ResponseGuards.js";
import { ConsoleEventSink, type AgentEventSink } from "./AgentEvents.js";

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
    private readonly events: AgentEventSink = new ConsoleEventSink()
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
    let runtimeFeedback: string | undefined;
    let verifierAttempts = 0;
    let lastVerifierFeedback: string | undefined;
    let lastVerifierVerdict: VerifierVerdict | undefined;
    let finalText = "";

    while (state.advance()) {
      this.context.nextStep(task);
      await this.maybeSummarize(executor.summaries);

      const input = buildStatelessInput({
        task,
        verifiedFacts: executor.summaries.map((s) => `${s.name} ${s.ok ? "succeeded" : "failed"}: ${s.summary}`),
        priorActions: executor.summaries.map((s) => `step ${s.step}: ${s.name}(${s.args ?? ""}) -> ${s.ok ? "ok" : "failed"}`),
        inferredFacts: buildStatelessInferences(this.context.relevant(task, TUNING.context.statelessInferenceTokens)),
        lastFailure: executor.failureTracker.lastFailure(),
        verifierFeedback: lastVerifierFeedback,
        runtimeFeedback,
        toolIndex: this.toolSkills.toolIndex(),
        generalSkills: this.skillLoader.select(task),
        toolSkills: this.toolSkills.select(task, [...executor.usedToolNames]),
        projectInstructions: this.projectInstructions
      });

      const spinner = ora(`Grok thinking (step ${state.step})`).start();
      let response;
      try {
        response = await this.provider.complete({
          messages: [{ role: "user", content: input }],
          tools: this.tools.schemas(serverTools(this.config)),
          toolChoice: this.config.toolChoice,
          parallelToolCalls: true,
          signal
        });
      } finally {
        spinner.stop();
      }
      state.throwIfAborted();
      for (const warning of response.warnings) this.events.emit({ type: "warn", message: warning });

      const guardCtx = {
        text: response.text,
        toolCallCount: response.toolCalls.length,
        task,
        actionCount: executor.summaries.length
      };

      // Non-empty response resets the empty-response reprompt budget.
      if (response.text || response.toolCalls.length > 0) state.resetReprompt(this.emptyGuard.id);

      if (response.toolCalls.length === 0) {
        const blocked = this.applyZeroToolGuards(guards, guardCtx, state, executorTrace);
        if (blocked.action === "reprompt") {
          runtimeFeedback = blocked.feedback;
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
              lastVerifierFeedback = feedback;
              runtimeFeedback = undefined;
              this.context.upsert("verifier-feedback", {
                type: "verifier_feedback",
                content: feedback,
                priority: 95,
                pinned: false,
                expiresAfterSteps: TUNING.expiry.verifierFeedback
              });
              recordVerifierTasks(this.context, verdict);
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
        runtimeFeedback = this.multiToolGuard.feedback(guardCtx);
        continue;
      }

      this.events.emit({ type: "tool_batch", step: state.step, message: formatToolBatch(state.step, response.toolCalls.map((c) => c.name)) });
      await executor.executeOne(response.toolCalls[0], state.step, signal);
      runtimeFeedback = undefined;
    }

    const gate = await finalAnswerGate({
      oneShot,
      background: this.toolCtx.background,
      tools: this.tools,
      toolCtx: this.toolCtx,
      hasModifiedFiles: executor.hasModifiedFiles
    });
    const diffSection = gate.diffPreview ? `\n\n[Diff preview]\n${gate.diffPreview}` : "";
    const actionSection =
      executor.summaries.length > 0 ? `\n\n[Actions completed]\n${formatActionSummary(executor.summaries)}` : "";
    const suffix = `${actionSection}${diffSection}\n\n[Final checks]\nBackground: ${gate.backgroundStatus}\nDiff checked: ${gate.diffChecked ? "yes" : "not needed"}`;
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

function buildStatelessInferences(items: ContextItem[]): string[] {
  return items
    .filter((item) => item.factConfidence === "inferred" || item.factSource === "model_inference")
    .slice(-TUNING.context.statelessInferenceLimit)
    .map((item) => `${item.type}: ${oneLine(item.content, 300)}`);
}

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
