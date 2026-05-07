import ora from "ora";
import type OpenAI from "openai";
import { createResponse, type ResponseTool } from "../api/responsesClient.js";
import { parseResponse } from "../api/responseParser.js";
import type { GrokCodeConfig } from "../config/loadConfig.js";
import type { ContextManager } from "../context/ContextManager.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolExecutionContext } from "../tools/AgentTool.js";
import type { SkillLoader } from "../skills/SkillLoader.js";
import type { ToolSkillRegistry } from "../tool-skills/ToolSkillRegistry.js";
import { buildModelInput } from "./modelInputBuilder.js";
import { finalAnswerGate } from "./finalAnswerGate.js";
import { SituationMemory } from "./SituationMemory.js";
import { runVerifier, auditIntermediateClaims, type VerifierResult } from "./Verifier.js";

type FunctionCallOutput = { type: "function_call_output"; call_id: string; output: string };

type ToolActionSummary = {
  step: number;
  name: string;
  ok: boolean;
  summary: string;
};

export class AgentLoop {
  constructor(
    private readonly client: OpenAI,
    private readonly config: GrokCodeConfig,
    private readonly context: ContextManager,
    private readonly tools: ToolRegistry,
    private readonly toolCtx: ToolExecutionContext,
    private readonly skillLoader: SkillLoader,
    private readonly toolSkills: ToolSkillRegistry,
    private readonly projectInstructions: string
  ) {}

