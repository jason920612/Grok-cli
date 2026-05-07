export type MemoryFactSource = "user" | "read_file" | "terminal" | "patch" | "test" | "model_inference";
export type MemoryFactConfidence = "verified" | "inferred" | "uncertain";

export type MemoryFact = {
  text: string;
  source: MemoryFactSource;
  confidence: MemoryFactConfidence;
};

export type FailureRecord = {
  tool: string;
  normalizedArgs: string;
  error: string;
  attempts: number;
  lastAttemptStep: number;
};

export class SituationMemory {
  private facts: MemoryFact[] = [];
  private priorActions: string[] = [];
  private failures = new Map<string, FailureRecord>();

  recordAction(tool: string, args: unknown, ok: boolean, resultSummary?: string): void {
    const argsStr = JSON.stringify(args).slice(0, 120);
    this.priorActions.push(`${tool}(${argsStr})`);
    if (ok && resultSummary) {
      this.facts.push({
        text: `${tool}: ${resultSummary}`,
        source: this.toolToSource(tool),
        confidence: "verified"
      });
    }
  }

  recordFailure(tool: string, args: unknown, error: string, step: number): void {
    const key = this.failureKey(tool, args);
    const existing = this.failures.get(key);
    if (existing) {
      existing.attempts += 1;
      existing.error = error;
      existing.lastAttemptStep = step;
    } else {
      this.failures.set(key, {
        tool,
        normalizedArgs: JSON.stringify(args),
        error,
        attempts: 1,
        lastAttemptStep: step
      });
    }
  }

  hasRecentlyFailed(tool: string, args: unknown): FailureRecord | undefined {
    return this.failures.get(this.failureKey(tool, args));
  }

  getLastFailure(): FailureRecord | undefined {
    let latest: FailureRecord | undefined;
    for (const record of this.failures.values()) {
      if (!latest || record.lastAttemptStep > latest.lastAttemptStep) {
        latest = record;
      }
    }
    return latest;
  }

  totalFailures(): number {
    let total = 0;
    for (const record of this.failures.values()) total += record.attempts;
    return total;
  }

  snapshot(): string {
    const lines: string[] = [];

    if (this.priorActions.length > 0) {
      lines.push("Prior local agent actions:");
      for (const action of this.priorActions.slice(-20)) lines.push(`- ${action}`);
    }

    const verified = this.facts.filter((f) => f.confidence === "verified").slice(-10);
    if (verified.length > 0) {
      lines.push("\nVerified workspace / runtime observations:");
      for (const fact of verified) lines.push(`- [${fact.source}] ${fact.text}`);
    }

    const lastFailure = this.getLastFailure();
    if (lastFailure) {
      lines.push("\nLast failure - MUST NOT repeat blindly:");
      lines.push(`  Tool: ${lastFailure.tool}`);
      lines.push(`  Error: ${lastFailure.error}`);
      lines.push(`  Attempts: ${lastFailure.attempts}`);
      lines.push("  Constraint: Do not retry the exact same action unchanged. Choose a different approach.");
    }

    lines.push("\nKnown constraints:");
    lines.push("- Do not claim tests pass unless a test command actually passed.");
    lines.push("- Do not infer file contents without reading the file via a tool.");
    lines.push("- Treat verified facts as authoritative. Treat inferred facts as hypotheses requiring tool verification.");

    return lines.join("\n");
  }

  private failureKey(tool: string, args: unknown): string {
    return `${tool}::${JSON.stringify(args)}`;
  }

  private toolToSource(tool: string): MemoryFactSource {
    if (tool === "read_file_range" || tool === "get_file_overview" || tool === "list_files") return "read_file";
    if (tool === "apply_patch") return "patch";
    if (tool.includes("test")) return "test";
    return "terminal";
  }
}
