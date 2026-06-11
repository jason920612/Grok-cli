import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Parallel isolation via git worktrees (subagents-v1.md §7.2).
 *
 * - One integration branch/worktree for the orchestrator's merged result.
 * - One worktree+branch per worker → physically isolated file trees, so
 *   parallel workers cannot race on the shared working tree.
 * - On `open_pr` the worker's worktree is committed; the orchestrator `merge`s
 *   the branch into the integration branch. Conflicts are explicit (git) and
 *   the merge is aborted + reported rather than silently corrupting.
 *
 * The user's own working tree is never touched (worktrees live in a temp dir,
 * branched from HEAD).
 */
export class GitService {
  readonly integrationBranch: string;
  readonly integrationDir: string;
  private readonly base: string;

  private readonly ns: string;

  constructor(private readonly repoRoot: string, runId: string) {
    this.base = path.join(os.tmpdir(), `grok-agents-${runId}`);
    // Branch namespace: keep integration and worker branches as siblings under
    // `agents/<runId>/` so neither is a prefix of the other (git ref D/F rule).
    this.ns = `agents/${sanitize(runId)}`;
    this.integrationBranch = `${this.ns}/integration`;
    this.integrationDir = path.join(this.base, "integration");
  }

  isGitRepo(): boolean {
    return this.run(["rev-parse", "--is-inside-work-tree"], this.repoRoot).ok;
  }

  /** Create the integration branch + worktree from HEAD. */
  setup(): void {
    fs.mkdirSync(this.base, { recursive: true });
    const res = this.run(["worktree", "add", "-b", this.integrationBranch, this.integrationDir, "HEAD"], this.repoRoot);
    if (!res.ok) throw new Error(`git: failed to create integration worktree: ${res.stderr}`);
  }

  addWorker(name: string): { dir: string; branch: string } {
    const dir = this.workerDir(name);
    const branch = this.workerBranch(name);
    const res = this.run(["worktree", "add", "-b", branch, dir, this.integrationBranch], this.repoRoot);
    if (!res.ok) throw new Error(`git: failed to create worktree for ${name}: ${res.stderr}`);
    return { dir, branch };
  }

  workerDir(name: string): string {
    return path.join(this.base, `w-${sanitize(name)}`);
  }

  workerBranch(name: string): string {
    return `${this.ns}/${sanitize(name)}`;
  }

  /** Commit everything in a worker's worktree. Returns false if there was nothing to commit. */
  commitWorker(name: string, message: string): boolean {
    const dir = this.workerDir(name);
    this.run(["add", "-A"], dir);
    // Never commit agent-internal state (snapshot trash, sessions, memory) — it
    // is per-worktree and would cause spurious merge conflicts between workers.
    this.run(["reset", "-q", "--", ".grok-code"], dir);
    const res = this.run(["commit", "-m", message], dir);
    return res.ok;
  }

  /** Merge a worker branch into the integration branch. Aborts + reports on conflict. */
  mergeWorker(name: string): { ok: boolean; conflicts?: string[] } {
    const branch = this.workerBranch(name);
    const merge = this.run(["merge", "--no-edit", branch], this.integrationDir);
    if (merge.ok) return { ok: true };
    const conflicts = this.run(["diff", "--name-only", "--diff-filter=U"], this.integrationDir).stdout.split(/\r?\n/).filter(Boolean);
    this.run(["merge", "--abort"], this.integrationDir);
    return { ok: false, conflicts };
  }

  removeWorker(name: string): void {
    this.run(["worktree", "remove", "--force", this.workerDir(name)], this.repoRoot);
  }

  /** Diff stat of the integrated result vs the user's HEAD. */
  integrationDiff(): string {
    return this.run(["diff", "--stat", `HEAD..${this.integrationBranch}`], this.repoRoot).stdout.trim();
  }

  teardown(): void {
    this.run(["worktree", "remove", "--force", this.integrationDir], this.repoRoot);
    this.run(["worktree", "prune"], this.repoRoot);
    try {
      fs.rmSync(this.base, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  private run(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      return { ok: true, stdout, stderr: "" };
    } catch (error: any) {
      return { ok: false, stdout: error?.stdout?.toString() ?? "", stderr: error?.stderr?.toString() ?? String(error?.message ?? error) };
    }
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "-");
}
