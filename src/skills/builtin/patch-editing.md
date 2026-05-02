# Patch Editing Skill

Rules:
1. Use apply_patch for all file modifications.
2. Make the smallest correct change.
3. Do not rewrite unrelated code.
4. Before patching, inspect target function, imports, nearby types, relevant tests.
5. After patching, run the smallest relevant test, then broader tests if appropriate.
6. Final answer must include files changed, tests run, remaining risks.