  async run(task: string, oneShot: boolean, signal?: AbortSignal): Promise<string> {
    const isStateless = this.config.conversationMode === "stateless";
    const isHybrid = this.config.conversationMode === "hybrid";

    let previousResponseId: string | undefined;
    // hybridIsStateless becomes true after a hybrid reset and stays true for the remainder
    let hybridIsStateless = false;
    let finalText = "";
    const usedToolNames = new Set<string>();
    const toolActionSummaries: ToolActionSummary[] = [];
    let planOnlyReprompts = 0;
    let emptyResponseRetries = 0;
    let verifierReprompts = 0;
    let verifierCrashCount = 0;
    const hasModifiedFiles = { value: false };
    const situationMemory = new SituationMemory();

    this.context.upsert("user-task", { type: "user_task", content: task, priority: 100, pinned: true });

    let step = 1;
    let pendingInput: any = this.buildInput(task, isStateless ? situationMemory : undefined);

    while (step <= this.config.maxSteps) {
      throwIfAborted(signal);
      this.context.nextStep(task);

      // hybrid: reset stateful chain after thresholds — once reset, stays stateless
      if (isHybrid && !hybridIsStateless && previousResponseId) {
        const shouldReset =
          step > this.config.hybridResetAfterSteps ||
          situationMemory.totalFailures() >= this.config.hybridResetAfterFailures;
        if (shouldReset) {
          previousResponseId = undefined;
          hybridIsStateless = true;
          pendingInput = this.buildStatelessPrompt(task, situationMemory);
          console.log(`[hybrid] Context reset at step ${step} — switching to stateless mode.`);
        }
      }

      const useStateless = isStateless || hybridIsStateless;

      const spinner = ora(`Grok thinking (step ${step})`).start();
      let response: any;
      try {
        response = await createResponse(this.client, {
          model: this.config.model,
          input: pendingInput,
          tools: this.tools.schemas(serverTools(this.config)),
          toolChoice: this.config.toolChoice,
          previousResponseId: useStateless ? undefined : previousResponseId,
          signal
        });
      } finally {
        spinner.stop();
      }

      throwIfAborted(signal);
      const parsed = parseResponse(response);
      previousResponseId = parsed.id || previousResponseId;

      // watchdog: empty response
      if (!parsed.finalText && parsed.functionCalls.length === 0) {
        if (emptyResponseRetries < 1) {
          emptyResponseRetries += 1;
          console.log("[watchdog] Empty response detected. Nudging model to continue.");
          pendingInput = this.buildCorrectionInput(
            task,
            "Your previous response was empty. Emit exactly one tool call or a final answer.",
            useStateless ? situationMemory : undefined
          );
          step += 1;
          continue;
        }
        finalText = "[agent stopped: repeated empty responses from model]";
        break;
      }
      emptyResponseRetries = 0;

      // narration guard: intent without tool call
      if (parsed.functionCalls.length === 0) {
        // block finalization if unresolved pending verifications exist (always, no reprompt-count bypass)
        const unresolved = situationMemory.getUnresolvedVerifications();
        if (this.config.enableVerifier && unresolved.length > 0) {
          if (verifierReprompts < this.config.maxVerifierReprompts) {
            verifierReprompts += 1;
            console.log(`[verifier] Blocking finalization: ${unresolved.length} unresolved pending verification(s).`);
            pendingInput = this.buildCorrectionInput(
              task,
              buildPendingVerificationBlock(unresolved),
              useStateless ? situationMemory : undefined
            );
            step += 1;
            continue;
          }
          // budget exhausted — fail closed, never accept with unresolved items
          finalText = `[agent stopped: ${unresolved.length} verification requirement(s) unresolved after max reprompts. Claims: ${unresolved.map((p) => p.claim).join("; ")}]`;
          break;
        }

        if (shouldContinueAfterPlanOnlyResponse(parsed.finalText, task, toolActionSummaries.length)) {
          if (planOnlyReprompts < 2) {
            planOnlyReprompts += 1;
            console.log(parsed.finalText);
            console.log("Grok described intent without acting. Requesting tool call.");
            pendingInput = this.buildCorrectionInput(
              task,
              "Invalid response: you described an intention but did not call a tool. Return exactly one tool call or a final answer. Describing intent is not evidence.",
              useStateless ? situationMemory : undefined
            );
            step += 1;
            continue;
          }
          // budget exhausted — fail closed, never accept narrated intent as a final answer
          finalText = "[agent stopped: model repeatedly provided intent without tool action]";
          break;
        }

        // candidate final answer — run verifier if enabled
        if (this.config.enableVerifier && parsed.finalText) {
          const outcome = await this.runVerifierLoop(
            task, situationMemory, parsed.finalText, verifierReprompts, verifierCrashCount, step, signal
          );
          if (!outcome.pass) {
            if ("stop" in outcome && outcome.stop) {
              finalText = outcome.stopMessage;
              break;
            }
            verifierReprompts += 1;
            if ("crashed" in outcome && outcome.crashed) verifierCrashCount += 1;
            pendingInput = this.buildCorrectionInput(
              task,
              "correction" in outcome ? outcome.correction : "[verifier error]",
              useStateless ? situationMemory : undefined
            );
            step += 1;
            continue;
          }
        }

        finalText = parsed.finalText;
        break;
      }

      planOnlyReprompts = 0;

      // output-protocol guard: exactly one tool call per non-final turn
      if (parsed.functionCalls.length > 1) {
        console.log(`[guard] Rejected ${parsed.functionCalls.length} tool calls in one turn — protocol requires exactly one.`);
        pendingInput = this.buildCorrectionInput(
          task,
          `Invalid: you returned ${parsed.functionCalls.length} tool calls in one turn. Exactly one tool call per turn is required. Return exactly one tool call.`,
          useStateless ? situationMemory : undefined
        );
        step += 1;
        continue;
      }

      // intermediate claim audit: scan planning text alongside tool calls
      if (parsed.finalText) {
        console.log(parsed.finalText);
        if (this.config.enableVerifier) {
          await this.auditIntermediateText(situationMemory, parsed.finalText, step, signal);
        }
      }
      console.log(formatToolBatch(step, parsed.functionCalls.map((c) => c.name)));

      // blind-retry guard
      const blocked = this.findBlockedCall(parsed.functionCalls, situationMemory);
      if (blocked) {
        let args: unknown;
        try { args = JSON.parse(blocked.arguments || "{}"); } catch { args = {}; }
        const record = situationMemory.hasRecentlyFailed(blocked.name, args)!;
        console.log(`[guard] Blocking blind retry of ${blocked.name} (failed ${record.attempts}x).`);
        pendingInput = this.buildCorrectionInput(
          task,
          `BLIND RETRY BLOCKED:\nTool: ${record.tool}\nError: ${record.error}\nAttempts: ${record.attempts}\nConstraint: Do not retry unchanged. Choose a different approach.`,
          useStateless ? situationMemory : undefined
        );
        step += 1;
        continue;
      }

      const outputs = await this.executeToolBatch(
        parsed.functionCalls, step, usedToolNames, toolActionSummaries, hasModifiedFiles, situationMemory, signal
      );

      if (useStateless) {
        // stateless or hybrid-after-reset: rebuild from situation memory
        // do NOT pass stale function_call_output protocol items without previous_response_id
        pendingInput = this.buildStatelessPrompt(task, situationMemory);
      } else {
        // stateful: send function_call_output items back to Responses API
        pendingInput = outputs;
      }

      step += 1;
    }

    const gate = await finalAnswerGate({
      oneShot,
      background: this.toolCtx.background,
      tools: this.tools,
      toolCtx: this.toolCtx,
      hasModifiedFiles: hasModifiedFiles.value
    });
    const diffSection = gate.diffPreview ? `\n\n[Diff preview]\n${gate.diffPreview}` : "";
    const actionSection = toolActionSummaries.length > 0
      ? `\n\n[Actions completed]\n${formatActionSummary(toolActionSummaries)}`
      : "";
    const suffix = `${actionSection}${diffSection}\n\n[Final checks]\nBackground: ${gate.backgroundStatus}\nDiff checked: ${gate.diffChecked ? "yes" : "not needed"}`;
    return finalText ? `${finalText}${suffix}` : `Stopped after max steps without a final model message.${suffix}`;
  }

