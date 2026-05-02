# Grok Code

`grok-code` is a production-oriented local coding agent CLI inspired by OpenAI Codex CLI and Claude Code. It runs in your terminal, observes and edits only through tools, and uses xAI Grok via the Responses API.

Default model: `grok-4.3`  
API base URL: `https://api.x.ai/v1`

## Setup

```bash
npm install
cp .env.example .env
```

Set your key:

```bash
export XAI_API_KEY="your_api_key"
```

On Windows PowerShell:

```powershell
$env:XAI_API_KEY="your_api_key"
```

Build and run:

```bash
npm run build
npm start -- "fix failing tests"
```

During development:

```bash
npm run dev -- "review the current diff"
```

## CLI Commands

```bash
grok-code
grok-code "task description"
grok-code ask "question"
grok-code edit "modify task"
grok-code review
grok-code learn-project
grok-code status
grok-code diff
grok-code resume
grok-code resume <session-id>
```

Global flags:

```bash
--model <model>
--approval <on-request|auto-local|auto-safe|auto-all|never>
--tool-choice <auto|required|none>
--max-steps <number>
--no-server-tools
--enable-web-search
--enable-x-search
```

## Interactive Mode

Run `grok-code` with no task to enter interactive mode.

- Type `/` to open the slash command menu.
- Use Up/Down arrows to choose a command.
- Press Enter to accept and run the highlighted command.
- Press Esc while editing the prompt to cancel the command menu and clear the current input.
- Press Esc while a model request is running to interrupt the current request.
- `/skills` shows skills loaded for the current interactive baseline separately from skills that are available and loaded only when triggered.
- `/approval <mode>` changes approval mode during interactive sessions.

Useful slash commands:

```txt
/help
/status
/diff
/approval <mode>
/learn-project
/context
/compact
/skills
/tools
/env
/bg
/exit
```

## Function Calling Architecture

The agent uses `client.responses.create(...)` from the `openai` npm package with:

- `baseURL: "https://api.x.ai/v1"`
- `model: "grok-4.3"` by default
- `tools`
- `tool_choice`
- `parallel_tool_calls: true`
- `previous_response_id`

The model receives local custom tool schemas. When it needs workspace data or local actions, it returns `function_call` items. `grok-code` executes all local calls from the same response, then sends:

```ts
{
  type: "function_call_output",
  call_id: item.call_id,
  output: JSON.stringify(result)
}
```

The next Responses API call includes `previous_response_id: response.id`.

Streaming support is reserved in the architecture. Function calls are treated as complete chunks; the implementation does not assume arguments stream token by token.

## Server-side Tools vs Local Tools

xAI server-side built-ins are optional:

- `--enable-web-search` adds `{ type: "web_search" }`
- `--enable-x-search` adds `{ type: "x_search" }`
- `--no-server-tools` disables server-side tools

Server-side tools are executed by xAI. Local filesystem, shell, git, patching, and background process tools are always custom local tools executed by this CLI.

## Local Custom Tools

Included tools:

- `inspect_environment`
- `check_project_tooling`
- `list_files`
- `get_file_overview`
- `read_file_range`
- `search_text`
- `search_symbols`
- `search_code`
- `find_symbol`
- `get_related_files`
- `expand_node`
- `create_skill`
- `apply_patch`
- `run_shell`
- `git_status`
- `git_diff`
- `start_background_command`
- `list_background_commands`
- `read_background_output`
- `stop_background_command`
- `stop_all_background_commands`

There is intentionally no unrestricted `read_file`. `read_file_range` enforces precise ranges and rejects broad reads for larger files.

## Tool Skill System

Each local tool has a Tool Skill markdown SOP. Tool schemas define capability; Tool Skills define how the model should use the capability safely and effectively.

The Tool Index is always loaded with short descriptions. Full Tool Skills are task scoped and capped to keep context compact.

## General Skill System

Built-in general skills include:

- context hygiene
- code navigation
- patch editing
- debugging
- test-driven fixes
- shell usage
- environment awareness
- project-local setup
- project understanding
- tree-based code navigation

