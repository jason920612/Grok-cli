import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Agent } from "../agent/Agent.js";
import type { AgentEvent, AgentEventSink } from "../agent/AgentEvents.js";
import { Interjections } from "../agent/Interjections.js";
import { Orchestrator } from "../agents/Orchestrator.js";
import type { ApprovalPrompter } from "../approval/ApprovalPolicy.js";
import type { ApprovalMode } from "../config/loadConfig.js";
import { collectWorkingTreeDiff, type FileDiff } from "../ui/diffBrowser.js";
import { formatSessionStatus } from "../ui/terminal.js";
import { formatWorkspaceTrustStatus } from "../ui/workspaceTrust.js";
import { formatContext } from "../ui/formatters.js";
import { visibleSlashCommands } from "../ui/slashCommands.js";
import { PROJECT_UNDERSTANDING_TASK } from "../agent/projectUnderstandingTask.js";
import { WorkspaceTrustStore, describeTrustEntry, type WorkspaceTrustScope } from "../workspace/WorkspaceTrustStore.js";

const APPROVAL_MODES: ApprovalMode[] = ["on-request", "auto-local", "auto-safe", "auto-all", "never"];

/**
 * Web UI backend (web-ui-v1.md).
 *
 * A local HTTP server bound to 127.0.0.1 with a random session token. Events
 * stream to the browser over SSE (with a replay buffer so reloads are
 * lossless); user actions come back as JSON POSTs. Approval prompts and
 * ask_user questions become pending requests the browser answers with buttons.
 * Zero new runtime dependencies: SSE + fetch instead of WebSocket.
 */

export type WebEvent =
  | { type: "chat"; role: "user" | "assistant" | "system"; text: string }
  | { type: "activity"; agent: string; kind: string; message: string }
  | { type: "request"; id: string; kind: "approval" | "ask_user"; payload: unknown }
  | { type: "request_resolved"; id: string }
  | { type: "task"; status: "running" | "done" | "error" | "interrupted"; message?: string }
  | { type: "changes"; files: Array<{ path: string; status: string; additions: number; deletions: number; body: string }> }
  | { type: "usage"; line: string }
  | { type: "mode"; agents: boolean; yes: boolean }
  | { type: "output"; title: string; text: string }
  | { type: "state"; model: string; workspace: string; approval: string; agents: boolean; yes: boolean }
  | { type: "trust"; workspace: string; current: string };

export type WebServerOptions = {
  agent: Agent;
  multiAgentDefault?: boolean;
  /** 0 (default) lets the OS pick a free port. */
  port?: number;
  openBrowser?: boolean;
  /** Pre-baked events for screenshot/demo runs — no live agent calls. */
  demoEvents?: WebEvent[];
  /** Build a fresh agent for a different workspace (the /cd command). */
  switchWorkspace?: (workspace: string) => Promise<Agent>;
  /** Build a fresh agent on the same workspace with a different model (the /model command). */
  switchModel?: (model: string) => Promise<Agent>;
};

