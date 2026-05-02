# Tree-based Code Navigation Skill

Description: Use a bounded search tree to find relevant files and code before coding, debugging, reviewing, refactoring, locating logic, fixing failing tests, or adding features. This keeps codebase exploration auditable, low-token, and focused.

## When To Use

Use this skill for coding/edit/debug/review tasks, especially when the task asks to modify code, find relevant files, locate logic, understand an implementation, fix a failing test, follow a stack trace, or search the project.

## Non-negotiable Rules

- Search before reading.
- Build a small search tree from the task.
- Expand only high-confidence nodes.
- Read exact ranges, not whole files.
- Stop expanding when the edit location is clear.
- Never edit before identifying the likely owner file, relevant tests, and call path when applicable.
- Prefer symbols, imports, references, stack traces, tests, and exact keywords over broad guessing.
- Avoid reading generated files, build outputs, vendored code, lockfiles, and huge files unless explicitly required.

## Algorithm

Build a small search tree for every code task:

```txt
Root: user task
├─ Entry branch
├─ Keyword branch
├─ Symbol branch
├─ Dependency branch
├─ Test branch
├─ Runtime/Error branch
└─ Documentation branch
```

Use the tree to decide what to search, what to expand, and what to stop ignoring.

### Entry Branch

Find CLI commands, routes, handlers, public APIs, main entrypoints, stack trace locations, and config entries. Prefer concrete entrypoints over broad source scans.

### Keyword Branch

Search user-visible words first, then synonyms, implementation terms, error messages, and filename fragments. For example, for "do not read whole files", also search `read_file`, `read_file_range`, `file range`, `context`, `large file`, `token`, and `compaction`.

### Symbol Branch

Search function, class, type, interface, command name, and tool name definitions. Prefer definition matches over incidental text matches.

### Dependency Branch

From high-confidence files, expand only direct imports, exports, callers, callees, or referenced files that explain behavior. Do not chase dependency chains indefinitely.

### Test Branch

Find related tests, fixtures, snapshots, and failing test names. Before editing, know the smallest relevant test or verification command when possible.

### Runtime/Error Branch

If the task includes an error message, stack trace, or log, start here. Stack trace file and line locations outrank general keyword matches.

### Documentation Branch

Read README, GROK.md, docs, and config only when behavior or conventions are unclear. Do not use documentation as a substitute for code evidence.

## Scoring

Score candidate nodes before expanding:

```txt
+4 stack trace exact file/line
+4 symbol definition match
+3 exact keyword match in relevant source file
+3 test directly asserts the behavior
+2 file imported by or imports a high-confidence node
+2 path/name relevance
+1 documentation explains the behavior
-2 generated/build/vendor/lock/minified file
-2 very large file with weak match
-3 unrelated test/doc-only mention
```

## Expansion Policy

- Expand at most the top 3 nodes per layer.
- Simple bugfix: maximum depth 2.
- General feature/change: maximum depth 3.
- Architecture task: maximum depth 4.
- Before the first hypothesis, read at most 3 file ranges.
- Before editing, read at most 8 file ranges unless the task clearly requires more.
- Stop expanding if new node scores are clearly lower than existing candidates.

## Read Policy

Before reading any file range, know:

- Why this file should be read.
- Which exact range should be read.
- What question the read should answer.

Prefer reading:

- Symbol definition ranges.
- 40-120 lines around grep hits.
- Imports section.
- Exported API section.
- Failing test assertion block.
- Command handler or tool implementation core block.

Avoid:

- Full file reads.
- Large files from top to bottom.
- Reading many sibling files at once.
- Reading `dist`, `build`, generated, vendor, lock, minified, or coverage files.
- Reading secrets or `.env`.

## Stop Conditions

Stop searching when:

- The owning file is clear.
- The call path is understood.
- Related tests are found or no related test exists.
- The edit location is clear.
- New candidates score low.
- Further expansion only reveals implementation details.
- Current evidence is enough to safely create a patch.

## Required Behavior Before Editing

Before editing, briefly summarize:

- Search tree explored.
- Top candidate files and line ranges.
- Why those files are relevant.
- Likely edit location.
- Relevant tests or verification command.
- Remaining uncertainty, if any.

This may be compact internal planning or a short user-visible note, depending on the current interaction style.

## Tool Usage Guidance

Use tools in this order:

1. Project/file search with `search_code` or `list_files`.
2. Grep or keyword search with `search_code` or `search_text`.
3. Symbol search with `find_symbol` or `search_symbols`.
4. Related files, imports, references with `expand_node` or `get_related_files`.
5. `read_file_range`.
6. Patch/edit tool.
7. Tests, typecheck, and git diff.

Current MVP uses `search_code`, `find_symbol`, `expand_node`, `get_related_files`, `list_files`, `search_text`, `search_symbols`, `get_file_overview`, and `read_file_range`. Future implementations may replace the lightweight search internals with richer symbol indexes, dependency graphs, or semantic search without changing this workflow.

## Examples

### Fix a CLI option bug

Good:

1. Entry branch: search command name and option flag.
2. Symbol branch: search command handler symbol.
3. Test branch: search option name in tests.
4. Read the command handler range and failing assertion block.
5. Patch only the handler and run the targeted test.

Bad:

- Read every CLI file from top to bottom.
- Patch before finding tests or the owning handler.

### Add a tool behavior

Good:

1. Keyword branch: search exact tool name and schema phrase.
2. Symbol branch: search tool factory or registry symbol.
3. Dependency branch: inspect direct imports and registry registration.
4. Read only schema, implementation, and registry ranges.
5. Patch, then run build and git diff.

Bad:

- Read all tools and all skills because they are nearby.

## Anti-patterns

- Guessing the owner file from path names only.
- Reading full files because search returned many hits.
- Expanding all siblings in a directory.
- Treating docs as proof of runtime behavior.
- Ignoring stack trace line numbers.
- Editing without understanding the call path when the change affects shared behavior.
