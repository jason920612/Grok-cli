import ignore from "ignore";
import type { SandboxProfile } from "../config/loadConfig.js";

export const HARD_DENY_PATTERNS = [
  ".git",
  "node_modules",
  "*.min.js",
  "*.min.css",
  ".env",
  ".env.*"
];

export const GENERATED_OUTPUT_DIRS = [
  ".generated",
  ".next",
  ".nyc_output",
  ".tmp",
  "artifacts",
  "build",
  "coverage",
  "dist",
  "generated",
  "junit",
  "logs",
  "out",
  "reports",
  "site",
  "target",
  "temp",
  "test-results",
  "tmp"
];

const PROFILE_ALLOWED_GENERATED_DIRS: Record<SandboxProfile, string[]> = {
  default: [],
  build: [".generated", ".next", "build", "dist", "generated", "out", "target", "tmp"],
  test: [".nyc_output", "coverage", "junit", "reports", "test-results", "tmp"],
  debug: [".generated", ".next", ".tmp", "build", "coverage", "dist", "logs", "out", "reports", "target", "temp", "test-results", "tmp"],
  package: ["artifacts", "build", "dist", "out", "target", "tmp"],
  docs: [".generated", "build", "dist", "generated", "out", "site", "tmp"]
};

export function generatedOutputDirsForProfile(profile: SandboxProfile): string[] {
  return PROFILE_ALLOWED_GENERATED_DIRS[profile];
}

export function createIgnoreRules(profile: SandboxProfile = "default", extra: string[] = []) {
  const allowed = new Set(generatedOutputDirsForProfile(profile));
  const generatedDenied = GENERATED_OUTPUT_DIRS.filter((entry) => !allowed.has(entry));
  return ignore().add([...HARD_DENY_PATTERNS, ...generatedDenied, ...extra]);
}
