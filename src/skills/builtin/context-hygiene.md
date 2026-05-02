# Context Hygiene Skill

Keep context compact and relevant.

Rules:
1. Do not read entire files unless:
   - the file is under 150 lines, or
   - the user explicitly asks for the whole file, or
   - a full-file refactor truly requires it.
2. Prefer this workflow:
   - list_files
   - search_text or search_symbols
   - get_file_overview
   - read_file_range
3. Start with 80-120 lines around the target.
4. Expand only if necessary.
5. Avoid duplicate reads of the same range.
6. For long outputs, keep only errors, stack traces, changed file list, relevant commands, and summaries.
7. Never keep large generated content in context:
   - dist
   - build
   - coverage
   - lockfiles unless dependency issue
   - minified files
   - snapshots unless directly relevant
8. If context grows too large:
   - summarize current findings
   - preserve decisions and file references
   - discard raw logs and old file ranges
