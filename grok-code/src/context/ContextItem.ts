export type ContextItem = {
  id: string;
  type:
    | "user_task"
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
    | "final";
  content: string;
  tokensEstimate: number;
  priority: number;
  createdAt: number;
  lastUsedAt: number;
  pinned?: boolean;
  expiresAfterSteps?: number;
  source?: {
    path?: string;
    startLine?: number;
    endLine?: number;
    command?: string;
    processId?: string;
  };
};