  private async auditIntermediateText(
    memory: SituationMemory,
    planningText: string,
    step: number,
    signal?: AbortSignal
  ): Promise<void> {
    const verifierModel = this.config.verifierModel || this.config.model;
    const result = await auditIntermediateClaims(this.client, verifierModel, memory.getEvidence(), planningText, signal);
    if (!result.ok) {
      // Record failure — do not silently drop. Final verifier will be stricter.
      memory.recordAuditFailure();
      console.log(`[intermediate audit] Audit failed: ${result.reason}. Recorded for stricter final verification.`);
      return;
    }
    for (const assumption of result.unsupported_assumptions) {
      memory.addPendingVerification(assumption.claim, assumption.required_verification, step);
      console.log(`[intermediate audit] Unsupported claim queued: ${assumption.claim.slice(0, 100)}`);
    }
  }

  /** Runs the verifier. Never returns pass:true if reprompt budget is exhausted — always fail closed. */
  private async runVerifierLoop(
    task: string,
    memory: SituationMemory,
    executorClaim: string,
    reprompts: number,
    crashCount: number,
    step: number,
    signal?: AbortSignal
  ): Promise<{ pass: true } | { pass: false; correction: string; crashed?: boolean; stop?: false } | { pass: false; stop: true; stopMessage: string }> {
    // budget exhausted — fail closed, never accept unverified answer
    if (reprompts >= this.config.maxVerifierReprompts) {
      return {
        pass: false,
        stop: true,
        stopMessage: `[agent stopped: max verifier reprompts (${this.config.maxVerifierReprompts}) reached without satisfying verification requirements. Refusing to accept unverified final answer.]`
      };
    }

    const verifierModel = this.config.verifierModel || this.config.model;
    const result = await runVerifier(
      this.client, verifierModel, task,
      memory.getEvidence(), memory.getUnresolvedVerifications(),
      executorClaim, memory.hasAuditFailures(), signal
    );

    if (!result.ok) {
      console.log(`[verifier] ${result.reason}`);
      if (crashCount + 1 >= 2) {
        return {
          pass: false,
          stop: true,
          stopMessage: `[agent stopped: verifier failed ${crashCount + 1} times. Refusing unverified answer. Last error: ${result.reason}]`
        };
      }
      return { pass: false, crashed: true, correction: `[verifier unavailable] ${result.reason}\nPlease provide additional tool evidence before submitting a final answer.` };
    }

    const vr = result.result;
    console.log(`[verifier] verdict=${vr.verdict} confidence=${vr.confidence}`);

    if (vr.resolved_claims?.length) memory.resolvePendingVerifications(vr.resolved_claims);

    if (vr.verdict === "pass" && memory.getUnresolvedVerifications().length === 0) {
      return { pass: true };
    }

    // add new unsupported assumptions to pending queue
    for (const assumption of vr.unsupported_assumptions) {
      memory.addPendingVerification(assumption.claim, assumption.required_verification, step);
    }

    return { pass: false, correction: buildVerifierCorrection(vr) };
  }

