import type { ApprovalMode } from "../config/loadConfig.js";
import { classifyCommand, type CommandRisk } from "./RiskClassifier.js";
import { promptApproval } from "./promptApproval.js";

export type PatchApprovalMetadata = {
  files: Array<{
    path: string;
    operation: "create" | "modify" | "delete";
    additions: number;
    deletions: number;
  }>;
};

type PatchRisk = "safe" | "ask";

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
    const decision = await promptApproval(command, reason, risk, {
      operation: options.background ? "run background command" : "run shell command",
      policy: this.currentMode,
      scope: options.background ? "workspace background process" : "workspace shell",
      rememberKey: key
    });
    if (decision.approved && decision.rememberSimilar) {
      this.rememberedApprovals.add(key);
    }
    return {
      approved: decision.approved,
      risk,
      message: decision.approved ? undefined : `User denied approval. Alternative requested: ${decision.guidance ?? "Use another approach."}`
    };
  }

  async approvePatch(reason: string, metadata?: PatchApprovalMetadata): Promise<boolean> {
    if (this.currentMode === "never") return false;
    const risk = metadata ? classifyPatchRisk(metadata) : "safe";
    if (risk === "safe") return true;
    if (this.currentMode === "auto-safe") return false;
    if (this.currentMode === "auto-local" || this.currentMode === "auto-all") return true;
    const decision = await promptApproval(formatPatchApprovalCommand(metadata!), reason, "ask", {
      operation: "apply workspace patch",
      policy: this.currentMode,
      scope: "workspace files",
      files: metadata!.files
    });
    return decision.approved;
  }
}

export function classifyPatchRisk(metadata: PatchApprovalMetadata): PatchRisk {
  for (const file of metadata.files) {
    if (file.operation === "delete") return "ask";
    if (file.deletions > 100) return "ask";
    if (isHighRiskPatchPath(file.path)) return "ask";
  }
  return "safe";
}

function isHighRiskPatchPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  if (normalized === "package.json" || normalized.endsWith("/package.json")) return true;
  if (/package-lock\.json$|pnpm-lock\.yaml$|yarn\.lock$|bun\.lockb?$/.test(normalized)) return true;
  if (normalized.startsWith(".github/workflows/") || normalized === ".gitlab-ci.yml") return true;
  if (/(^|\/)(dockerfile|compose\.ya?ml)$/.test(normalized)) return true;
  if (/\.(sh|bash|zsh|fish|ps1|bat|cmd)$/.test(normalized)) return true;
  if (/(^|\/)\.env(\.|$)/.test(normalized)) return true;
  return false;
}

function formatPatchApprovalCommand(metadata: PatchApprovalMetadata): string {
  const files = metadata.files
    .map((file) => `${file.operation} ${file.path} (+${file.additions}/-${file.deletions})`)
    .join(", ");
  return `apply_patch ${files}`;
}

function approvalKey(command: string, risk: CommandRisk, background: boolean): string {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const [first = "", second = ""] = normalized.split(" ");
  return `${background ? "background" : "foreground"}:${risk}:${first} ${second}`.trim();
}
