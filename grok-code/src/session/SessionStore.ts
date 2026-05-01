import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Session } from "./Session.js";
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
    return JSON.parse(fs.readFileSync(file, "utf8")) as Session;
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