export type WebServer = {
  url: string;
  port: number;
  close(): Promise<void>;
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

class WebEventSink implements AgentEventSink {
  constructor(private readonly label: string, private readonly emitWeb: (ev: WebEvent) => void) {}
  emit(event: AgentEvent): void {
    this.emitWeb({ type: "activity", agent: this.label, kind: event.type, message: stripAnsi(event.message) });
  }
}

export async function startWebServer(opts: WebServerOptions): Promise<WebServer> {
  let agent = opts.agent;
  const token = randomUUID().replace(/-/g, "");
  const buffer: WebEvent[] = [...(opts.demoEvents ?? [])];
  const clients = new Set<http.ServerResponse>();
  const pending = new Map<string, (body: any) => void>();

  let running = false;
  let controller: AbortController | null = null;
  let interjections: Interjections | null = null;
  let useAgents = opts.multiAgentDefault ?? true;
  let modeBeforeAuto: ApprovalMode = agent.approval.mode === "auto-all" ? "on-request" : agent.approval.mode;

  const emit = (ev: WebEvent): void => {
    buffer.push(ev);
    if (buffer.length > 2000) buffer.splice(0, buffer.length - 2000);
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(data);
  };

  const webPrompter: ApprovalPrompter = (command, reason, risk, details) =>
    new Promise((resolve) => {
      const id = randomUUID().slice(0, 8);
      pending.set(id, (body) => {
        resolve({
          approved: Boolean(body?.approved),
          rememberSimilar: Boolean(body?.rememberSimilar),
          ...(body?.approved ? {} : { guidance: typeof body?.guidance === "string" && body.guidance ? body.guidance : "User denied the request from the web UI." })
        } as any);
      });
      emit({ type: "request", id, kind: "approval", payload: { command, reason, risk, ...details } });
    });

  const webAskUser: NonNullable<Agent["askUser"]> = (questions) =>
    new Promise((resolve) => {
      const id = randomUUID().slice(0, 8);
      pending.set(id, (body) => {
        const answers = Array.isArray(body?.answers) ? body.answers : [];
        resolve(questions.map((q, i) => ({ question: q.question, answer: String(answers[i]?.answer ?? answers[i] ?? "") })));
      });
      emit({ type: "request", id, kind: "ask_user", payload: { questions } });
    });

  const wire = (a: Agent): void => {
    a.askUser = webAskUser;
    a.approval.prompter = webPrompter;
  };
  wire(agent);

  const stateEvent = (): WebEvent => ({
    type: "state",
    model: agent.config.model,
    workspace: agent.config.workspaceRoot,
    approval: agent.approval.mode,
    agents: useAgents,
    yes: agent.approval.mode === "auto-all"
  });

  const out = (title: string, text: string): void => emit({ type: "output", title, text });

  const diffFingerprint = (f: FileDiff) => `${f.status}:${f.additions}:${f.deletions}`;

  const runTask = async (text: string): Promise<void> => {
    if (opts.demoEvents) return; // demo mode: display only
    if (running) {
      interjections?.push(text);
      emit({ type: "chat", role: "system", text: `💬 queued for the agent: ${text}` });
      return;
    }
    running = true;
    controller = new AbortController();
    interjections = new Interjections();
    emit({ type: "chat", role: "user", text });
    emit({ type: "task", status: "running" });
    const baseline = new Map(collectWorkingTreeDiff(agent.config.workspaceRoot).map((f) => [f.path, diffFingerprint(f)]));
    try {
      let response: string;
      if (useAgents) {
        const orchestrator = new Orchestrator(agent.provider, agent.config, randomUUID().slice(0, 8), text, {
          applyToWorkingTree: true,
          usage: agent.usage,
          interjections,
          askUser: webAskUser,
          approvalPrompter: webPrompter,
          eventSinkFactory: (label, isWorker) => new WebEventSink(isWorker ? `worker:${label}` : label, emit)
        });
        const result = await orchestrator.run(text, controller.signal);
        response = result.report;
      } else {
        response = await agent.run(text, false, controller.signal, interjections, new WebEventSink("grok", emit));
      }
      emit({ type: "chat", role: "assistant", text: stripAnsi(response) });
      const changed = collectWorkingTreeDiff(agent.config.workspaceRoot).filter((f) => baseline.get(f.path) !== diffFingerprint(f));
      if (changed.length > 0) {
        emit({ type: "changes", files: changed.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, body: f.body })) });
      }
      const lap = agent.usage.lap();
      if (lap.calls > 0) emit({ type: "usage", line: formatLap(lap) });
      emit({ type: "task", status: "done" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/interrupt|abort/i.test(message)) emit({ type: "task", status: "interrupted" });
      else emit({ type: "task", status: "error", message: stripAnsi(message) });
    } finally {
      running = false;
      controller = null;
      interjections = null;
      // Any unanswered prompts belong to the finished task; deny them so nothing dangles.
      for (const [id, resolve] of pending) {
        resolve({ approved: false, answers: [] });
        emit({ type: "request_resolved", id });
      }
      pending.clear();
    }
  };

  // Slash commands → GUI/web equivalents of the old TUI commands.
  const handleCommand = async (raw: string): Promise<void> => {
    const [name, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(" ");
    const ctx = () => agent.toolContext();
    emit({ type: "chat", role: "user", text: raw });
    switch (name) {
      case "/help":
        out("Commands", visibleSlashCommands().map((c) => `${c.usage.padEnd(22)} ${c.description}`).join("\n"));
        break;
      case "/status":
        out("Status", [
          formatSessionStatus(agent.config),
          stripAnsi(formatWorkspaceTrustStatus(agent.config.workspaceRoot)),
          agent.usage.hasData ? agent.usage.format() : "tokens this session: none yet"
        ].join("\n"));
        break;
      case "/cd":
      case "/workspace":
      case "/change-dir": {
        if (!opts.switchWorkspace) { out("Workspace", "Workspace switching is unavailable in this session."); break; }
        if (!arg) { out("Workspace", "Usage: /cd <path>  (or use the workspace button in the header)"); break; }
        try {
          await agent.background.stopAll("workspace switch cleanup");
          agent = await opts.switchWorkspace(arg);
          wire(agent);
          out("Workspace", `Switched to ${agent.config.workspaceRoot}`);
          emit(stateEvent());
        } catch (e) {
          out("Workspace", `Could not switch: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case "/approval": {
        if (arg && APPROVAL_MODES.includes(arg as ApprovalMode)) {
          agent.approval.setMode(arg as ApprovalMode);
          agent.config.approval = agent.approval.mode;
          out("Approval", `Approval mode set to ${arg}.`);
          emit(stateEvent());
          emit({ type: "mode", agents: useAgents, yes: agent.approval.mode === "auto-all" });
        } else {
          out("Approval", `Current: ${agent.approval.mode}\nModes: ${APPROVAL_MODES.join(", ")}\nUsage: /approval <mode>  (or use the header dropdown)`);
        }
        break;
      }
      case "/trust": {
        const store = new WorkspaceTrustStore();
        const entry = store.getTrustFor(agent.config.workspaceRoot);
        emit({ type: "trust", workspace: agent.config.workspaceRoot, current: entry ? describeTrustEntry(entry) : "Not trusted" });
        break;
      }
      case "/git-status":
        out("git status", asText(await agent.tools.execute("git_status", {}, ctx())));
        break;
      case "/diff": {
        const files = collectWorkingTreeDiff(agent.config.workspaceRoot);
        if (files.length === 0) out("Diff", "No changes in the working tree.");
        else emit({ type: "changes", files: files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, body: f.body })) });
        break;
      }
      case "/context":
        out("Context", formatContext(agent.context.list()) || "(empty)");
        break;
      case "/compact":
      case "/clear":
        agent.context.compactContext("web session");
        out("Context", "Context compacted — stale items summarized, pinned items kept.");
        break;
      case "/skills":
        out("Skills", formatSkillsList());
        break;
      case "/tools":
        out("Tools", agent.toolSkills.toolIndex());
        break;
      case "/env":
        out("Environment", asText(await agent.tools.execute("inspect_environment", { includeVersions: true }, ctx())));
        break;
      case "/bg":
        out("Background commands", asText(agent.background.list()));
        break;
      case "/bg-stop":
        out("Background", asText(await agent.tools.execute("stop_background_command", { id: rest[0], reason: "web command" }, ctx())));
        break;
      case "/bg-stop-all":
        out("Background", asText(await agent.tools.execute("stop_all_background_commands", { reason: "web command" }, ctx())));
        break;
      case "/drop":
        out("Context", agent.context.drop(rest[0] ?? "") ? "dropped" : "not dropped");
        break;
      case "/learn-project":
        void runTask(PROJECT_UNDERSTANDING_TASK);
        break;
      case "/model": {
        if (!opts.switchModel) { out("Model", `Current: ${agent.config.model}\nModel switching is unavailable in this session.`); break; }
        if (!arg) { out("Model", `Current: ${agent.config.model}\nUsage: /model <name>  (or click the model name in the header)`); break; }
        try {
          await agent.background.stopAll("model switch cleanup");
          agent = await opts.switchModel(arg);
          wire(agent);
          out("Model", `Model switched to ${agent.config.model}.`);
          emit(stateEvent());
        } catch (e) {
          out("Model", `Could not switch model: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      default:
        out("Unknown command", `${name} — type /help for the list.`);
    }
  };

  const formatSkillsList = (): string => {
    const active = agent.skillLoader.select("web session");
    const ids = new Set(active.map((s) => s.id));
    const available = agent.skillLoader.loadAll().filter((s) => !ids.has(s.id));
    const fmt = (xs: typeof active) => xs.map((s) => `- ${s.id}: ${s.description}`).join("\n") || "- none";
    return `Loaded now:\n${fmt(active)}\n\nAvailable when triggered:\n${fmt(available)}`;
  };

  const processInput = (text: string): void => {
    if (text.startsWith("/")) void handleCommand(text);
    else void runTask(text);
  };

  const htmlPath = resolvePublicFile("index.html");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const authed = url.searchParams.get("t") === token || req.headers["x-grok-token"] === token;
    if (!authed) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden: missing or invalid session token.");
      return;
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(htmlPath, "utf8"));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      for (const ev of buffer) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => res.write(":hb\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          model: agent.config.model,
          workspace: agent.config.workspaceRoot,
          agents: useAgents,
          yes: agent.approval.mode === "auto-all",
          approval: agent.approval.mode,
          approvalModes: APPROVAL_MODES,
          canSwitchWorkspace: Boolean(opts.switchWorkspace),
          canSwitchModel: Boolean(opts.switchModel),
          commands: visibleSlashCommands().map((c) => ({ name: c.name, usage: c.usage, description: c.description })),
          running,
          usage: agent.usage.hasData ? agent.usage.format() : ""
        })
      );
      return;
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      if (url.pathname === "/api/message") {
        const text = String(body?.text ?? "").trim();
        if (text) processInput(text);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, queued: running }));
        return;
      }
      if (url.pathname === "/api/interrupt") {
        controller?.abort();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/api/trust") {
        const action = String(body?.action ?? "");
        const store = new WorkspaceTrustStore();
        const ws2 = agent.config.workspaceRoot;
        if (action === "clear") store.clearTrust(ws2);
        else if (action === "exact" || action === "descendants") store.setTrust(ws2, action as WorkspaceTrustScope);
        // Rebuild the agent so the sandbox re-reads the new trust state.
        if (opts.switchWorkspace) {
          try {
            agent = await opts.switchWorkspace(ws2);
            wire(agent);
          } catch {
            /* keep current agent if rebuild fails */
          }
        } else {
          agent.config.workspaceTrusted = Boolean(store.getTrustFor(ws2));
        }
        const entry = store.getTrustFor(ws2);
        out("Workspace trust", entry ? `Updated: ${describeTrustEntry(entry)}` : "Trust cleared.");
        emit(stateEvent());
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/api/respond") {
        const id = String(body?.id ?? "");
        const resolve = pending.get(id);
        if (resolve) {
          pending.delete(id);
          resolve(body);
          emit({ type: "request_resolved", id });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: Boolean(resolve) }));
        return;
      }
      if (url.pathname === "/api/toggle") {
        if (typeof body?.agents === "boolean") useAgents = body.agents;
        if (typeof body?.yes === "boolean") {
          if (body.yes && agent.approval.mode !== "auto-all") modeBeforeAuto = agent.approval.mode;
          agent.approval.setMode(body.yes ? "auto-all" : modeBeforeAuto);
          agent.config.approval = agent.approval.mode;
        }
        emit({ type: "mode", agents: useAgents, yes: agent.approval.mode === "auto-all" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  if (opts.openBrowser) openInBrowser(url);

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of clients) res.end();
        clients.clear();
        server.close(() => resolve());
      })
  };
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatLap(lap: { inputTokens: number; outputTokens: number; cachedInputTokens: number; calls: number }): string {
  const hit = lap.inputTokens > 0 ? Math.round((lap.cachedInputTokens / lap.inputTokens) * 100) : 0;
  return `in ${lap.inputTokens.toLocaleString()} (cached ${lap.cachedInputTokens.toLocaleString()}, ${hit}% hit) · out ${lap.outputTokens.toLocaleString()} · ${lap.calls} calls`;
}

function resolvePublicFile(name: string): string {
  // dist/web/server.js → ../../src/web/public (src assets ship in the npm package,
  // same pattern as src/skills/builtin).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, "public", name), path.join(here, "..", "..", "src", "web", "public", name)];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Web UI asset not found: ${name} (looked in ${candidates.join(", ")})`);
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    /* best effort — the URL is printed as fallback */
  });
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}
