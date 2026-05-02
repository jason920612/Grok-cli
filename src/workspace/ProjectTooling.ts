import fs from "node:fs";
import path from "node:path";

export type ProjectToolingSummary = {
  lockfiles: string[];
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  packageScripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  python: string[];
  go: boolean;
  rust: boolean;
  ruby: boolean;
  recommendedCommand?: string;
  globalSetupNecessary: boolean;
};

export function inspectProjectTooling(root: string, purpose: string): ProjectToolingSummary {
  const lockfiles = ["pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lockb", "bun.lock"]
    .filter((file) => fs.existsSync(path.join(root, file)));
  const packageManager = lockfiles.includes("pnpm-lock.yaml")
    ? "pnpm"
    : lockfiles.includes("yarn.lock")
      ? "yarn"
      : lockfiles.some((file) => file.startsWith("bun."))
        ? "bun"
        : fs.existsSync(path.join(root, "package.json"))
          ? "npm"
          : undefined;
  const pkg = readJson(path.join(root, "package.json"));
  const packageScripts = (pkg?.scripts ?? {}) as Record<string, string>;
  const dependencies = Object.keys((pkg?.dependencies ?? {}) as Record<string, string>);
  const devDependencies = Object.keys((pkg?.devDependencies ?? {}) as Record<string, string>);
  const python = ["pyproject.toml", "requirements.txt", "uv.lock", "poetry.lock"].filter((file) => fs.existsSync(path.join(root, file)));
  const go = fs.existsSync(path.join(root, "go.mod"));
  const rust = fs.existsSync(path.join(root, "Cargo.toml"));
  const ruby = fs.existsSync(path.join(root, "Gemfile"));
  return {
    lockfiles,
    packageManager,
    packageScripts,
    dependencies,
    devDependencies,
    python,
    go,
    rust,
    ruby,
    recommendedCommand: recommend(purpose, packageManager, packageScripts, { go, rust, ruby, python }),
    globalSetupNecessary: false
  };
}

function recommend(
  purpose: string,
  pm: ProjectToolingSummary["packageManager"],
  scripts: Record<string, string>,
  stacks: { go: boolean; rust: boolean; ruby: boolean; python: string[] }
): string | undefined {
  const lower = purpose.toLowerCase();
  const script = Object.keys(scripts).find((name) => lower.includes(name) || name.includes(lower));
  if (script && pm) return `${pm} run ${script}`;
  if (lower.includes("test")) {
    if (scripts.test && pm) return `${pm} test`;
    if (stacks.rust) return "cargo test";
    if (stacks.go) return "go test ./...";
    if (stacks.ruby) return "bundle exec rake test";
    if (stacks.python.length > 0) return "python -m pytest";
  }
  if (lower.includes("build") && scripts.build && pm) return `${pm} run build`;
  if (lower.includes("lint") && scripts.lint && pm) return `${pm} run lint`;
  if (lower.includes("type") && scripts.typecheck && pm) return `${pm} run typecheck`;
  return undefined;
}

function readJson(file: string): any | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
