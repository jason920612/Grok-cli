# Project Understanding Skill

Build durable project notes by inspecting the current workspace and writing `GROK.md`.

Rules:
1. Use this only when explicitly invoked by the `learn-project` command or `/learn-project` slash command.
2. Start with environment and project tooling:
   - inspect_environment
   - check_project_tooling
3. Inspect structure before reading contents:
   - list_files for top-level and likely source/config directories
   - get_file_overview for key source files
   - read_file_range for precise metadata or code ranges
4. Prefer metadata files first:
   - README.md
   - package.json
   - tsconfig.json
   - pyproject.toml
   - go.mod
   - Cargo.toml
   - Gemfile
   - .env.example
5. Never read `.env`, secrets, generated output, node_modules, dist, build, coverage, or minified files.
6. Write concise durable notes to `GROK.md`; do not dump raw file contents.
7. Use apply_patch to create or update `GROK.md`.
8. After patching, use git_diff to verify the note update.

GROK.md should include:
- Project purpose
- Tech stack and package manager
- Important directories and entrypoints
- Common commands for install, build, test, lint, dev server, and typecheck when known
- Local setup notes and environment assumptions
- Coding conventions discovered from the repository
- Known risks, unknowns, or follow-up questions

Avoid:
- Broad full-file reads.
- Guessing project purpose without evidence.
- Storing secrets or transient command logs.
- Turning GROK.md into a changelog or task transcript.
