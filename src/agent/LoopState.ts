/**
 * Explicit loop state (§7.1) — replaces the 15+ bare mutable variables that
 * implicitly encoded a state machine in the old loop. Pure-stateless: no
 * conversation-chain / mode bookkeeping.
 */
export class LoopState {
  step = 0;
  hasModifiedFiles = false;
  private reprompts = new Map<string, number>();

  constructor(private readonly maxSteps: number, private readonly signal?: AbortSignal) {}

  /** Advance to the next step; returns false when the budget is spent or aborted. */
  advance(): boolean {
    if (this.signal?.aborted) throw new Error("Interrupted by user.");
    if (this.step >= this.maxSteps) return false;
    this.step += 1;
    return true;
  }

  throwIfAborted(): void {
    if (this.signal?.aborted) throw new Error("Interrupted by user.");
  }

  /** Reprompt budget tracking, keyed by guard/gate id. */
  repromptCount(id: string): number {
    return this.reprompts.get(id) ?? 0;
  }

  recordReprompt(id: string): number {
    const next = this.repromptCount(id) + 1;
    this.reprompts.set(id, next);
    return next;
  }

  resetReprompt(id: string): void {
    this.reprompts.delete(id);
  }

  terminationReport(finalText: string): string {
    return finalText || "Stopped after max steps without a final model message.";
  }
}
