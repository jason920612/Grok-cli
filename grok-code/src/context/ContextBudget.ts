export const CONTEXT_BUDGET = {
  maxInputTokens: 120_000,
  warningLimit: 70_000,
  reservedForOutput: 16_000
};

export const SECTION_BUDGET = {
  system: 4000,
  toolIndex: 4000,
  skills: 12000,
  toolSkills: 16000,
  taskSummary: 8000,
  repoSummary: 8000,
  environment: 6000,
  fileRanges: 50000,
  toolResults: 15000,
  conversation: 8000
};
