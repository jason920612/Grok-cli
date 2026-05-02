# Shell Usage Skill

Use shell commands only through tools.

Rules:
1. Prefer bounded foreground commands for tests, builds, lint, and inspection.
2. Use background commands only for long-running dev servers or watchers.
3. Keep output summaries compact.
4. Prefer project-local scripts and package managers.
5. Do not use shell commands to read large files; use read_file_range.
