import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { TUNING, type AgentTuning } from "../config/tuning.js";

/**
 * WorkspaceSnapshotStore — git-like undo net for destructive file operations (§9.6).
 *
 * Before any delete/overwrite, the pre-image of the affected file is snapshotted
 * into `.grok-code/.trash/` (content-addressed, deduped). Retention is a sliding
 * window of the last `retainSteps` agent rounds, with total-size and entry-count
 * backstops. Restoration is operator-controlled (CLI); the model is given no
 * restore/clear tool. The trash dir must be sandbox-denied so the model cannot
 * tamper with its own safety net.
 */

export type SnapshotOp = "delete" | "overwrite" | "create";

export type SnapshotEntry = {
  id: string;
  /** Workspace-relative path of the affected file. */
  path: string;
  op: SnapshotOp;
  round: number;
  ts: number;
  /** Content hash of the pre-image blob; absent for `create` (tombstone). */
  sha?: string;
  bytes: number;
};

type Manifest = { maxRound: number; counter: number; entries: SnapshotEntry[] };

export class WorkspaceSnapshotStore {
  readonly trashRoot: string;
  private readonly blobsDir: string;
  private readonly manifestPath: string;
  private readonly cfg: AgentTuning["snapshot"];

  constructor(workspaceRoot: string, tuning: AgentTuning = TUNING) {
    this.trashRoot = path.join(workspaceRoot, ".grok-code", ".trash");
    this.blobsDir = path.join(this.trashRoot, "blobs");
    this.manifestPath = path.join(this.trashRoot, "manifest.json");
    this.cfg = tuning.snapshot;
  }

  /** Snapshot the pre-image of `absPath` before a destructive op. */
  snapshot(absPath: string, relPath: string, op: SnapshotOp, round: number): SnapshotEntry {
    fs.mkdirSync(this.blobsDir, { recursive: true });
    const manifest = this.read();

    let sha: string | undefined;
    let bytes = 0;
    if (op !== "create" && fs.existsSync(absPath) && fs.statSync(absPath).isFile()) {
      const buf = fs.readFileSync(absPath);
      bytes = buf.length;
      sha = hashBuffer(buf);
      const blobPath = path.join(this.blobsDir, sha);
      if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, buf);
    }

    const entry: SnapshotEntry = {
      id: `${String(round).padStart(6, "0")}-${manifest.counter}`,
      path: normalizeRel(relPath),
      op,
      round,
      ts: Date.now(),
      sha,
      bytes
    };
    manifest.counter += 1;
    manifest.maxRound = Math.max(manifest.maxRound, round);
    manifest.entries.push(entry);
    this.prune(manifest);
    this.write(manifest);
    return entry;
  }

  /** Most-recent-first list of snapshots. */
  list(): SnapshotEntry[] {
    return this.read().entries.slice().reverse();
  }

  /** Restore a snapshot by id to `targetAbsPath`. Returns false if not restorable. */
  restore(id: string, targetAbsPath: string): boolean {
    const entry = this.read().entries.find((e) => e.id === id);
    if (!entry) return false;
    if (entry.op === "create") {
      // Undo a creation by removing the file.
      if (fs.existsSync(targetAbsPath)) fs.rmSync(targetAbsPath);
      return true;
    }
    if (!entry.sha) return false;
    const blobPath = path.join(this.blobsDir, entry.sha);
    if (!fs.existsSync(blobPath)) return false;
    fs.mkdirSync(path.dirname(targetAbsPath), { recursive: true });
    fs.copyFileSync(blobPath, targetAbsPath);
    return true;
  }

  private prune(manifest: Manifest): void {
    const minRound = manifest.maxRound - this.cfg.retainSteps;
    manifest.entries = manifest.entries.filter((e) => e.round >= minRound);
    if (manifest.entries.length > this.cfg.maxEntries) {
      manifest.entries = manifest.entries.slice(-this.cfg.maxEntries);
    }
    let total = manifest.entries.reduce((sum, e) => sum + e.bytes, 0);
    while (total > this.cfg.maxTotalBytes && manifest.entries.length > 0) {
      const removed = manifest.entries.shift()!;
      total -= removed.bytes;
    }
    this.gcBlobs(manifest);
  }

  private gcBlobs(manifest: Manifest): void {
    if (!fs.existsSync(this.blobsDir)) return;
    const live = new Set(manifest.entries.map((e) => e.sha).filter(Boolean) as string[]);
    for (const name of fs.readdirSync(this.blobsDir)) {
      if (!live.has(name)) fs.rmSync(path.join(this.blobsDir, name));
    }
  }

  private read(): Manifest {
    if (!fs.existsSync(this.manifestPath)) return { maxRound: 0, counter: 0, entries: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.manifestPath, "utf8")) as Manifest;
      return {
        maxRound: parsed.maxRound ?? 0,
        counter: parsed.counter ?? 0,
        entries: Array.isArray(parsed.entries) ? parsed.entries : []
      };
    } catch {
      return { maxRound: 0, counter: 0, entries: [] };
    }
  }

  private write(manifest: Manifest): void {
    fs.mkdirSync(this.trashRoot, { recursive: true });
    fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }
}

function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex").slice(0, 32);
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
