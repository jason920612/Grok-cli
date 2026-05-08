export type EvidenceItem = {
  toolName: string;
  ok: boolean;
  args?: string;
  summary: string;
};

export type EvidenceMemoryFact = {
  type: string;
  content: string;
  factSource?: string;
  factConfidence: "verified" | "inferred" | "uncertain";
  source?: {
    path?: string;
    startLine?: number;
    endLine?: number;
    command?: string;
    processId?: string;
  };
};

export type UnsupportedAssumption = {
  claim: string;
  whyUnsupported: string;
  requiredVerification: string;
};

export type VerifierVerdict = {
  verdict: "pass" | "fail" | "needs_more_evidence";
  reason: string;
  unsupportedClaims: string[];
  unsupportedAssumptions: UnsupportedAssumption[];
  missingEvidence: string[];
  requiredNextActions: string[];
  confidence: "high" | "medium" | "low";
};

export type EvidenceBundle = {
  userTask: string;
  executorClaim: string;
  executorTrace: string[];
  evidenceItems: EvidenceItem[];
  memoryFacts: EvidenceMemoryFact[];
};
