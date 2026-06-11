import fs from "node:fs";
import path from "node:path";

/**
 * Per-domain user technical level (scoping-v1.md §5).
 *
 * The same person can be expert at one domain and novice at another, so the
 * scoping dialogue calibrates per domain — technical jargon for domains the
 * user knows, concepts + analogies for domains they don't. Inferred by the
 * model and persisted so it stays consistent across conversations.
 */

export const USER_LEVELS = ["novice", "intermediate", "expert"] as const;
export type UserLevel = (typeof USER_LEVELS)[number];

type Store = { domains: Record<string, { level: UserLevel; updatedAt: number }> };

export class UserProfile {
  private readonly jsonPath: string;
  private store: Store = { domains: {} };

  constructor(workspaceRoot: string) {
    this.jsonPath = path.join(workspaceRoot, ".grok-code", "user-profile.json");
    this.load();
  }

  load(): void {
    if (!fs.existsSync(this.jsonPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.jsonPath, "utf8")) as Store;
      this.store = { domains: parsed?.domains && typeof parsed.domains === "object" ? parsed.domains : {} };
    } catch {
      this.store = { domains: {} };
    }
  }

  /** Record the user's level for a domain (e.g. "backend", "frontend", "ml"). */
  setLevel(domain: string, level: UserLevel): void {
    this.store.domains[normalizeDomain(domain)] = { level, updatedAt: Date.now() };
    this.save();
  }

  level(domain: string): UserLevel | undefined {
    return this.store.domains[normalizeDomain(domain)]?.level;
  }

  all(): Array<{ domain: string; level: UserLevel }> {
    return Object.entries(this.store.domains).map(([domain, v]) => ({ domain, level: v.level }));
  }

  /** Compact form for the system preamble. Empty when nothing known yet. */
  toPreamble(): string {
    const entries = this.all();
    if (entries.length === 0) return "";
    return entries.map((e) => `- ${e.domain}: ${e.level}`).join("\n");
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.jsonPath), { recursive: true });
    fs.writeFileSync(this.jsonPath, JSON.stringify(this.store, null, 2), "utf8");
  }
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}
