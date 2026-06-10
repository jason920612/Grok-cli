import type { GrokCodeConfig } from "../config/loadConfig.js";
import type { LLMProvider } from "../api/LLMProvider.js";
import type { EvidenceBundle, VerifierVerdict, UnsupportedAssumption } from "./EvidenceBundle.js";

const VERIFIER_PROMPT = `You are an independent verifier for a coding agent. You did not participate in the previous work.

Your only job is to determine whether the executor's claimed result is actually supported by the collected evidence.

Rules:
- Only trust tool-backed evidence: file reads, shell command outputs, patches applied, test results, git operations.
- Treat runtime memory facts as evidence only when they are marked confidence=verified. Treat inferred/uncertain facts as hypotheses or missing-evidence hints, not proof.
- Treat executor visible trace as claims/assumptions to audit, not evidence. Flag unsupported assumptions in that trace when evidence is missing.
- Do not trust the executor's claim, reasoning, intentions, or self-assessment at face value.
- Do not self-certify compliance with these rules; only evidence references count.
- A failed tool call (ok=false) proves failure, not success.
- Claims about current workspace state must be traceable to at least one tool result in the evidence list.
- If the executor expresses intent ("I will check...") but the evidence shows no corresponding tool call, that is an unsupported assumption.

Return ONLY a JSON object — no other text, no markdown fences:
{
  "verdict": "pass" | "fail" | "needs_more_evidence",
  "reason": "one-sentence explanation",
  "unsupportedClaims": ["..."],
  "unsupportedAssumptions": [
    {
      "claim": "assumption the executor made",
      "whyUnsupported": "no tool call in evidence confirms this",
      "requiredVerification": "which tool call would confirm it"
    }
  ],
  "missingEvidence": ["..."],
  "requiredNextActions": ["specific tool call or check needed"],
  "confidence": "high" | "medium" | "low"
}

Use "pass" only when all material claims in the executor's final answer are traceable to evidence.
Use "needs_more_evidence" when key claims are unverified but the task might still be completable.
Use "fail" when the evidence actively contradicts the executor's claim or critical steps were skipped.`;

/**
 * Independent verifier quality gate (§7.3). Constructed once with a provider and
 * reused — never re-instantiated inside the loop's hot path.
 */
export class VerifierAgent {
  constructor(
    private readonly provider: LLMProvider,
    private readonly _config: GrokCodeConfig
  ) {}

  async verify(bundle: EvidenceBundle): Promise<VerifierVerdict> {
    const input = buildVerifierInput(bundle);
    try {
      const result = await this.provider.complete({
        messages: [{ role: "user", content: input }],
        tools: [],
        toolChoice: "none",
        parallelToolCalls: false
      });
      return parseVerifierVerdict(result.text);
    } catch (error) {
      return fallbackVerdict(`Verifier API call failed: ${formatApiError(error)}`);
    }
  }
}

export function buildVerifierFeedback(verdict: VerifierVerdict): string {
  const lines: string[] = [
    `[Verifier] verdict: ${verdict.verdict} (confidence: ${verdict.confidence})`,
    `Reason: ${verdict.reason}`
  ];
  if (verdict.unsupportedClaims.length > 0) {
    lines.push("Unsupported claims:");
    for (const claim of verdict.unsupportedClaims) lines.push(`  - ${claim}`);
  }
  if (verdict.unsupportedAssumptions.length > 0) {
    lines.push("Unsupported assumptions:");
    for (const a of verdict.unsupportedAssumptions) {
      lines.push(`  - Claim: ${a.claim}`);
      lines.push(`    Why unsupported: ${a.whyUnsupported}`);
      lines.push(`    Required verification: ${a.requiredVerification}`);
    }
  }
  if (verdict.missingEvidence.length > 0) {
    lines.push("Missing evidence:");
    for (const item of verdict.missingEvidence) lines.push(`  - ${item}`);
  }
  if (verdict.requiredNextActions.length > 0) {
    lines.push("Required next actions:");
    for (const action of verdict.requiredNextActions) lines.push(`  - ${action}`);
  }
  lines.push(
    "An independent verifier reviewed the evidence and found the above issues.",
    "Address each required next action using tools before providing a final answer.",
    "Do not re-assert the same claim without first collecting the missing evidence."
  );
  return lines.join("\n");
}

