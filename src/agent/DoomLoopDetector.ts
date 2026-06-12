/**
 * Doom-loop detection (ported from grok-build's `doom_loop/detector.rs`).
 *
 * The repeated-call guard (FailureTracker) blocks an EXACT identical no-progress
 * call, but a model can still thrash — repeating the same operation with trivial
 * variations, or cycling a short sequence — burning the whole step budget. This
 * watches a sliding window of action signatures and escalates: warn the model
 * once (inject a corrective message telling it to change approach), then
 * terminate the turn if it persists.
 */
export class DoomLoopDetector {
  private readonly window: string[] = [];
  private readonly warned = new Set<string>();

  constructor(
    private readonly windowSize = 12,
    private readonly warnThreshold = 3,
    private readonly terminateThreshold = 5
  ) {}

  /**
   * Record the signature of the step just taken; return what to do.
   * `count` is how many times this signature appears in the recent window.
   */
  record(signature: string): { action: "ok" | "warn" | "terminate"; count: number } {
    this.window.push(signature);
    if (this.window.length > this.windowSize) this.window.shift();
    const count = this.window.filter((s) => s === signature).length;
    if (count >= this.terminateThreshold) return { action: "terminate", count };
    if (count >= this.warnThreshold && !this.warned.has(signature)) {
      this.warned.add(signature);
      return { action: "warn", count };
    }
    return { action: "ok", count };
  }

  /** The corrective message injected on the first warning (grok-build's wording). */
  static corrective(count: number): string {
    return (
      `DOOM LOOP DETECTED: You have repeated the same operation ${count} times in a row without making progress. ` +
      "This suggests you are stuck in a loop. STOP and take a different approach. Consider: " +
      "re-reading the latest error/output carefully, trying a fundamentally different solution, or asking the user for guidance. " +
      "If you repeat this exact operation again, the turn will be terminated."
    );
  }
}
