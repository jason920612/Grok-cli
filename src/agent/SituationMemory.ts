/** Runtime-observed tool evidence — always verified by definition (the tool ran). */
export type ToolEvidence = {
  step: number;
  tool: string;
  argsText: string;
  /** Raw output from the tool result, NOT a model interpretation. */
  rawOutput: string;
  ok: boolean;
  /** verified = tool succeeded and output is a direct observation; uncertain = tool failed */
  confidence: "verified" | "uncertain";
  filePath?: string;
  lineRange?: { start: number; end: number };
  exitCode?: number;
  changedFiles?: string[];
};

/** An unsupported assumption that must be verified via tool evidence before it can be accepted. */
export type PendingVerification = {
  claim: string;
  requiredAction: string;
  addedAtStep: number;
  resolved: boolean;
};

export type FailureRecord = {
  tool: string;
  normalizedArgs: string;
  error: string;
  attempts: number;
  lastAttemptStep: number;
};

export class SituationMemory {
  private evidence: ToolEvidence[] = [];
  private pendingVerifications: PendingVerification[] = [];
  private failures = new Map<string, FailureRecord>();
  private priorActions: string[] = [];
  private intermediateAuditFailures = 0;

  recordEvidence(tool: string, args: unknown, rawOutput: string, ok: boolean, step: number): void {
    const argsText = stableStringify(tool, args).slice(0, 120);
    this.priorActions.push(`${tool}(${argsText})`);
    this.evidence.push({
      step,
      tool,
      argsText,
      rawOutput: rawOutput.slice(0, 800),
      ok,
      confidence: ok ? "verified" : "uncertain",
      ...extractProvenance(tool, args, rawOutput)
    });
  }

  recordAuditFailure(): void {
    this.intermediateAuditFailures += 1;
  }

  hasAuditFailures(): boolean {
    return this.intermediateAuditFailures > 0;
  }

  addPendingVerification(claim: string, requiredAction: string, step: number): void {
    const alreadyPending = this.pendingVerifications.some((p) => !p.resolved && p.claim === claim);
    if (!alreadyPending) {
      this.pendingVerifications.push({ claim, requiredAction, addedAtStep: step, resolved: false });
    }
  }

  resolvePendingVerifications(resolvedClaims: string[]): void {
    for (const pv of this.pendingVerifications) {
      if (resolvedClaims.includes(pv.claim)) pv.resolved = true;
    }
  }

  getUnresolvedVerifications(): PendingVerification[] {
    return this.pendingVerifications.filter((p) => !p.resolved);
  }

  recordFailure(tool: string, args: unknown, error: string, step: number): void {
    const key = this.failureKey(tool, args);
    const existing = this.failures.get(key);
    if (existing) {
      existing.attempts += 1;
      existing.error = error;
      existing.lastAttemptStep = step;
    } else {
      this.failures.set(key, { tool, normalizedArgs: stableStringify(tool, args), error, attempts: 1, lastAttemptStep: step });
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

    lines.push("EPISTEMIC STANCE: Current workspace state is UNKNOWN until observed via tools.");
    lines.push("Tool success is verified. Your interpretation of tool output is NOT automatically verified.");
    lines.push("Compliance language ('I verified', 'I checked') is NOT evidence.");

    if (this.intermediateAuditFailures > 0) {
      lines.push(`\nWARNING: ${this.intermediateAuditFailures} intermediate claim audit(s) failed. Final verification will be stricter.`);
    }

    if (this.priorActions.length > 0) {
      lines.push("\nPrior runtime actions (observed by the agent runtime, not the user):");
      for (const a of this.priorActions.slice(-20)) lines.push(`  - ${a}`);
    }

    const okEvidence = this.evidence.filter((e) => e.ok).slice(-8);
    if (okEvidence.length > 0) {
      lines.push("\nVerified runtime observations (raw tool output — NOT model interpretations):");
      for (const ev of okEvidence) {
        lines.push(`  [step ${ev.step}] [${ev.confidence.toUpperCase()}] ${ev.tool}${formatProvenance(ev)}: ${ev.rawOutput.slice(0, 200)}`);
      }
    }
    const failedEvidence = this.evidence.filter((e) => !e.ok).slice(-4);
    if (failedEvidence.length > 0) {
      lines.push("\nFailed/uncertain observations:");
      for (const ev of failedEvidence) {
        lines.push(`  [step ${ev.step}] [${ev.confidence.toUpperCase()}] ${ev.tool}${formatProvenance(ev)}: ${ev.rawOutput.slice(0, 100)}`);
      }
    }

    const pending = this.getUnresolvedVerifications();
    if (pending.length > 0) {
      lines.push("\nPENDING VERIFICATIONS — MUST be resolved with tool evidence before final answer:");
      for (const pv of pending) {
        lines.push(`  - Claim: ${pv.claim}`);
        lines.push(`    Required action: ${pv.requiredAction}`);
      }
    }

    const lastFailure = this.getLastFailure();
    if (lastFailure) {
      lines.push("\nLast failure — MUST NOT repeat blindly:");
      lines.push(`  Tool: ${lastFailure.tool} | Error: ${lastFailure.error} | Attempts: ${lastFailure.attempts}`);
      lines.push("  Constraint: Choose a different approach.");
    }

    lines.push("\nEpistemic constraints:");
    lines.push("  - File contents: must be backed by read_file_range (path + line range).");
    lines.push("  - Tests passing: must be backed by run_shell with exit code 0.");
    lines.push("  - Patches applied: must be backed by apply_patch success with changed file list.");

    return lines.join("\n");
  }

  private failureKey(tool: string, args: unknown): string {
    return `${tool}::${stableStringify(tool, args)}`;
  }
}

/** Stable, normalized argument serialization to avoid bypass via key ordering or whitespace. */
function stableStringify(tool: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return String(args);
  const a = args as Record<string, unknown>;
  const keys = Object.keys(a).sort();
  const parts = keys.map((k) => {
    let val = a[k];
    if (typeof val === "string" && (tool === "run_shell" || tool === "start_background_command") && k === "command") {
      val = val.replace(/\s+/g, " ").trim();
    }
    return `${k}:${JSON.stringify(val)}`;
  });
  return parts.join(",");
}

function extractProvenance(tool: string, args: unknown, rawOutput: string): Partial<ToolEvidence> {
  const a = args as Record<string, unknown>;
  const p: Partial<ToolEvidence> = {};
  if (tool === "read_file_range") {
    if (typeof a.path === "string") p.filePath = a.path;
    if (typeof a.start === "number" && typeof a.end === "number") p.lineRange = { start: a.start, end: a.end };
  } else if (tool === "apply_patch") {
    if (typeof a.path === "string") p.filePath = a.path;
    const m = rawOutput.match(/changed files?: (.+)/i);
    if (m) p.changedFiles = m[1].split(",").map((f) => f.trim());
  } else if (tool === "run_shell" || tool === "start_background_command") {
    const m = rawOutput.match(/exit(?:_?code)?[:\s]+(\d+)/i);
    if (m) p.exitCode = parseInt(m[1], 10);
  }
  return p;
}

function formatProvenance(ev: ToolEvidence): string {
  const parts: string[] = [];
  if (ev.filePath) parts.push(ev.filePath);
  if (ev.lineRange) parts.push(`L${ev.lineRange.start}-${ev.lineRange.end}`);
  if (ev.exitCode !== undefined) parts.push(`exit=${ev.exitCode}`);
  if (ev.changedFiles?.length) parts.push(`files=${ev.changedFiles.join(",")}`);
  return parts.length ? `(${parts.join(" ")})` : "";
}