Project customization is supported through:

- `GROK.md`
- `.grok-code/skills/*.md`
- `.grok-code/config.json`

Project skills cannot override core safety rules.

The `create_skill` local tool can create project-local reusable skills in `.grok-code/skills/*.md`. Use it for stable project conventions, debugging workflows, review checklists, or domain-specific rules. Do not store secrets, transient logs, or one-off task notes as skills.

Use `grok-code learn-project` to explicitly trigger the project-understanding skill. It inspects the current workspace through tools and creates or updates `GROK.md` with durable notes about project purpose, stack, structure, commands, conventions, risks, and unknowns. In interactive mode, use `/learn-project`.

### Tree-based Code Navigation

The tree-based code navigation skill guides coding tasks through a bounded search tree before editing. It starts with searches, builds branches for entrypoints, keywords, symbols, dependencies, tests, runtime errors, and documentation, then expands only high-confidence nodes. This reduces token waste by avoiding broad full-file reads and pushes the model toward `search_code`, `find_symbol`, `expand_node`, `get_related_files`, `get_file_overview`, and precise `read_file_range` calls. The current tools are lightweight path/text/symbol scanners; they can later be backed by a richer symbol index, dependency graph, or semantic search implementation.

## Context Manager and Compaction

Tool outputs are not permanently appended to a chat transcript. They go through `ContextManager`, which stores relevant summaries, file ranges, search results, patches, and environment facts with priorities and expiry.

Compaction is deterministic in this MVP and preserves:

- current task
- known facts
- relevant files and ranges
- environment and project tooling
- decisions made
- patches applied
- tests run
- background processes
- pending next steps

## Environment and Project-local Setup

New sessions inspect the environment once: OS, shell, runtimes, package managers, git branch, key tools, and optional network status.

Before tests, builds, installs, or dev servers, the agent should inspect project-local tooling and prefer lockfiles, package scripts, and local dependency runners. Global installs and shell profile changes require explicit user approval.

## Background Commands

Long-running commands use `start_background_command`. Output is stored in a bounded ring buffer. The agent can list, read, and stop only processes it started.

One-shot mode cleans up agent-started background commands before final output unless the user explicitly asked to keep them running.

## Approval Policy

Modes:

- `on-request`: default. Auto-allow workspace file edits and safe local commands; ask for riskier commands.
- `auto-local`: auto-allow operations scoped to the current workspace or local project environment; ask for global environment changes.
- `auto-safe`: run safe local checks automatically; ask for network, install, unknown commands, and global changes.
- `auto-all`: auto-allow every model-requested operation, including global or destructive commands.
- `never`: deny approval-required operations unless explicitly requested by the original task.

Global environment changes are never auto-approved except in `auto-all`.

When approval is required, the prompt is a menu:

- allow this time
- allow and remember similar requests for this session
- no, use another approach

If you deny and choose another approach, Grok Code asks for guidance and returns that guidance to the model.

## Sandbox Limitations

Local tools can only read and write inside the workspace root. The sandbox rejects `.git` internals, `node_modules`, build outputs, coverage, minified generated files, binary files, and `.env` secrets unless explicitly necessary and allowed by tool policy.

## Examples

Fix failing tests:

```bash
grok-code --approval auto-safe "fix the failing unit test"
```

Review a diff:

```bash
grok-code review
```

Show a git-style diff in interactive mode:

```txt
/diff
```

Start and stop a dev server:

```bash
grok-code "start the local dev server, inspect the startup error, then stop it"
```

Inspect environment:

```bash
grok-code ask "what local runtimes and package managers are available?"
```

Avoid global install:

```bash
grok-code "run the formatter using project-local tooling; do not install anything globally"
```

## Roadmap

- Native streaming UI.
- Rich session browser.
- Stronger language-aware symbol extraction.
- Model-assisted context compression.
- More granular patch previews and approval scopes.
- Package-time copying or embedding of markdown skill assets for global installs.