  private buildInput(task: string, memory?: SituationMemory): string {
    if (memory) return this.buildStatelessPrompt(task, memory);
    return buildModelInput({
      task,
      context: this.context,
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
      projectInstructions: this.projectInstructions
    });
  }

  private buildStatelessPrompt(task: string, memory: SituationMemory): string {
    return buildModelInput({
      task,
      context: this.context,
      toolIndex: this.toolSkills.toolIndex(),
      generalSkills: this.skillLoader.select(task),
      toolSkills: this.toolSkills.select(task, []),
      projectInstructions: this.projectInstructions,
      situationSnapshot: memory.snapshot()
    });
  }

  private buildCorrectionInput(task: string, correction: string, memory?: SituationMemory): string {
    const base = memory ? this.buildStatelessPrompt(task, memory) : "";
    return base ? `${base}\n\n<Correction>\n${correction}\n</Correction>` : correction;
  }

  private findBlockedCall(
    functionCalls: Array<{ name: string; arguments?: string; call_id: string }>,
    memory: SituationMemory
  ): { name: string; arguments?: string; call_id: string } | undefined {
    return functionCalls.find((call) => {
      let args: unknown;
      try { args = JSON.parse(call.arguments || "{}"); } catch { return false; }
      return memory.hasRecentlyFailed(call.name, args) !== undefined;
    });
  }

  private async executeToolBatch(
    functionCalls: Array<{ name: string; arguments?: string; call_id: string }>,
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
    situationMemory: SituationMemory,
    signal?: AbortSignal
  ): Promise<FunctionCallOutput[]> {
    const outputs: FunctionCallOutput[] = [];
    for (let index = 0; index < functionCalls.length;) {
      const call = functionCalls[index];
      if (this.tools.isReadOnly(call.name)) {
        const batch: typeof functionCalls = [];
        while (index < functionCalls.length && this.tools.isReadOnly(functionCalls[index].name)) {
          batch.push(functionCalls[index++]);
        }
        const results = await Promise.all(batch.map((item) =>
          this.executeOneToolCall(item, step, usedToolNames, toolActionSummaries, hasModifiedFiles, situationMemory, signal)
        ));
        outputs.push(...results);
        continue;
      }
      outputs.push(await this.executeOneToolCall(call, step, usedToolNames, toolActionSummaries, hasModifiedFiles, situationMemory, signal));
      index += 1;
    }
    return outputs;
  }

  private async executeOneToolCall(
    call: { name: string; arguments?: string; call_id: string },
    step: number,
    usedToolNames: Set<string>,
    toolActionSummaries: ToolActionSummary[],
    hasModifiedFiles: { value: boolean },
    situationMemory: SituationMemory,
    signal?: AbortSignal
  ): Promise<FunctionCallOutput> {
    throwIfAborted(signal);
    usedToolNames.add(call.name);
    let args: unknown;
    try {
      args = JSON.parse(call.arguments || "{}");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      situationMemory.recordFailure(call.name, {}, `JSON parse error: ${msg}`, step);
      toolActionSummaries.push({ step, name: call.name, ok: false, summary: `JSON parse error: ${msg}` });
      return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ ok: false, error: { code: "json_parse_error", message: msg } }) };
    }

    const result = await this.tools.execute(call.name, args, this.toolCtx);
    throwIfAborted(signal);
    if (call.name === "apply_patch" && result.ok) hasModifiedFiles.value = true;

    // rawOutput is the literal tool result — NOT a model-generated summary
    const rawOutput = result.ok
      ? JSON.stringify(result.data).slice(0, 800)
      : `ERROR: ${result.error.message}`;

    const summary = result.ok
      ? (result.summary ?? JSON.stringify(result.data).slice(0, 240))
      : result.error.message;

    toolActionSummaries.push({ step, name: call.name, ok: result.ok, summary });
    situationMemory.recordEvidence(call.name, args, rawOutput, result.ok, step);
    if (!result.ok) situationMemory.recordFailure(call.name, args, result.error.message, step);

    this.context.add({
      type: "shell_output",
      content: `tool ${call.name}(${call.arguments}) => ${JSON.stringify(result).slice(0, 4000)}`,
      priority: 45,
      expiresAfterSteps: 2
    });
    return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) };
  }
}

