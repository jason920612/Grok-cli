export type FactSource = "user" | "tool_output" | "patch" | "test" | "model_inference";
export type FactConfidence = "verified" | "inferred" | "uncertain";

export type ContextItem = {
  id: string;
  type:
    | "user_task"
    | "plan"
    | "system_instruction"
    | "general_skill"
    | "tool_skill"
    | "tool_index"
    | "repo_summary"
    | "task_summary"
    | "environment_summary"
    | "environment_policy"
    | "project_tooling_summary"
    | "file_range"
    | "file_overview"
    | "search_result"
    | "shell_output"
    | "background_process"
    | "background_output_summary"
    | "patch"
    | "test_result"
    | "action_record"
    | "failure_record"
    | "verifier_feedback"
    | "verification_task"
    | "final";
  content: string;
  tokensEstimate: number;
  priority: number;
  createdAt: number;
  lastUsedAt: number;
  createdStep: number;
  lastUsedStep: number;
  pinned?: boolean;
  expiresAfterSteps?: number;
  factSource?: FactSource;
  factConfidence?: FactConfidence;
  source?: {
    path?: string;
    startLine?: number;
    endLine?: number;
    command?: string;
    processId?: string;
  };
};
