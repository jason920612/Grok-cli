/**
 * Canonical home for agent tuning constants — the magic numbers that were
 * previously scattered across ContextManager, ContextBudget, AgentLoop,
 * modelInputBuilder, SkillLoader, and the tool definitions.
 *
 * Values here mirror the historical defaults exactly so that migrating a
 * module to read from `TUNING` is behaviour-preserving. New (v2) modules read
 * from here directly; legacy modules are migrated as they are rewritten.
 *
 * Projects may override via `.grok-code/tuning.json` (see `loadTuning`).
 */

export type AgentTuning = {
  /** Token budgets for the whole context window. */
  budget: {
    maxInputTokens: number;
    warningLimit: number;
    reservedForOutput: number;
    /** Trigger fractions for the compression ladder (fraction of usable budget). */
    degradeAtFraction: number;
    summarizeAtFraction: number;
  };
  /** Per-section input budgets used by the InputBuilder allocator. */
  section: {
    system: number;
    toolIndex: number;
    skills: number;
    toolSkills: number;
    taskSummary: number;
    repoSummary: number;
    environment: number;
    fileRanges: number;
    toolResults: number;
    historySummary: number;
  };
  /** Context selection / compaction limits. */
  context: {
    relevantDefaultTokens: number;
    statelessInferenceTokens: number;
    statelessInferenceLimit: number;
    verifierMemoryTokens: number;
    verifierMemoryFactLimit: number;
    compactionEligibleItems: number;
    grokMdChars: number;
    /** Compact whenever step % this === 0 (in addition to budget pressure). */
    compactionStepInterval: number;
  };
  /** Per-item expiry, in steps. */
  expiry: {
    shellOutput: number;
    verifierFeedback: number;
    verificationTask: number;
  };
  /** Reprompt budgets for response guards. */
  guard: {
    emptyResponseReprompts: number;
    planOnlyReprompts: number;
    /** Nudge toward action after this many consecutive no-progress (inspection) steps. */
    actionNudgeAfterNoProgress: number;
  };
  /** Inline truncation limits. */
  truncate: {
    toolOutputInlineChars: number;
  };
  /** Token estimation. */
  token: {
    /** Initial chars-per-token before live `usage` calibration kicks in. */
    charsPerToken: number;
  };
  /** WorkspaceSnapshotStore — undo/trash for destructive file operations (§9.6). */
  snapshot: {
    /** Sliding-window retention measured in agent steps (rounds). */
    retainSteps: number;
    /** Hard cap on total trash size; oldest snapshots pruned beyond this. */
    maxTotalBytes: number;
    /** Backstop cap on snapshot count. */
    maxEntries: number;
  };
};

export const TUNING: AgentTuning = {
  budget: {
    maxInputTokens: 120_000,
    warningLimit: 70_000,
    reservedForOutput: 16_000,
    degradeAtFraction: 0.8,
    summarizeAtFraction: 0.95
  },
  section: {
    system: 4_000,
    toolIndex: 4_000,
    skills: 12_000,
    toolSkills: 16_000,
    taskSummary: 8_000,
    repoSummary: 8_000,
    environment: 6_000,
    fileRanges: 50_000,
    toolResults: 15_000,
    historySummary: 8_000
  },
  context: {
    relevantDefaultTokens: 90_000,
    statelessInferenceTokens: 20_000,
    statelessInferenceLimit: 10,
    verifierMemoryTokens: 20_000,
    verifierMemoryFactLimit: 40,
    compactionEligibleItems: 80,
    grokMdChars: 12_000,
    compactionStepInterval: 8
  },
  expiry: {
    shellOutput: 2,
    verifierFeedback: 4,
    verificationTask: 6
  },
  guard: {
    emptyResponseReprompts: 1,
    planOnlyReprompts: 2,
    actionNudgeAfterNoProgress: 10
  },
  truncate: {
    toolOutputInlineChars: 4_000
  },
  token: {
    charsPerToken: 4
  },
  snapshot: {
    retainSteps: 30,
    maxTotalBytes: 52_428_800,
    maxEntries: 200
  }
};
