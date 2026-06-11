# apply_patch

Apply file changes using the context-located apply_patch envelope (NOT unified diff — no line numbers).

## Format
```
*** Begin Patch
*** Update File: src/foo.ts
@@ optional locator (e.g. a function/class signature line)
 unchanged context line
-removed line
+added line
 unchanged context line
*** Add File: src/new.ts
+first line
+second line
*** Delete File: src/old.ts
*** End Patch
```

## Line prefixes inside a hunk
- ` ` (space) = unchanged context line, copied as-is to locate the hunk.
- `-` = line to remove (must match the file).
- `+` = line to add.

## Rules
- Read the exact lines you are changing first (read-before-write is enforced).
- Copy context and removed lines verbatim from what you read (indentation matters; minor whitespace drift is tolerated).
- Include 1–3 unchanged context lines around your change so the hunk locates unambiguously. If a change site is repeated, add an `@@ <header>` line naming the enclosing function/section.
- Keep patches minimal and on-task; do not rewrite unrelated code.
- For a brand-new file use `*** Add File: <path>` followed by the file's lines, EACH prefixed with a single `+`. Do NOT add `@@`, `+++`, `---`, or repeat the filename inside an Add File body. To remove a file use `*** Delete File: <path>`.
- After success, run git_diff and the smallest relevant checks.

## On failure
- "have not been read": read the target lines with read_file_range, then retry.
- "Could not locate context": your context/removed lines do not match the file — re-read and copy them exactly.
