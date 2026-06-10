import { TUNING } from "../config/tuning.js";

/**
 * Response guards (§7.2) — unified interface replacing the three ad-hoc
 * reprompt counters scattered in the old loop. Each guard owns its block
 * condition, feedback, reprompt budget, and what to do when the budget is
 * spent (terminate vs proceed).
 */
export type GuardContext = {
  text: string;
  toolCallCount: number;
  task: string;
  actionCount: number;
};

export interface ResponseGuard {
  readonly id: string;
  readonly maxReprompts: number;
  readonly onExhausted: "terminate" | "proceed";
  blocks(ctx: GuardContext): boolean;
  feedback(ctx: GuardContext): string;
  terminalMessage(): string;
}

export class EmptyResponseGuard implements ResponseGuard {
  readonly id = "empty_response";
  readonly maxReprompts = TUNING.guard.emptyResponseReprompts;
  readonly onExhausted = "terminate" as const;
  blocks(ctx: GuardContext): boolean {
    return !ctx.text && ctx.toolCallCount === 0;
  }
  feedback(): string {
    return "Your previous response was empty. Continue by emitting exactly one tool call or a final answer. Do not respond with only narration.";
  }
  terminalMessage(): string {
    return "[Agent stopped: model returned repeated empty responses without tool calls or a final answer.]";
  }
}

export class PlanOnlyGuard implements ResponseGuard {
  readonly id = "plan_only";
  readonly maxReprompts = TUNING.guard.planOnlyReprompts;
  readonly onExhausted = "proceed" as const;
  blocks(ctx: GuardContext): boolean {
    return ctx.toolCallCount === 0 && shouldContinueAfterPlanOnlyResponse(ctx.text, ctx.task, ctx.actionCount);
  }
  feedback(): string {
    return "You provided a plan but did not request any function_call tools. The user asked for an action, not only a plan. Continue now by requesting exactly one appropriate tool in this response. If the action cannot be completed, explain the concrete blocker after using any relevant inspection tools.";
  }
  terminalMessage(): string {
    return "";
  }
}

export class MultiToolGuard implements ResponseGuard {
  readonly id = "multi_tool";
  readonly maxReprompts = Number.MAX_SAFE_INTEGER;
  readonly onExhausted = "proceed" as const;
  blocks(ctx: GuardContext): boolean {
    return ctx.toolCallCount > 1;
  }
  feedback(ctx: GuardContext): string {
    return (
      `Invalid response: requested ${ctx.toolCallCount} tool calls in one turn. ` +
      "Continue by requesting exactly one tool call, or provide a final answer if the task is complete."
    );
  }
  terminalMessage(): string {
    return "";
  }
}

export function shouldContinueAfterPlanOnlyResponse(text: string, task: string, actionCount: number): boolean {
  if (!text.trim()) return false;
  const lower = text.toLowerCase();
  const taskLower = task.toLowerCase();
  const saysItWillUseTools =
    /(brief plan|before first tool call|i'?ll now|i will now|proceeding to|run the first tool|call .*tool|use .*tool|工具)/i.test(
      text
    );
  const englishActionTask =
    /\b(commit|push|edit|modify|fix|write|create|delete|run|test|build|review|issue|pr)\b/i.test(taskLower);
  const localizedActionTask = [
    "修 bug",
    "修改",
    "修正",
    "建立",
    "新增",
    "刪除",
    "执行",
    "執行",
    "測試",
    "测试",
    "建置",
    "提交",
    "推送",
    "審核",
    "审核",
    "開pr",
    "開 issue"
  ].some((keyword) => taskLower.includes(keyword));
  const claimsNoCapability = /no .*tool available|there is no .*tool|tools limited to/i.test(lower);
  if (saysItWillUseTools && (englishActionTask || localizedActionTask)) return true;
  return actionCount === 0 && (englishActionTask || localizedActionTask) && claimsNoCapability;
}
