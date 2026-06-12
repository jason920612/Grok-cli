import fs from "node:fs";
import path from "node:path";
import type { WebEvent } from "./server.js";

/** Persisted form of a conversation thread (everything needed to list + replay it). */
export type SavedConversation = {
  id: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  messageCount: number;
  useAgents: boolean;
  model: string;
  workspace: string;
  seq: number;
  buffer: Array<{ seq: number; ev: WebEvent }>;
};

/**
 * On-disk store for web conversations. Each thread is one JSON file under
 * `<workspace>/.grok-code/conversations/`, so conversations auto-persist and
 * survive restarts until explicitly deleted. Best-effort: disk errors never
 * break the live session.
 */
export class ConversationStore {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, ".grok-code", "conversations");
  }

  save(c: SavedConversation): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = path.join(this.dir, `${c.id}.json.tmp`);
      const dst = path.join(this.dir, `${c.id}.json`);
      fs.writeFileSync(tmp, JSON.stringify(c), "utf8");
      fs.renameSync(tmp, dst); // atomic replace so a crash never leaves a half-written file
    } catch {
      /* best effort — never let persistence break the session */
    }
  }

  /** All saved conversations, most-recently-active first. */
  loadAll(): SavedConversation[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: SavedConversation[] = [];
    for (const f of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as SavedConversation;
        if (data && data.id && Array.isArray(data.buffer)) out.push(data);
      } catch {
        /* skip a corrupt file */
      }
    }
    return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  delete(id: string): void {
    try {
      fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    } catch {
      /* best effort */
    }
  }
}
