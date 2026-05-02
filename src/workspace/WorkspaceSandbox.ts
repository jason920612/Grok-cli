import fs from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORES } from "./IgnoreRules.js";

export class WorkspaceSandbox {
  readonly root: string;

  constructor(root: string) {
    this.root = fs.realpathSync(root);
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
    if (isDeniedPath(rel)) throw new Error(`Path is denied by sandbox: ${rel}`);
    const realAbs = fs.realpathSync(abs);
    if (!isInside(realAbs, this.root)) throw new Error(`Path escapes workspace: ${inputPath}`);
    const realRel = this.relative(realAbs);
    if (isDeniedPath(realRel)) throw new Error(`Path is denied by sandbox: ${realRel}`);
    const stat = fs.statSync(realAbs);
    if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
    if (looksBinary(realAbs)) throw new Error(`Binary file rejected: ${rel}`);
    return realAbs;
  }

  assertWritablePatchPath(inputPath: string): string {
    const abs = this.resolveWritablePath(inputPath);
    const rel = this.relative(abs);
    if (isDeniedPath(rel)) throw new Error(`Patch target denied by sandbox: ${rel}`);
    assertNoSymlinkPathComponents(abs, this.root, inputPath);
    return abs;
  }

  private resolveWritablePath(inputPath: string): string {
    if (inputPath.includes("\0")) throw new Error("Invalid path.");
    const resolved = path.resolve(this.root, inputPath);
    const realParent = fs.realpathSync(nearestExistingAncestor(resolved));
    if (!isInside(realParent, this.root)) throw new Error(`Path escapes workspace: ${inputPath}`);
    return resolved;
  }
}

export function isDeniedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => isDeniedEnvSegment(segment))) return true;
  if (/\.(min\.js|min\.css)$/.test(normalized)) return true;
  return DEFAULT_IGNORES.filter((pattern) => !pattern.includes("*")).some((pattern) => normalized === pattern || normalized.startsWith(`${pattern}/`));
}

function isDeniedEnvSegment(segment: string): boolean {
  if (segment === ".env.example") return false;
  return segment === ".env" || segment.startsWith(".env.");
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
