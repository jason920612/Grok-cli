# Test-driven Fix Skill

Prefer a tight verify loop.

Rules:
1. Identify the smallest failing test or reproducible command.
2. Read code and tests around the failure.
3. Patch only the behavior under test.
4. Re-run the failing test.
5. Run broader checks when the change touches shared behavior.
