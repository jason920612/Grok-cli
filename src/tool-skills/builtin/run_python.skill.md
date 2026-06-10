# run_python

Run a Python script in the workspace for cross-platform command execution and scripting.

## When to use
- Running checks/builds/tests (e.g. via `subprocess`).
- Inspecting the environment or computing something procedurally.
- Invoking external programs (git, npm, tsc) — call them through `subprocess.run([...])`.

## Rules
- Pass a list of args to `subprocess.run`, not a shell string, to avoid quoting/cross-platform issues.
- Do NOT edit files from Python (`open(...,'w')`, `os.remove`). Use `apply_patch` so edits are read-checked (read-before-write) and reversible (snapshot undo).
- Keep output bounded; print only what you need to interpret.
- Dangerous capabilities (deletes, installs, networking) require approval — expect a prompt.

## Examples
- Run tests: `import subprocess; subprocess.run(["npm","test"])`
- Git status: `import subprocess; print(subprocess.run(["git","status","--short"], capture_output=True, text=True).stdout)`
