# Web UI v1 — browser interface for interactive mode

Decisions (agreed 2026-06-11):
- **Frontend**: single-file vanilla HTML/JS/CSS (`src/web/public/index.html`), no build step. Served statically by the backend; shipped via package.json `files` (same pattern as `src/skills/builtin`).
- **Entry**: web is the DEFAULT interactive mode. `grok-code` (no args) starts the local backend, auto-opens the default browser, and prints the URL as fallback. `--tui` keeps the terminal REPL.
- **Layout**: two columns — chat stream (left) + live activity panel (right); input bar at the bottom; header with model, mode toggles (multi-agent / always-approve), token usage.
- **TUI**: frozen — bug fixes only; new interactive features land in the web UI.

## Architecture

```
grok-code            (interactive, default)
  └─ src/web/server.ts: http.createServer on 127.0.0.1:<random port>
       ├─ GET  /?t=<token>           → index.html  (one-time token gates everything)
       ├─ GET  /api/events?t=        → SSE event stream (replay buffer on connect/reload)
       ├─ GET  /api/state?t=         → snapshot {model, workspace, modes, usage}
       └─ POST /api/message|interrupt|respond|toggle?t=
```

- **Transport**: SSE down + fetch POST up. Zero new runtime dependencies (no ws);
  EventSource auto-reconnects, and the replay buffer makes browser reloads lossless.
- **Security**: bound to 127.0.0.1 only; every request requires the random session
  token minted at startup (prevents other local processes from driving the agent).

## Event model (SSE `data:` JSON)

| type        | payload                                            | renders as            |
|-------------|----------------------------------------------------|-----------------------|
| `chat`      | {role, text}                                       | chat bubble (md)      |
| `activity`  | {agent, kind: step/tool/info/warn/verifier, message} | activity panel line |
| `request`   | {id, kind: approval/ask_user, payload}             | interactive card      |
| `request_resolved` | {id}                                        | card → resolved state |
| `task`      | {status: running/done/error/interrupted}           | input bar state       |
| `changes`   | {files: [{path,status,additions,deletions,body}]}  | expandable diff cards |
| `usage`     | {inputTokens, outputTokens, cachedInputTokens, calls} | header badge       |
| `mode`      | {agents, yes}                                      | header toggles        |

## Interactive round-trips

- **Approval**: `ApprovalPolicy` gains an injectable `prompter` (defaults to the
  terminal `promptApproval`). The web prompter registers a pending request,
  emits a `request` SSE, and awaits `POST /api/respond {id, approved, rememberSimilar, guidance}`.
  Orchestrator accepts the prompter via opts (its own ApprovalPolicy).
- **ask_user**: same pending-request mechanism, kind `ask_user`; the card renders
  option buttons + free-text field per question.
- **Interjection**: `POST /api/message` while a task runs → `Interjections.push`,
  echoed in chat as a queued note. Same one-task-at-a-time model as the REPL.
- **Interrupt**: `POST /api/interrupt` → AbortController.abort() (same signal as Esc).

## Multi-agent

`WebEventSink(label)` implements `AgentEventSink` → `activity` events tagged per
agent. The Orchestrator accepts an event-sink factory via opts (default stays
`LabeledEventSink` for the TUI/one-shot path). Orchestrator runs with
`applyToWorkingTree: true`, shared SessionUsage, interjections, web askUser and
web approval prompter — full parity with the REPL team path.

## Self-check screenshots (dev loop)

`scripts/web-screenshot.mjs`: starts the server in demo mode (pre-baked event
buffer covering chat, activity, approval card, ask_user card, expanded diff),
drives it headlessly with Playwright (devDependency), and writes PNGs to
`scripts/screenshots/`. The agent (Claude) Reads the PNGs to visually verify
layout/regressions during development; doubles as a manual regression artifact.

## Out of scope (v1)

Streaming partial model text (needs provider stream support), multi-session
tabs, remote access/auth beyond the local token, session persistence/resume.
