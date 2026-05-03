import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePackageRoot(moduleUrl: string): string {
  let current = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    if (fs.existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(fileURLToPath(moduleUrl));
    current = parent;
  }
}
