import type { ContextItem } from "../context/ContextItem.js";
import type { BackgroundProcess } from "../background/BackgroundProcess.js";
import type { ApprovalMode } from "../config/loadConfig.js";

export const CURRENT_SESSION_VERSION = 1;

export type Session = {
  version: number;
  id: string;
  startedAt: string;
  updatedAt: string;
  model: string;
  workspaceRoot: string;
  approval: ApprovalMode;
  environmentSummary?: string;
  projectToolingSummary?: string;
  taskSummary?: string;
  contextItems: ContextItem[];
  toolCalls: Array<{
    id: string;
    name: string;
    args: unknown;
    resultSummary: string;
    createdAt: string;
  }>;
  changedFiles: string[];
  backgroundProcesses: BackgroundProcess[];
};
