import type OpenAI from "openai";
import { createResponse } from "../api/responsesClient.js";
import type { ToolEvidence } from "./SituationMemory.js";

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
};

const VERIFIER_PROMPT = `You are an independent evidence auditor for a coding agent runtime. Your job is to determine whether the executor's final claim is supported by concrete runtime evidence.

Rules:
- Do not trust the executor's self-assessment or language like "I verified" or "I checked".
- Only trust the runtime evidence listed below (tool calls and their outputs).
- Claims about file contents must be backed by read_file_range evidence.
- Claims that tests pass must be backed by a test command with exit code 0.
- Claims that patches were applied must be backed by apply_patch success output.
- If a claim cannot be traced to runtime evidence, it is an unsupported assumption.

Respond with a JSON object only, no other text. Use this exact schema:
{
  "verdict": "pass" | "fail" | "needs_more_evidence",
  "reason": "short explanation",
  "evidence_backed_facts": ["fact backed by evidence", ...],
  "executor_claims": ["claim made by executor", ...],
  "unsupported_assumptions": [
    {
      "claim": "...",
      "why_unsupported": "...",
      "required_verification": "..."
    }
  ],
  "missing_evidence": ["what evidence is missing", ...],
  "required_next_actions": ["what the agent should do next", ...],
  "confidence": "high" | "medium" | "low"
}`;

export async function runVerifier(
  client: OpenAI,
  model: string,
  task: string,
  evidence: ToolEvidence[],
  executorClaim: string,
  signal?: AbortSignal
): Promise<VerifierResult> {
  const evidenceText = evidence.length > 0
    ? evidence.map((e) =>
        `[step ${e.step}] Tool: ${e.tool}\nArgs: ${e.argsText}\nStatus: ${e.ok ? "ok" : "failed"}\nOutput:\n${e.outputExcerpt}`
      ).join("\n---\n")
    : "No tool evidence recorded.";

  const input = `${VERIFIER_PROMPT}

ORIGINAL TASK:
${task}

RUNTIME EVIDENCE:
${evidenceText}

EXECUTOR FINAL CLAIM (treat as unverified until you audit it):
${executorClaim}`;

  const response = await createResponse(client, {
    model,
    input,
    tools: [],
    toolChoice: "none",
    signal
  });

  const text = extractResponseText(response);
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("no JSON found");
    return JSON.parse(jsonMatch[0]) as VerifierResult;
  } catch {
    return {
      verdict: "needs_more_evidence",
      reason: `Verifier returned non-JSON response: ${text.slice(0, 200)}`,
      evidence_backed_facts: [],
      executor_claims: [executorClaim.slice(0, 200)],
      unsupported_assumptions: [],
      missing_evidence: [],
      required_next_actions: ["Re-run with explicit tool verification"],
      confidence: "low"
    };
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
