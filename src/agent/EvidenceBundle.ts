export type EvidenceItem = {
  toolName: string;
  ok: boolean;
  args?: string;
  summary: string;
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
  evidenceItems: EvidenceItem[];
};
