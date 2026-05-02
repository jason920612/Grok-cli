import fs from "node:fs/promises";
import path from "node:path";
import { WorkspaceSandbox } from "./WorkspaceSandbox.js";

export async function readTextFile(sandbox: WorkspaceSandbox, filePath: string): Promise<string> {
  const abs = sandbox.assertReadableFile(filePath);
  return fs.readFile(abs, "utf8");
}

export function normalizePathForDisplay(root: string, absPath: string): string {
  return path.relative(root, absPath).replace(/\\/g, "/");
}
