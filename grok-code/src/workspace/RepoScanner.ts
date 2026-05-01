import fs from "node:fs";
import path from "node:path";
import { tokenEstimate } from "../context/tokenEstimate.js";

export function scanRepo(root: string): string {
  const files = ["package.json", "README.md", "tsconfig.json", "pyproject.toml", "go.mod", "Cargo.toml", "Gemfile", ".env.example"];
  const parts: string[] = [`Workspace: ${root}`];
  for (const file of files) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.size > 30_000) {
      parts.push(`${file}: present (${stat.size} bytes, not loaded)`);
      continue;
    }
    const text = fs.readFileSync(abs, "utf8");
    const brief = text.slice(0, 4000);
    parts.push(`--- ${file} ---\n${brief}`);
  }
  const summary = parts.join("\n\n");
  return tokenEstimate(summary) > 8000 ? summary.slice(0, 32_000) : summary;
}
