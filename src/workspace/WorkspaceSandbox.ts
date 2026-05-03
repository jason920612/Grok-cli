import fs from "node:fs";
import path from "node:path";
import type { SandboxProfile } from "../config/loadConfig.js";
import { GENERATED_OUTPUT_DIRS, generatedOutputDirsForProfile } from "./IgnoreRules.js";

type SandboxOperation = "read" | "patch";
type SandboxRule = "allowed" | "sensitive-path-denied" | "generated-output-read-denied" | "generated-output-patch-denied";

export class WorkspaceSandbox {
  readonly root: string;
  readonly profile: SandboxProfile;
  readonly trusted: boolean;
  private readonly sessionAllowedGeneratedRoots = new Set<string>();

  constructor(root: string, profile: SandboxProfile = "default", trusted = false) {
    this.root = fs.realpathSync(root);
    this.profile = profile;
    this.trusted = trusted;
  }

  resolvePath(inputPath = "."): string {
    if (inputPath.includes("\0")) throw new Error("Invalid path.");
    const resolved = path.resolve(this.root, inputPath);
    const parent = fs.existsSync(resolved) ? resolved : path.dirname(resolved);
    const realParent = fs.realpathSync(parent);
    if (!isInside(realParent, this.root)) throw new Error(`Path escapes workspace: ${inputPath}`);
    return resolved;
  }

  relative(absPath: string): string {
    return path.relative(this.root, absPath).replace(/\\/g, "/");
  }

  assertReadableFile(inputPath: string): string {
    const abs = this.resolvePath(inputPath);
    const rel = this.relative(abs);
    this.assertAllowedPath(rel, "read");
    const realAbs = fs.realpathSync(abs);
    if (!isInside(realAbs, this.root)) throw new Error(`Path escapes workspace: ${inputPath}`);
    const realRel = this.relative(realAbs);
    this.assertAllowedPath(realRel, "read");
    const stat = fs.statSync(realAbs);
    if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
    if (looksBinary(realAbs)) throw new Error(`Binary file rejected: ${rel}`);
    return realAbs;
  }

  assertWritablePatchPath(inputPath: string): string {
    const abs = this.resolveWritablePath(inputPath);
    const rel = this.relative(abs);
    this.assertAllowedPath(rel, "patch");
    assertNoSymlinkPathComponents(abs, this.root, inputPath);
    return abs;
  }

  allowGeneratedOutputPath(inputPath: string): void {
    const abs = fs.realpathSync(path.resolve(this.root, inputPath));
    if (!isInside(abs, this.root)) throw new Error(`Path escapes workspace: ${inputPath}`);
    this.sessionAllowedGeneratedRoots.add(this.relative(abs));
  }

  isPathDenied(relPath: string, operation: SandboxOperation = "read"): boolean {
    return this.inspectPath(relPath, operation).rule !== "allowed";
  }

  inspectPath(relPath: string, operation: SandboxOperation = "read"): { rule: SandboxRule; suggestedProfile?: SandboxProfile } {
    const normalized = normalizeRel(relPath);
    if (isSensitivePath(normalized)) return { rule: "sensitive-path-denied" };
    const generatedRoot = generatedOutputRoot(normalized);
    if (!generatedRoot) return { rule: "allowed" };
    if (this.trusted) return { rule: "allowed" };
    if (operation === "patch") return { rule: "generated-output-patch-denied", suggestedProfile: suggestedProfileForGeneratedRoot(generatedRoot) };
    if (generatedOutputDirsForProfile(this.profile).includes(generatedRoot)) return { rule: "allowed" };
    if (this.isSessionAllowedGeneratedPath(normalized)) return { rule: "allowed" };
    return { rule: "generated-output-read-denied", suggestedProfile: suggestedProfileForGeneratedRoot(generatedRoot) };
  }

  private assertAllowedPath(relPath: string, operation: SandboxOperation): void {
    const decision = this.inspectPath(relPath, operation);
    if (decision.rule === "allowed") return;
    throw new Error(formatSandboxBlock(decision.rule, relPath, operation, this.profile, decision.suggestedProfile));
  }

  private isSessionAllowedGeneratedPath(relPath: string): boolean {
    for (const root of this.sessionAllowedGeneratedRoots) {
      if (relPath === root || relPath.startsWith(`${root}/`)) return true;
    }
    return false;
  }

  private resolveWritablePath(inputPath: string): string {
    if (inputPath.includes("\0")) throw new Error("Invalid path.");
    const resolved = path.resolve(this.root, inputPath);
    const realParent = fs.realpathSync(nearestExistingAncestor(resolved));
    if (!isInside(realParent, this.root)) throw new Error(`Path escapes workspace: ${inputPath}`);
    return resolved;
  }
}

export function isDeniedPath(relPath: string, profile: SandboxProfile = "default", operation: SandboxOperation = "read", trusted = false): boolean {
  const normalized = normalizeRel(relPath);
  if (isSensitivePath(normalized)) return true;
  const root = generatedOutputRoot(normalized);
  if (!root) return false;
  if (trusted) return false;
  if (operation === "patch") return true;
  return !generatedOutputDirsForProfile(profile).includes(root);
}

function isSensitivePath(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.some((segment) => segment === ".git" || segment === "node_modules" || segment === "secrets" || segment === "credentials")) return true;
  if (segments.some((segment) => isDeniedEnvSegment(segment))) return true;
  if (/\.(min\.js|min\.css|pem|key)$/i.test(relPath)) return true;
  return false;
}

function isDeniedEnvSegment(segment: string): boolean {
  if (segment === ".env.example") return false;
  return segment === ".env" || segment.startsWith(".env.");
}

function generatedOutputRoot(relPath: string): string | undefined {
  const segments = relPath.split("/");
  return GENERATED_OUTPUT_DIRS.find((entry) => segments.includes(entry));
}

function suggestedProfileForGeneratedRoot(root: string): SandboxProfile {
  if (["coverage", "reports", "test-results", "junit", ".nyc_output"].includes(root)) return "test";
  if (["artifacts"].includes(root)) return "package";
  if (["logs", "temp", ".tmp"].includes(root)) return "debug";
  return "build";
}

function formatSandboxBlock(rule: SandboxRule, relPath: string, operation: SandboxOperation, activeProfile: SandboxProfile, suggestedProfile?: SandboxProfile): string {
  return [
    `Blocked by sandbox rule: ${rule}`,
    `Path: ${normalizeRel(relPath)}`,
    `Operation: ${operation}`,
    "User approval override: no",
    `Active profile: ${activeProfile}`,
    ...(suggestedProfile ? [`Suggested profile: ${suggestedProfile}`] : [])
  ].join("\n");
}

function normalizeRel(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function looksBinary(absPath: string): boolean {
  const fd = fs.openSync(absPath, "r");
  try {
    const buffer = Buffer.alloc(1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertNoSymlinkPathComponents(absPath: string, root: string, inputPath: string): void {
  const relative = path.relative(root, absPath);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) return;
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Path contains symlink denied by sandbox: ${inputPath}`);
    }
  }
}

function nearestExistingAncestor(absPath: string): string {
  let current = fs.existsSync(absPath) ? absPath : path.dirname(absPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`No existing path ancestor: ${absPath}`);
    current = parent;
  }
  return current;
}
