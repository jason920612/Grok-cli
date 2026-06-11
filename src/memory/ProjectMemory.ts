import fs from "node:fs";
import path from "node:path";

/**
 * Project core memory (docs/design/project-memory.md).
 *
 * Durable, project-scoped knowledge that is NOT recoverable from code — the
 * user's development intent, core assumptions, cautions/gotchas, key decisions,
 * conventions. Maintained by the agent via `remember`/`forget`, stored as JSON
 * (machine-edited) and rendered to `.grok-code/memory.md` (human-read). Injected
 * into the stable system preamble each run (never compressed).
 */

export const MEMORY_SECTIONS = ["Intent", "Assumptions", "Cautions", "Decisions", "Conventions"] as const;
export type MemorySection = (typeof MEMORY_SECTIONS)[number];

export type MemoryEntry = {
  id: string;
  section: MemorySection;
  content: string;
  createdAt: number;
  updatedAt: number;
};

type Store = { counter: number; entries: MemoryEntry[] };

export class ProjectMemory {
  private readonly jsonPath: string;
  private readonly mdPath: string;
  private store: Store = { counter: 0, entries: [] };

  constructor(workspaceRoot: string) {
    const dir = path.join(workspaceRoot, ".grok-code");
    this.jsonPath = path.join(dir, "memory.json");
    this.mdPath = path.join(dir, "memory.md");
    this.load();
  }

  load(): void {
    if (!fs.existsSync(this.jsonPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.jsonPath, "utf8")) as Store;
      this.store = {
        counter: typeof parsed.counter === "number" ? parsed.counter : 0,
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isValidEntry) : []
      };
    } catch {
      this.store = { counter: 0, entries: [] };
    }
  }

  entries(): MemoryEntry[] {
    return [...this.store.entries];
  }

  /** Add a new entry, or update an existing one when `id` is given. */
  remember(input: { section: MemorySection; content: string; id?: string }): MemoryEntry {
    const now = Date.now();
    const content = input.content.trim();
    if (input.id) {
      const existing = this.store.entries.find((e) => e.id === input.id);
      if (existing) {
        existing.section = input.section;
        existing.content = content;
        existing.updatedAt = now;
        this.save();
        return existing;
      }
    }
    const entry: MemoryEntry = {
      id: `m${++this.store.counter}`,
      section: input.section,
      content,
      createdAt: now,
      updatedAt: now
    };
    this.store.entries.push(entry);
    this.save();
    return entry;
  }

  forget(id: string): boolean {
    const before = this.store.entries.length;
    this.store.entries = this.store.entries.filter((e) => e.id !== id);
    const removed = this.store.entries.length < before;
    if (removed) this.save();
    return removed;
  }

  /** Markdown rendering grouped by section. */
  render(): string {
    const lines: string[] = ["# Project Memory", ""];
    for (const section of MEMORY_SECTIONS) {
      const items = this.store.entries.filter((e) => e.section === section);
      if (items.length === 0) continue;
      lines.push(`## ${section}`);
      for (const item of items) lines.push(`- ${item.content}  <!-- ${item.id} -->`);
      lines.push("");
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  /** Compact form injected into the system preamble. Empty string when no memory. */
  toPreamble(): string {
    if (this.store.entries.length === 0) return "";
    const lines: string[] = [];
    for (const section of MEMORY_SECTIONS) {
      const items = this.store.entries.filter((e) => e.section === section);
      if (items.length === 0) continue;
      lines.push(`${section}:`);
      for (const item of items) lines.push(`- [${item.id}] ${item.content}`);
    }
    return lines.join("\n");
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.jsonPath), { recursive: true });
    fs.writeFileSync(this.jsonPath, JSON.stringify(this.store, null, 2), "utf8");
    fs.writeFileSync(this.mdPath, this.render(), "utf8");
  }
}

function isValidEntry(value: unknown): value is MemoryEntry {
  const e = value as MemoryEntry;
  return (
    typeof e?.id === "string" &&
    (MEMORY_SECTIONS as readonly string[]).includes(e?.section) &&
    typeof e?.content === "string"
  );
}
