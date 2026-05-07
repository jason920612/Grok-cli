export type MemoryFactSource = "user" | "read_file" | "terminal" | "patch" | "test" | "model_inference";
export type MemoryFactConfidence = "verified" | "inferred" | "uncertain";

export type MemoryFact = {
  text: string;
  source: MemoryFactSource;
  confidence: MemoryFactConfidence;
  evidenceRef?: string;
};

export type ToolEvidence = {
  step: number;
  tool: string;
  argsText: string;
  outputExcerpt: string;
  ok: boolean;
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
  private evidence: ToolEvidence[] = [];

  recordEvidence(tool: string, args: unknown, outputExcerpt: string, ok: boolean, step: number): void {
    const argsText = JSON.stringify(args).slice(0, 120);
    this.priorActions.push(`${tool}(${argsText})`);
    this.evidence.push({ step, tool, argsText, outputExcerpt: outputExcerpt.slice(0, 600), ok });

    if (ok) {
      const ref = `${tool}@step${step}`;
      this.facts.push({
        text: `${tool} succeeded: ${outputExcerpt.slice(0, 200)}`,
        source: this.toolToSource(tool),
        confidence: "verified",
        evidenceRef: ref
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
      if (!latest || record.lastAttemptStep > latest.lastAttemptStep) latest = record;
    }
    return latest;
  }

  totalFailures(): number {
    let total = 0;
    for (const record of this.failures.values()) total += record.attempts;
    return total;
  }

  getEvidence(): ToolEvidence[] {
    return this.evidence;
  }

  snapshot(): string {
    const lines: string[] = [];

    lines.push("Current workspace state is UNKNOWN until observed via tools.");
    lines.push("Do not infer or assume file contents, test results, or environment state without tool evidence.");

    if (this.priorActions.length > 0) {
      lines.push("\nPrior local agent actions (runtime-observed, not user actions):");
      for (const action of this.priorActions.slice(-20)) lines.push(`- ${action}`);
    }

    const recentEvidence = this.evidence.filter((e) => e.ok).slice(-8);
    if (recentEvidence.length > 0) {
      lines.push("\nVerified runtime observations (evidence-backed only):");
      for (const ev of recentEvidence) {
        lines.push(`- [step ${ev.step}] ${ev.tool}(${ev.argsText}): ${ev.outputExcerpt.slice(0, 200)}`);
      }
    }

    const lastFailure = this.getLastFailure();
    if (lastFailure) {
      lines.push("\nLast failure - MUST NOT repeat blindly:");
      lines.push(`  Tool: ${lastFailure.tool}`);
      lines.push(`  Error: ${lastFailure.error}`);
      lines.push(`  Attempts: ${lastFailure.attempts}`);
      lines.push("  Constraint: Do not retry the exact same action unchanged. Choose a different approach.");
    }

    lines.push("\nEpistemic constraints:");
    lines.push("- Claims about file contents must be backed by read_file_range evidence.");
    lines.push("- Claims that tests pass must be backed by a test command with exit status 0.");
    lines.push("- Claims that patches were applied must be backed by apply_patch success.");
    lines.push("- Do not present inferred facts as confirmed.");

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
