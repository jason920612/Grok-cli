import type { ApprovalMode } from "../config/loadConfig.js";
import { classifyCommand, type CommandRisk } from "./RiskClassifier.js";
import { promptApproval } from "./promptApproval.js";

export class ApprovalPolicy {
  private rememberedApprovals = new Set<string>();

  constructor(private currentMode: ApprovalMode, readonly originalTask = "") {}

  get mode(): ApprovalMode {
    return this.currentMode;
  }

  setMode(mode: ApprovalMode): void {
    this.currentMode = mode;
  }

  async approveCommand(command: string, reason: string, options: { background?: boolean } = {}): Promise<{ approved: boolean; risk: CommandRisk; message?: string }> {
    const risk = classifyCommand(command, options.background ?? false);
    const key = approvalKey(command, risk, options.background ?? false);
    if (risk === "deny" || risk === "destructive") {
      return { approved: false, risk, message: "Command is denied by safety policy." };
    }
    if (this.rememberedApprovals.has(key)) {
      return { approved: true, risk };
    }
    if (this.currentMode === "auto-all") {
      return { approved: true, risk };
    }
    if (this.currentMode === "auto-local" && risk !== "global_environment_change") {
      return { approved: true, risk };
    }
    if (this.currentMode === "auto-safe" && (risk === "safe" || risk === "background")) {
      return { approved: true, risk };
    }
    if (this.currentMode === "never") {
      const explicitlyRequested = this.originalTask.toLowerCase().includes(command.toLowerCase());
      if (explicitlyRequested && risk !== "global_environment_change") return { approved: true, risk };
      return { approved: false, risk, message: "Approval policy is never." };
    }
    if (risk === "safe") return { approved: true, risk };
    const decision = await promptApproval(command, reason, risk);
    if (decision.approved && decision.rememberSimilar) {
      this.rememberedApprovals.add(key);
    }
    return {
      approved: decision.approved,
      risk,
      message: decision.approved ? undefined : `User denied approval. Alternative requested: ${decision.guidance ?? "Use another approach."}`
    };
  }

  async approvePatch(reason: string): Promise<boolean> {
    if (this.currentMode === "never") return false;
    return true;
  }
}

function approvalKey(command: string, risk: CommandRisk, background: boolean): string {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const [first = "", second = ""] = normalized.split(" ");
  return `${background ? "background" : "foreground"}:${risk}:${first} ${second}`.trim();
}
