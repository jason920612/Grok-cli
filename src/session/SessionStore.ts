import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CURRENT_SESSION_VERSION, type Session } from "./Session.js";
import type { ApprovalMode } from "../config/loadConfig.js";

export class SessionStore {
  private readonly dir: string;

  constructor(private readonly workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, ".grok-code", "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create(model: string, approval: ApprovalMode): Session {
    const now = new Date().toISOString();
    return {
      version: CURRENT_SESSION_VERSION,
      id: randomUUID(),
      startedAt: now,
      updatedAt: now,
      model,
      workspaceRoot: this.workspaceRoot,
      approval,
      contextItems: [],
      toolCalls: [],
      changedFiles: [],
      backgroundProcesses: []
    };
  }

  load(id?: string): Session | undefined {
    const file = id ? path.join(this.dir, `${id}.json`) : this.latestFile();
    if (!file || !fs.existsSync(file)) return undefined;
    try {
      return migrate(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return undefined;
    }
  }

  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(this.dir, `${session.id}.json`), JSON.stringify(session, null, 2));
  }

  private latestFile(): string | undefined {
    const files = fs.readdirSync(this.dir).filter((file) => file.endsWith(".json"));
    return files.map((file) => path.join(this.dir, file)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
}

/** Bring an on-disk session up to the current schema. Old sessions lacked `version`. */
export function migrate(raw: any): Session {
  const version = typeof raw?.version === "number" ? raw.version : 0;
  const session: Session = {
    version: CURRENT_SESSION_VERSION,
    id: String(raw?.id ?? ""),
    startedAt: String(raw?.startedAt ?? new Date(0).toISOString()),
    updatedAt: String(raw?.updatedAt ?? new Date(0).toISOString()),
    model: String(raw?.model ?? "grok-build-0.1"),
    workspaceRoot: String(raw?.workspaceRoot ?? ""),
    approval: raw?.approval ?? "on-request",
    environmentSummary: raw?.environmentSummary,
    projectToolingSummary: raw?.projectToolingSummary,
    taskSummary: raw?.taskSummary,
    contextItems: Array.isArray(raw?.contextItems) ? raw.contextItems : [],
    toolCalls: Array.isArray(raw?.toolCalls) ? raw.toolCalls : [],
    changedFiles: Array.isArray(raw?.changedFiles) ? raw.changedFiles : [],
    backgroundProcesses: Array.isArray(raw?.backgroundProcesses) ? raw.backgroundProcesses : []
  };
  void version;
  return session;
}
