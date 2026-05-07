import type OpenAI from "openai";
import { createResponse } from "../api/responsesClient.js";
import type { ToolEvidence, PendingVerification } from "./SituationMemory.js";

export type VerifierVerdict = "pass" | "fail" | "needs_more_evidence";

export type UnsupportedAssumption = {
  claim: string;
  why_unsupported: string;
  required_verification: string;
};

export type VerifierResult = {
  verdict: VerifierVerdict;
  reason: string;
  evidence_backed_facts: string[];
  executor_claims: string[];
  unsupported_assumptions: UnsupportedAssumption[];
  missing_evidence: string[];
  required_next_actions: string[];
  confidence: "high" | "medium" | "low";
  /** Claims that are now resolved (backed by evidence) — used to clear pending verifications. */
  resolved_claims?: string[];
};

const VERIFIER_SYSTEM_PROMPT = `You are an independent evidence auditor for a coding agent runtime. Your sole job is to determine whether the executor's claims are supported by concrete runtime evidence.

Rules you must follow:
1. Do NOT trust the executor's self-assessment or compliance language ("I verified", "I checked", "I confirmed").
2. Compliance language is NOT evidence. Only tool results are evidence.
3. Claims about file contents must be backed by a read_file_range result with file path and line range.
4. Claims that tests pass must be backed by a run_shell result with exit code 0.
5. Claims that patches were applied must be backed by an apply_patch result with changed file list.
6. Claims about environment/dependency state must be backed by tool observation.
7. If a claim cannot be traced to a concrete tool result in the evidence list, it is unsupported.

Respond with a JSON object only. No prose before or after the JSON. Use this exact schema:
{
  "verdict": "pass" | "fail" | "needs_more_evidence",
  "reason": "one sentence",
  "evidence_backed_facts": ["..."],
  "executor_claims": ["..."],
  "unsupported_assumptions": [
    { "claim": "...", "why_unsupported": "...", "required_verification": "..." }
  ],
  "missing_evidence": ["..."],
  "required_next_actions": ["..."],
  "resolved_claims": ["..."],
  "confidence": "high" | "medium" | "low"
}`;

export type VerifierRunResult =
  | { ok: true; result: VerifierResult }
  | { ok: false; reason: string };

export async function runVerifier(
  client: OpenAI,
  model: string,
  task: string,
  evidence: ToolEvidence[],
  pendingVerifications: PendingVerification[],
  executorClaim: string,
  signal?: AbortSignal
): Promise<VerifierRunResult> {
  const evidenceText = evidence.length > 0
    ? evidence.map((e) => {
        const provenance = [
          e.filePath ? `file=${e.filePath}` : null,
          e.lineRange ? `lines=${e.lineRange.start}-${e.lineRange.end}` : null,
          e.exitCode !== undefined ? `exit=${e.exitCode}` : null,
          e.changedFiles?.length ? `changed=${e.changedFiles.join(",")}` : null
        ].filter(Boolean).join(" ");
        return `[step ${e.step}] Tool: ${e.tool} | Status: ${e.ok ? "ok" : "failed"}${provenance ? ` | ${provenance}` : ""}\nArgs: ${e.argsText}\nRaw output:\n${e.rawOutput}`;
      }).join("\n---\n")
    : "No tool evidence recorded.";

  const pendingText = pendingVerifications.length > 0
    ? "\nPreviously identified pending verifications:\n" + pendingVerifications.map(
        (p) => `  - ${p.claim} (required: ${p.requiredAction})`
      ).join("\n")
    : "";

  const input = `${VERIFIER_SYSTEM_PROMPT}

ORIGINAL TASK:
${task}

RUNTIME EVIDENCE (raw tool results — these are the only facts):
${evidenceText}
${pendingText}

EXECUTOR FINAL CLAIM (treat as unverified — audit against the evidence above):
${executorClaim}`;

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await createResponse(client, {
        model,
        input,
        tools: [],
        toolChoice: "none",
        signal
      });

      const text = extractResponseText(response);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        lastError = `attempt ${attempt + 1}: no JSON in response: ${text.slice(0, 200)}`;
        continue;
      }
      const parsed = JSON.parse(jsonMatch[0]) as VerifierResult;
      if (!["pass", "fail", "needs_more_evidence"].includes(parsed.verdict)) {
        lastError = `attempt ${attempt + 1}: invalid verdict: ${parsed.verdict}`;
        continue;
      }
      return { ok: true, result: parsed };
    } catch (err) {
      lastError = `attempt ${attempt + 1}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // fail closed — do not silently accept the executor's answer
  return { ok: false, reason: `Verifier could not produce a verdict after 2 attempts. Last error: ${lastError}` };
}

const INTERMEDIATE_AUDIT_PROMPT = `You are an independent assumption detector for a coding agent runtime. Your job is to find current-state claims in intermediate planning text that are NOT backed by the runtime evidence provided.

Rules:
1. Only identify claims about observable workspace state: file contents, test results, environment state, command output, dependency state.
2. Do NOT flag general reasoning, algorithmic plans, or hypotheticals.
3. Claims backed by a tool result in the evidence list are acceptable.
4. Compliance language ("I will check", "let me verify") is intent, not a claim — do not flag it.
5. Only flag concrete factual assertions about the current state of the workspace.

Respond with JSON only. No prose. Schema:
{
  "unsupported_assumptions": [
    { "claim": "...", "why_unsupported": "...", "required_verification": "..." }
  ]
}
If there are no unsupported current-state claims, return: { "unsupported_assumptions": [] }`;

export type IntermediateAuditResult =
  | { ok: true; unsupported_assumptions: UnsupportedAssumption[] }
  | { ok: false; reason: string };

export async function auditIntermediateClaims(
  client: OpenAI,
  model: string,
  evidence: ToolEvidence[],
  planningText: string,
  signal?: AbortSignal
): Promise<IntermediateAuditResult> {
  if (!planningText.trim()) return { ok: true, unsupported_assumptions: [] };

  const evidenceText = evidence.length > 0
    ? evidence.map((e) => {
        const provenance = [
          e.filePath ? `file=${e.filePath}` : null,
          e.lineRange ? `lines=${e.lineRange.start}-${e.lineRange.end}` : null,
          e.exitCode !== undefined ? `exit=${e.exitCode}` : null
        ].filter(Boolean).join(" ");
        return `[step ${e.step}] ${e.tool}${provenance ? ` (${provenance})` : ""}: ${e.rawOutput.slice(0, 200)}`;
      }).join("\n")
    : "No tool evidence yet.";

  const input = `${INTERMEDIATE_AUDIT_PROMPT}

RUNTIME EVIDENCE:
${evidenceText}

INTERMEDIATE PLANNING TEXT TO AUDIT:
${planningText}`;

  try {
    const response = await createResponse(client, { model, input, tools: [], toolChoice: "none", signal });
    const text = extractResponseText(response);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ok: true, unsupported_assumptions: [] }; // lenient on parse failure
    const parsed = JSON.parse(jsonMatch[0]) as { unsupported_assumptions: UnsupportedAssumption[] };
    return { ok: true, unsupported_assumptions: parsed.unsupported_assumptions ?? [] };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function extractResponseText(response: any): string {
  const output = Array.isArray(response?.output) ? response.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if (typeof c?.text === "string") parts.push(c.text);
        if (typeof c?.output_text === "string") parts.push(c.output_text);
      }
    }
    if (typeof item?.content === "string") parts.push(item.content);
  }
  if (typeof response?.output_text === "string") parts.push(response.output_text);
  return parts.join("\n").trim();
}
