# apply_patch

Apply minimal unified diff patches.

- Use only after reading the relevant target range.
- Keep patches small and related to the task.
- Do not rewrite unrelated code.
- On failure, reread the target range and try a smaller patch.
- After success, run git_diff and relevant checks.
