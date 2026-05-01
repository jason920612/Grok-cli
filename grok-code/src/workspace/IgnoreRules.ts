import ignore from "ignore";

export const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "*.min.js",
  "*.min.css",
  ".env",
  ".env.*"
];

export function createIgnoreRules(extra: string[] = []) {
  return ignore().add([...DEFAULT_IGNORES, ...extra]);
}
