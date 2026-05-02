import type { ApprovalMode } from "../config/loadConfig.js";
import { classifyCommand, type CommandRisk } from "./RiskClassifier.js";
import { promptApproval } from "./promptApproval.js";

export class ApprovalPolicy {
  constructor(readonly mode: ApprovalMode, readonly originalTask = "") {}

  async approveCommand(command: string, reason: string, options: { background?: boolean } = {}): Promise<{ approved: boolean; risk: CommandRisk; message?: string }> {
    const risk = classifyCommand(command, options.background ?? false);
    if (risk === "deny" || risk === "destructive") {
      return { approved: false, risk, message: "Command is denied by safety policy." };
    }
    if (this.mode === "auto-safe" && (risk === "safe" || risk === "background")) {
      return { approved: true, risk };
    }
    if (this.mode === "never") {
      const explicitlyRequested = this.originalTask.toLowerCase().includes(command.toLowerCase());
      if (explicitlyRequested && risk !== "global_environment_change") return { approved: true, risk };
      return { approved: false, risk, message: "Approval policy is never." };
    }
    if (risk === "safe" && this.mode !== "on-request") return { approved: true, risk };
    const approved = await promptApproval(command, reason, risk);
    return { approved, risk, message: approved ? undefined : "User denied approval." };
  }

  async approvePatch(reason: string): Promise<boolean> {
    if (this.mode === "auto-safe") return true;
    if (this.mode === "never") return false;
    return promptApproval("apply_patch", reason, "ask");
  }
}
