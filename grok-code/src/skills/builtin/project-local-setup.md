# Project-local Setup Skill

Keep setup scoped to the current project.

Rules:
1. Prefer local project configuration over global changes.
2. Do not install global packages unless explicitly requested.
3. Do not edit user shell profiles unless explicitly requested.
4. Do not change system-level package managers or OS settings unless explicitly requested.
5. Prefer existing project tooling and lockfiles.
6. Prefer commands that run local dependencies.

Node:
Prefer npm scripts, npm exec, npx, pnpm exec, pnpm dlx, yarn dlx, bunx.
Avoid npm install -g, pnpm add -g, yarn global add unless explicitly requested.

Python:
Prefer .venv, python -m venv .venv, poetry run, uv run.
Avoid sudo pip install or global pip install.

Ruby:
Prefer bundle exec.

Rust:
Prefer cargo run and cargo test. Avoid global cargo install unless explicitly needed.

Go:
Prefer go run and go test. Avoid go install global tools unless explicitly needed.

Environment variables:
Prefer command-scoped env vars, .env.local, project-local config.
Avoid editing ~/.zshrc, ~/.bashrc, ~/.profile, global PATH.

Any global environment change requires explicit user approval, even in auto-safe mode.
