export const PROJECT_UNDERSTANDING_TASK = `<Use Skill: project-understanding>

Inspect the current workspace as a new project and write durable project notes to GROK.md.

Required workflow:
1. Inspect environment and project tooling if not already known.
2. List top-level files and important directories without reading generated or ignored output.
3. Read only concise metadata and relevant source ranges needed to understand purpose, architecture, commands, and conventions.
4. Do not read secrets such as .env.
5. Create or update GROK.md with clear notes for future Grok Code sessions.

GROK.md must include:
- Project purpose
- Tech stack and package manager
- Important directories and entrypoints
- Common commands for install, build, test, lint, dev server, and typecheck when known
- Local setup notes and environment assumptions
- Coding conventions discovered from the repository
- Current known risks, unknowns, or follow-up questions

Use apply_patch for the GROK.md change. After patching, run git_diff.`;
