export type ToolSkill = {
  id: string;
  toolName: string;
  title: string;
  purpose: string;
  whenToUse: string[];
  beforeUse: string[];
  standardProcedure: string[];
  parameterGuidance: string[];
  resultInterpretation: string[];
  afterUse: string[];
  avoid: string[];
  failureRecovery: string[];
  examples: Array<{
    situation: string;
    good: string;
    bad?: string;
  }>;
  short: string;
  full: string;
  tokenEstimate: number;
  priority: number;
};