function buildPendingVerificationBlock(unresolved: Array<{ claim: string; requiredAction: string }>): string {
  const lines = [
    "FINALIZATION BLOCKED: These claims are unsupported and must be verified with tool evidence:"
  ];
  for (const pv of unresolved) {
    lines.push(`  Claim: ${pv.claim}`);
    lines.push(`  Required action: ${pv.requiredAction}`);
  }
  lines.push("\nCompliance language ('I verified', 'I checked') is NOT evidence. Use the required tools.");
  return lines.join("\n");
}

function buildVerifierCorrection(vr: VerifierResult): string {
  const lines = [
    `VERIFIER AUDIT — verdict: ${vr.verdict} (confidence: ${vr.confidence})`,
    `Reason: ${vr.reason}`
  ];
  if (vr.unsupported_assumptions.length > 0) {
    lines.push("\nUnsupported assumptions — verify with tool calls:");
    for (const a of vr.unsupported_assumptions) {
      lines.push(`  Claim: ${a.claim}`);
      lines.push(`  Why unsupported: ${a.why_unsupported}`);
      lines.push(`  Required: ${a.required_verification}`);
    }
  }
  if (vr.missing_evidence.length > 0) {
    lines.push("\nMissing evidence:");
    for (const e of vr.missing_evidence) lines.push(`  - ${e}`);
  }
  if (vr.required_next_actions.length > 0) {
    lines.push("\nRequired next actions:");
    for (const a of vr.required_next_actions) lines.push(`  - ${a}`);
  }
  lines.push("\nCompliance language is NOT evidence. Perform the required tool calls.");
  return lines.join("\n");
}

function formatToolBatch(step: number, toolNames: string[]): string {
  return `Grok requested tool batch ${step}: ${[...new Set(toolNames)].join(", ")}`;
}

function formatActionSummary(actions: ToolActionSummary[]): string {
  return actions.map((a) => `- step ${a.step}: ${a.name} ${a.ok ? "ok" : "failed"} - ${a.summary}`).join("\n");
}

export function shouldContinueAfterPlanOnlyResponse(text: string, task: string, actionCount: number): boolean {
  if (!text.trim()) return false;
  const taskLower = task.toLowerCase();
  const saysItWillUseTools = /(brief plan|before first tool call|i'?ll now|i will now|proceeding to|run the first tool|call .*tool|use .*tool|工具)/i.test(text);
  const englishActionTask = /\b(commit|push|edit|modify|fix|write|create|delete|run|test|build|review|issue|pr)\b/i.test(taskLower);
  const localizedActionTask = ["修 bug", "修改", "修正", "建立", "新增", "刪除", "執行", "执行", "測試", "测试", "建置", "提交", "推送", "審核", "開pr", "開 issue"].some((k) => taskLower.includes(k));
  const claimsNoCapability = /no .*tool available|there is no .*tool|tools limited to/i.test(text.toLowerCase());
  return actionCount === 0 && (englishActionTask || localizedActionTask) && (saysItWillUseTools || claimsNoCapability);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Interrupted by user.");
}

function serverTools(config: GrokCodeConfig): ResponseTool[] {
  if (!config.serverTools) return [];
  const tools: ResponseTool[] = [];
  if (config.enableWebSearch) tools.push({ type: "web_search" });
  if (config.enableXSearch) tools.push({ type: "x_search" });
  return tools;
}
