# Git Commit and Push Skill

Use this skill when the user asks to write a commit, create commits, commit changes, push changes, or commit and push.

## Rules

1. Do not stop after describing a plan.
2. Use tools to inspect, commit, push, and verify.
3. Never include `.env` or secrets in commits.
4. Inspect git status before staging.
5. Inspect relevant diff before writing the commit message.
6. Stage only intended files.
7. Use a clear commit message that describes the actual change.
8. Push only after commit succeeds and the user asked to push.
9. Verify with git status after commit/push.

## Standard Workflow

1. Call `git_status`.
2. Call `git_diff`.
3. Confirm ignored secrets are not tracked when relevant, especially `.env`.
4. Use `run_python` for targeted `git add`, e.g. `subprocess.run(["git","add","path"])`.
5. Use `run_python` for commit: `subprocess.run(["git","commit","-m","..."])`.
6. If the user requested push, use `run_python`: `subprocess.run(["git","push","origin","<branch>"])` or the current branch's upstream push.
7. Call `git_status` again.
8. Final answer must include commit hash/message, pushed branch, checks run, and any files intentionally not committed.

## Commit Message Guidance

- Use an imperative summary.
- Mention the core behavior changed.
- Add a body when there are multiple related changes.
- Do not use vague messages like `update` or `fix`.

## Anti-patterns

- Saying "I will run git diff" without actually calling tools.
- Running `git add .` without checking ignored secrets and intended files.
- Claiming a commit exists without verifying.
- Pushing when the user only asked to commit.
