# inspect_environment

Inspect OS, shell, runtimes, package managers, key tools, network status, and workspace metadata.

- Do not assume OS, shell, package manager, runtime, or network.
- Run before install/build/test/dev commands.
- Prefer lockfiles to infer package manager.
- Do not install global tools just because a global command is missing.
- First inspect project scripts, local dependencies, lockfiles, and tool version files.
- If network is unavailable, do not attempt install, curl, wget, or git clone.
