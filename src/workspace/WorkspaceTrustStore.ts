import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type WorkspaceTrustScope = "exact" | "descendants" | "custom-descendants";

export type WorkspaceTrustEntry = {
  workspace: string;
  scope: WorkspaceTrustScope;
  baseDirectory?: string;
  updatedAt: string;
};

type TrustFile = {
  version: 1;
  entries: WorkspaceTrustEntry[];
  recentWorkspaces: string[];
};

export class WorkspaceTrustStore {
  constructor(private readonly filePath = defaultTrustPath()) {}

  getTrustFor(workspace: string): WorkspaceTrustEntry | undefined {
    const target = normalizeExistingDirectory(workspace);
    const entries = this.read().entries
      .filter((entry) => trustsDirectory(entry, target))
      .sort((a, b) => trustSpecificity(b) - trustSpecificity(a));
    return entries[0];
  }

  setTrust(workspace: string, scope: WorkspaceTrustScope, baseDirectory?: string): WorkspaceTrustEntry {
    const target = normalizeExistingDirectory(workspace);
    const base = scope === "custom-descendants"
      ? normalizeExistingDirectory(baseDirectory ?? workspace)
      : scope === "descendants"
        ? target
        : undefined;
    const entry: WorkspaceTrustEntry = {
      workspace: target,
      scope,
      ...(base ? { baseDirectory: base } : {}),
      updatedAt: new Date().toISOString()
    };
    const data = this.read();
    data.entries = data.entries.filter((item) => item.workspace !== target);
    data.entries.push(entry);
    data.recentWorkspaces = addRecent(data.recentWorkspaces, target);
    this.write(data);
    return entry;
  }

  clearTrust(workspace: string): boolean {
    const target = normalizeExistingDirectory(workspace);
    const data = this.read();
    const next = data.entries.filter((item) => item.workspace !== target);
    const changed = next.length !== data.entries.length;
    if (changed) {
      data.entries = next;
      this.write(data);
    }
    return changed;
  }

  rememberWorkspace(workspace: string): void {
    const target = normalizeExistingDirectory(workspace);
    const data = this.read();
    data.recentWorkspaces = addRecent(data.recentWorkspaces, target);
    this.write(data);
  }

  recentWorkspaces(limit = 8): string[] {
    return this.read().recentWorkspaces.filter((item) => directoryExists(item)).slice(0, limit);
  }

  describe(workspace: string): string {
    const entry = this.getTrustFor(workspace);
    return entry ? describeTrustEntry(entry) : "No remembered trust setting.";
  }

  private read(): TrustFile {
    if (!fs.existsSync(this.filePath)) return emptyTrustFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<TrustFile>;
      return {
        version: 1,
        entries: Array.isArray(parsed.entries) ? parsed.entries.filter(isTrustEntry) : [],
        recentWorkspaces: Array.isArray(parsed.recentWorkspaces) ? parsed.recentWorkspaces.filter(directoryExists) : []
      };
    } catch {
      return emptyTrustFile();
    }
  }

  private write(data: TrustFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  }
}

export function defaultTrustPath(): string {
  const home = os.homedir();
  return path.join(home, ".grok-code", "trust.json");
}

export function describeTrustEntry(entry: WorkspaceTrustEntry): string {
  if (entry.scope === "exact") return `Trust only ${entry.workspace}`;
  const base = entry.baseDirectory ?? entry.workspace;
  return `Trust ${base} and all subdirectories`;
}

function emptyTrustFile(): TrustFile {
  return { version: 1, entries: [], recentWorkspaces: [] };
}

function trustsDirectory(entry: WorkspaceTrustEntry, workspace: string): boolean {
  if (entry.scope === "exact") return samePath(entry.workspace, workspace);
  const base = entry.baseDirectory ?? entry.workspace;
  return isInsideOrSame(workspace, base);
}

function trustSpecificity(entry: WorkspaceTrustEntry): number {
  const base = entry.scope === "exact" ? entry.workspace : entry.baseDirectory ?? entry.workspace;
  return base.length + (entry.scope === "exact" ? 1000 : 0);
}

function normalizeExistingDirectory(input: string): string {
  const abs = path.resolve(input);
  const real = fs.realpathSync(abs);
  if (!fs.statSync(real).isDirectory()) throw new Error(`Not a directory: ${input}`);
  return real;
}

function directoryExists(input: string): boolean {
  try {
    return fs.statSync(input).isDirectory();
  } catch {
    return false;
  }
}

function addRecent(items: string[], workspace: string): string[] {
  return [workspace, ...items.filter((item) => !samePath(item, workspace))].slice(0, 20);
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isInsideOrSame(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTrustEntry(value: unknown): value is WorkspaceTrustEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as WorkspaceTrustEntry;
  return typeof entry.workspace === "string"
    && (entry.scope === "exact" || entry.scope === "descendants" || entry.scope === "custom-descendants")
    && typeof entry.updatedAt === "string"
    && directoryExists(entry.workspace);
}
