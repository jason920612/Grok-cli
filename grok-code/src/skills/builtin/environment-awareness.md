# Environment Awareness Skill

Do not assume the development environment.

Rules:
1. Before running project commands, confirm OS, shell, package manager, runtimes, relevant tools, and network availability when needed.
2. Prefer project evidence:
   - pnpm-lock.yaml means prefer pnpm
   - yarn.lock means prefer yarn
   - package-lock.json means prefer npm
   - bun.lockb or bun.lock means prefer bun
3. If a command fails with command not found:
   - inspect environment
   - find project scripts
   - choose fallback
4. Before network-dependent commands:
   - check network availability
   - explain why network is needed
   - request approval if required