function buildVerifierInput(bundle: EvidenceBundle): string {
  const evidenceText = bundle.evidenceItems.length > 0
    ? bundle.evidenceItems
        .map((item, i) => `${i + 1}. [${item.ok ? "ok" : "failed"}] ${item.toolName}(${item.args ?? ""}) => ${item.summary}`)
        .join("\n")
    : "No tool calls recorded.";

  const memoryFactsText = bundle.memoryFacts.length > 0
    ? bundle.memoryFacts
        .map((item, i) => {
          const source = [
            item.factSource ? `source=${item.factSource}` : undefined,
            `confidence=${item.factConfidence}`,
            item.source?.path ? `path=${item.source.path}` : undefined,
            item.source?.startLine !== undefined ? `startLine=${item.source.startLine}` : undefined,
            item.source?.endLine !== undefined ? `endLine=${item.source.endLine}` : undefined,
            item.source?.command ? `command=${item.source.command}` : undefined
          ].filter(Boolean).join(", ");
          return `${i + 1}. [${item.type}${source ? `; ${source}` : ""}] ${item.content}`;
        })
        .join("\n")
    : "No runtime memory facts recorded.";

  const traceText = bundle.executorTrace.length > 0
    ? bundle.executorTrace.map((item, i) => `${i + 1}. ${item}`).join("\n")
    : "No executor trace recorded.";

  return `${VERIFIER_PROMPT}

<task>
${bundle.userTask}
</task>

<evidence>
${evidenceText}
</evidence>

<runtime_memory_facts>
${memoryFactsText}
</runtime_memory_facts>

<executor_visible_trace_claims_not_evidence>
${traceText}
</executor_visible_trace_claims_not_evidence>

<claim>
${bundle.executorClaim}
</claim>`;
}

function parseVerifierVerdict(text: string): VerifierVerdict {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return fallbackVerdict("Verifier returned non-JSON output.");
  try {
    const raw = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
    return {
      verdict: parseVerdict(raw.verdict),
      reason: String(raw.reason ?? "No reason provided."),
      unsupportedClaims: parseStringArray(raw.unsupportedClaims),
      unsupportedAssumptions: parseAssumptions(raw.unsupportedAssumptions),
      missingEvidence: parseStringArray(raw.missingEvidence),
      requiredNextActions: parseStringArray(raw.requiredNextActions),
      confidence: parseConfidence(raw.confidence)
    };
  } catch {
    return fallbackVerdict("Verifier returned malformed JSON.");
  }
}

function parseVerdict(value: unknown): VerifierVerdict["verdict"] {
  if (value === "pass" || value === "fail" || value === "needs_more_evidence") return value;
  return "needs_more_evidence";
}

function parseConfidence(value: unknown): VerifierVerdict["confidence"] {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "low";
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseAssumptions(value: unknown): UnsupportedAssumption[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      claim: String(item.claim ?? ""),
      whyUnsupported: String(item.whyUnsupported ?? ""),
      requiredVerification: String(item.requiredVerification ?? "")
    }));
}

function fallbackVerdict(reason: string): VerifierVerdict {
  return {
    verdict: "needs_more_evidence",
    reason,
    unsupportedClaims: [],
    unsupportedAssumptions: [],
    missingEvidence: [],
    requiredNextActions: [],
    confidence: "low"
  };
}

function formatApiError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    error?: unknown;
  };
  const parts = [
    details.message,
    details.status !== undefined ? `status=${String(details.status)}` : undefined,
    details.code !== undefined ? `code=${String(details.code)}` : undefined,
    details.type !== undefined ? `type=${String(details.type)}` : undefined,
    details.error !== undefined ? `error=${stringifyErrorDetail(details.error)}` : undefined
  ].filter(Boolean);
  return parts.join("; ");
}

function stringifyErrorDetail(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
