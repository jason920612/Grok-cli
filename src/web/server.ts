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
import { ConversationStore, type SavedConversation } from "./ConversationStore.js";
import { formatSessionStatus } from "../ui/terminal.js";
import { formatWorkspaceTrustStatus } from "../ui/workspaceTrust.js";
import { formatContext } from "../ui/formatters.js";
import { visibleSlashCommands } from "../ui/slashCommands.js";
import { PROJECT_UNDERSTANDING_TASK } from "../agent/projectUnderstandingTask.js";
import { WorkspaceTrustStore, describeTrustEntry, type WorkspaceTrustScope } from "../workspace/WorkspaceTrustStore.js";

const APPROVAL_MODES: ApprovalMode[] = ["on-request", "auto-local", "auto-safe", "auto-all", "never"];

/**
 * Web UI backend (web-ui-v1.md) with multi-conversation support.
 *
 * Each conversation is a {@link WebSession} with a unique id, its own agent,
 * event buffer, pending requests, and run state — so the UI can run several
 * threads, switch between them, and the backend can dump any thread's full live
 * state for debugging (GET /api/debug?session=<id>). A local HTTP server bound
 * to 127.0.0.1 with a random token streams each session's events over SSE and
 * takes actions via JSON POSTs (every endpoint is scoped by ?session=<id>).
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
  | { type: "trust"; workspace: string; current: string }
  | { type: "plan"; agent: string; steps: Array<{ step: string; status: string }> }
  | { type: "viewed"; agent: string; path: string }
  | { type: "agent_usage"; agent: string; line: string; inputTokens: number; outputTokens: number; cachedInputTokens: number; calls: number };

export type WebServerOptions = {
  agent: Agent;
  multiAgentDefault?: boolean;
  /** 0 (default) lets the OS pick a free port. */
  port?: number;
  openBrowser?: boolean;
  /** Pre-baked events for screenshot/demo runs — no live agent calls. */
  demoEvents?: WebEvent[];
  /** Build a fresh agent for a new conversation on the current workspace. */
  createAgent?: () => Promise<Agent>;
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

type SessionDeps = {
  switchWorkspace?: (workspace: string) => Promise<Agent>;
  switchModel?: (model: string) => Promise<Agent>;
  demoMode: boolean;
  multiAgentDefault: boolean;
};

type PendingRequest = { resolve: (body: any) => void; kind: "approval" | "ask_user"; summary: string; createdAt: number };

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

class WebEventSink implements AgentEventSink {
  constructor(private readonly label: string, private readonly emitWeb: (ev: WebEvent) => void) {}
  emit(event: AgentEvent): void {
    if (event.type === "plan") {
      this.emitWeb({ type: "plan", agent: this.label, steps: event.steps });
      return;
    }
    if (event.type === "file_viewed") {
      this.emitWeb({ type: "viewed", agent: this.label, path: event.path });
      return;
    }
    if (event.type === "usage") {
      this.emitWeb({
        type: "agent_usage",
        agent: this.label,
        line: stripAnsi(event.message),
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedInputTokens: event.cachedInputTokens,
        calls: event.calls
      });
      return;
    }
    this.emitWeb({ type: "activity", agent: this.label, kind: event.type, message: stripAnsi(event.message) });
  }
}

/** One conversation thread: its own agent, event buffer, pending requests, run state. */
class WebSession {
  title = "New conversation";
  private seq = 0;
  readonly buffer: Array<{ seq: number; ev: WebEvent }> = [];
  readonly clients = new Set<http.ServerResponse>();
  readonly pending = new Map<string, PendingRequest>();
  running = false;
  private controller: AbortController | null = null;
  private interjections: Interjections | null = null;
  useAgents: boolean;
  private modeBeforeAuto: ApprovalMode;
  createdAt = Date.now();
  lastActivityAt = Date.now();
  messageCount = 0;
  private store?: ConversationStore;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    public agent: Agent,
    private readonly deps: SessionDeps,
    opts: { demoEvents?: WebEvent[]; restore?: SavedConversation; store?: ConversationStore } = {}
  ) {
    this.useAgents = deps.multiAgentDefault;
    this.modeBeforeAuto = agent.approval.mode === "auto-all" ? "on-request" : agent.approval.mode;
    this.store = opts.store;
    if (opts.restore) {
      // Seed this live session from a persisted conversation so its full history
      // replays to clients on connect, and new events continue its numbering.
      const r = opts.restore;
      this.title = r.title;
      this.createdAt = r.createdAt;
      this.lastActivityAt = r.lastActivityAt;
      this.messageCount = r.messageCount;
      this.useAgents = r.useAgents;
      this.seq = r.seq;
      for (const item of r.buffer) this.buffer.push(item);
    }
    for (const ev of opts.demoEvents ?? []) this.buffer.push({ seq: ++this.seq, ev });
    this.wire();
  }

  /** Snapshot for the on-disk store. */
  private toSaved(): SavedConversation {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      messageCount: this.messageCount,
      useAgents: this.useAgents,
      model: this.agent.config.model,
      workspace: this.agent.config.workspaceRoot,
      seq: this.seq,
      buffer: this.buffer
    };
  }

  /** Persist (debounced) — auto-save on every change; survives restart until deleted. */
  private schedulePersist(): void {
    if (!this.store || this.deps.demoMode) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.store?.save(this.toSaved());
    }, 800);
  }

  private wire(): void {
    this.agent.askUser = (questions) => this.webAskUser(questions);
    this.agent.approval.prompter = (command, reason, risk, details) => this.webPrompter(command, reason, risk, details);
  }

  /** Replace this session's agent (workspace/model/trust rebuild) and re-wire hooks. */
  setAgent(agent: Agent): void {
    this.agent = agent;
    this.wire();
  }

  private frame(item: { seq: number; ev: WebEvent }): string {
    return `id: ${item.seq}\ndata: ${JSON.stringify(item.ev)}\n\n`;
  }

  emit(ev: WebEvent): void {
    const item = { seq: ++this.seq, ev };
    this.buffer.push(item);
    this.schedulePersist();
    if (this.buffer.length > 4000) this.buffer.splice(0, this.buffer.length - 4000);
    const data = this.frame(item);
    for (const res of [...this.clients]) {
      try {
        if (!res.writableEnded) res.write(data);
        else this.clients.delete(res);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Attach an SSE client, replaying events it has not seen (Last-Event-ID). */
  attach(res: http.ServerResponse, lastId: number): void {
    for (const item of this.buffer) if (item.seq > lastId) res.write(this.frame(item));
    this.clients.add(res);
  }

  closeClients(): void {
    for (const res of this.clients) {
      try {
        res.destroy();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }

  interrupt(): void {
    this.controller?.abort();
  }

  private webPrompter: ApprovalPrompter = (command, reason, risk, details) =>
    new Promise((resolve) => {
      const id = randomUUID().slice(0, 8);
      this.pending.set(id, {
        kind: "approval",
        summary: `${details.operation ?? "operation"}: ${command}`,
        createdAt: Date.now(),
        resolve: (body) =>
          resolve({
            approved: Boolean(body?.approved),
            rememberSimilar: Boolean(body?.rememberSimilar),
            ...(body?.approved ? {} : { guidance: typeof body?.guidance === "string" && body.guidance ? body.guidance : "User denied the request from the web UI." })
          } as any)
      });
      this.emit({ type: "request", id, kind: "approval", payload: { command, reason, risk, ...details } });
    });

  private webAskUser: NonNullable<Agent["askUser"]> = (questions) =>
    new Promise((resolve) => {
      const id = randomUUID().slice(0, 8);
      this.pending.set(id, {
        kind: "ask_user",
        summary: questions.map((q) => q.question).join(" | ").slice(0, 120),
        createdAt: Date.now(),
        resolve: (body) => {
          const answers = Array.isArray(body?.answers) ? body.answers : [];
          resolve(questions.map((q, i) => ({ question: q.question, answer: String(answers[i]?.answer ?? answers[i] ?? "") })));
        }
      });
      this.emit({ type: "request", id, kind: "ask_user", payload: { questions } });
    });

  resolvePending(id: string, body: any): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(body);
    this.emit({ type: "request_resolved", id });
    return true;
  }

  stateEvent(): WebEvent {
    return {
      type: "state",
      model: this.agent.config.model,
      workspace: this.agent.config.workspaceRoot,
      approval: this.agent.approval.mode,
      agents: this.useAgents,
      yes: this.agent.approval.mode === "auto-all"
    };
  }

  private out(title: string, text: string): void {
    this.emit({ type: "output", title, text });
  }

  setToggles(body: any): void {
    if (typeof body?.agents === "boolean") this.useAgents = body.agents;
    if (typeof body?.yes === "boolean") {
      if (body.yes && this.agent.approval.mode !== "auto-all") this.modeBeforeAuto = this.agent.approval.mode;
      this.agent.approval.setMode(body.yes ? "auto-all" : this.modeBeforeAuto);
      this.agent.config.approval = this.agent.approval.mode;
    }
    this.emit(this.stateEvent());
  }

  processInput(text: string): void {
    this.lastActivityAt = Date.now();
    if (text.startsWith("/")) void this.handleCommand(text);
    else void this.runTask(text);
  }

  private async runTask(text: string): Promise<void> {
    if (this.deps.demoMode) return;
    if (this.running) {
      if (this.pending.size > 0) {
        this.emit({ type: "chat", role: "system", text: "⚠ The agent is waiting for your answer above — please use the buttons in the highlighted card first." });
      } else {
        this.interjections?.push(text);
        this.emit({ type: "chat", role: "system", text: `💬 queued for the agent: ${text}` });
      }
      return;
    }
    this.running = true;
    this.controller = new AbortController();
    this.interjections = new Interjections();
    this.messageCount++;
    if (this.title === "New conversation") this.title = text.slice(0, 60);
    this.emit({ type: "chat", role: "user", text });
    this.emit({ type: "task", status: "running" });
    const fp = (f: FileDiff) => `${f.status}:${f.additions}:${f.deletions}`;
    const baseline = new Map(collectWorkingTreeDiff(this.agent.config.workspaceRoot).map((f) => [f.path, fp(f)]));
    try {
      let response: string;
      if (this.useAgents) {
        const orchestrator = new Orchestrator(this.agent.provider, this.agent.config, randomUUID().slice(0, 8), text, {
          applyToWorkingTree: true,
          usage: this.agent.usage,
          interjections: this.interjections,
          askUser: this.webAskUser,
          // Share the session's live ApprovalPolicy (prompter already routed to the
          // browser in wire()) so changing the approval mode / auto-approve toggle
          // mid-run takes effect for the orchestrator and every worker.
          approval: this.agent.approval,
          eventSinkFactory: (label, isWorker) => new WebEventSink(isWorker ? `worker:${label}` : label, (ev) => this.emit(ev))
        });
        const result = await orchestrator.run(text, this.controller.signal);
        response = result.report;
      } else {
        response = await this.agent.run(text, false, this.controller.signal, this.interjections, new WebEventSink("grok", (ev) => this.emit(ev)));
      }
      this.emit({ type: "chat", role: "assistant", text: stripAnsi(response) });
      const changed = collectWorkingTreeDiff(this.agent.config.workspaceRoot).filter((f) => baseline.get(f.path) !== fp(f));
      if (changed.length > 0) {
        this.emit({ type: "changes", files: changed.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, body: f.body })) });
      }
      const lap = this.agent.usage.lap();
      if (lap.calls > 0) this.emit({ type: "usage", line: formatLap(lap) });
      this.emit({ type: "task", status: "done" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/interrupt|abort/i.test(message)) this.emit({ type: "task", status: "interrupted" });
      else this.emit({ type: "task", status: "error", message: stripAnsi(message) });
    } finally {
      this.running = false;
      this.controller = null;
      this.interjections = null;
      for (const id of [...this.pending.keys()]) this.resolvePending(id, { approved: false, answers: [] });
    }
  }

  private async handleCommand(raw: string): Promise<void> {
    const [name, ...rest] = raw.trim().split(/\s+/);
    const arg = rest.join(" ");
    const ctx = () => this.agent.toolContext();
    this.emit({ type: "chat", role: "user", text: raw });
    switch (name) {
      case "/help":
        this.out("Commands", visibleSlashCommands().map((c) => `${c.usage.padEnd(22)} ${c.description}`).join("\n"));
        break;
      case "/status":
        this.out("Status", [
          formatSessionStatus(this.agent.config),
          stripAnsi(formatWorkspaceTrustStatus(this.agent.config.workspaceRoot)),
          this.agent.usage.hasData ? this.agent.usage.format() : "tokens this session: none yet"
        ].join("\n"));
        break;
      case "/cd":
      case "/workspace":
      case "/change-dir": {
        if (!this.deps.switchWorkspace) { this.out("Workspace", "Workspace switching is unavailable in this session."); break; }
        if (!arg) { this.out("Workspace", "Usage: /cd <path>  (or use the workspace button in the header)"); break; }
        try {
          await this.agent.background.stopAll("workspace switch cleanup");
          this.agent = await this.deps.switchWorkspace(arg);
          this.wire();
          this.out("Workspace", `Switched to ${this.agent.config.workspaceRoot}`);
          this.emit(this.stateEvent());
        } catch (e) {
          this.out("Workspace", `Could not switch: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case "/approval":
        if (arg && APPROVAL_MODES.includes(arg as ApprovalMode)) {
          this.agent.approval.setMode(arg as ApprovalMode);
          this.agent.config.approval = this.agent.approval.mode;
          this.out("Approval", `Approval mode set to ${arg}.`);
          this.emit(this.stateEvent());
        } else {
          this.out("Approval", `Current: ${this.agent.approval.mode}\nModes: ${APPROVAL_MODES.join(", ")}\nUsage: /approval <mode>  (or use the header dropdown)`);
        }
        break;
      case "/trust": {
        const store = new WorkspaceTrustStore();
        const entry = store.getTrustFor(this.agent.config.workspaceRoot);
        this.emit({ type: "trust", workspace: this.agent.config.workspaceRoot, current: entry ? describeTrustEntry(entry) : "Not trusted" });
        break;
      }
      case "/git-status":
        this.out("git status", asText(await this.agent.tools.execute("git_status", {}, ctx())));
        break;
      case "/diff": {
        const files = collectWorkingTreeDiff(this.agent.config.workspaceRoot);
        if (files.length === 0) this.out("Diff", "No changes in the working tree.");
        else this.emit({ type: "changes", files: files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, body: f.body })) });
        break;
      }
      case "/context":
        this.out("Context", formatContext(this.agent.context.list()) || "(empty)");
        break;
      case "/compact":
      case "/clear":
        this.agent.context.compactContext("web session");
        this.out("Context", "Context compacted — stale items summarized, pinned items kept.");
        break;
      case "/skills":
        this.out("Skills", this.formatSkillsList());
        break;
      case "/tools":
        this.out("Tools", this.agent.toolSkills.toolIndex());
        break;
      case "/env":
        this.out("Environment", asText(await this.agent.tools.execute("inspect_environment", { includeVersions: true }, ctx())));
        break;
      case "/bg":
        this.out("Background commands", asText(this.agent.background.list()));
        break;
      case "/bg-stop":
        this.out("Background", asText(await this.agent.tools.execute("stop_background_command", { id: rest[0], reason: "web command" }, ctx())));
        break;
      case "/bg-stop-all":
        this.out("Background", asText(await this.agent.tools.execute("stop_all_background_commands", { reason: "web command" }, ctx())));
        break;
      case "/drop":
        this.out("Context", this.agent.context.drop(rest[0] ?? "") ? "dropped" : "not dropped");
        break;
      case "/learn-project":
        void this.runTask(PROJECT_UNDERSTANDING_TASK);
        break;
      case "/model":
        if (!this.deps.switchModel) { this.out("Model", `Current: ${this.agent.config.model}\nModel switching is unavailable in this session.`); break; }
        if (!arg) { this.out("Model", `Current: ${this.agent.config.model}\nUsage: /model <name>  (or click the model name in the header)`); break; }
        try {
          await this.agent.background.stopAll("model switch cleanup");
          this.agent = await this.deps.switchModel(arg);
          this.wire();
          this.out("Model", `Model switched to ${this.agent.config.model}.`);
          this.emit(this.stateEvent());
        } catch (e) {
          this.out("Model", `Could not switch model: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      default:
        this.out("Unknown command", `${name} — type /help for the list.`);
    }
  }

  private formatSkillsList(): string {
    const active = this.agent.skillLoader.select("web session");
    const ids = new Set(active.map((s) => s.id));
    const available = this.agent.skillLoader.loadAll().filter((s) => !ids.has(s.id));
    const fmt = (xs: typeof active) => xs.map((s) => `- ${s.id}: ${s.description}`).join("\n") || "- none";
    return `Loaded now:\n${fmt(active)}\n\nAvailable when triggered:\n${fmt(available)}`;
  }

  /** Compact summary for the session list. */
  summary() {
    return {
      id: this.id,
      title: this.title,
      running: this.running,
      messageCount: this.messageCount,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      model: this.agent.config.model,
      workspace: this.agent.config.workspaceRoot
    };
  }

  /** Per-session fields for /api/state. */
  state() {
    return {
      sessionId: this.id,
      title: this.title,
      model: this.agent.config.model,
      workspace: this.agent.config.workspaceRoot,
      agents: this.useAgents,
      yes: this.agent.approval.mode === "auto-all",
      approval: this.agent.approval.mode,
      running: this.running,
      usage: this.agent.usage.hasData ? this.agent.usage.format() : ""
    };
  }

  /** Full live state for debugging (GET /api/debug?session=id). */
  debugState() {
    return {
      ...this.summary(),
      useAgents: this.useAgents,
      approval: this.agent.approval.mode,
      workspaceTrusted: this.agent.config.workspaceTrusted,
      usage: this.agent.usage.hasData ? this.agent.usage.format() : null,
      clientCount: this.clients.size,
      eventCount: this.buffer.length,
      lastSeq: this.seq,
      pendingRequests: [...this.pending.entries()].map(([id, p]) => ({ id, kind: p.kind, summary: p.summary, ageMs: Date.now() - p.createdAt })),
      contextItems: this.agent.context.list().length,
      recentEvents: this.buffer.slice(-40).map((i) => ({ seq: i.seq, ...i.ev }))
    };
  }
}

export async function startWebServer(opts: WebServerOptions): Promise<WebServer> {
  const token = randomUUID().replace(/-/g, "");
  const deps: SessionDeps = {
    switchWorkspace: opts.switchWorkspace,
    switchModel: opts.switchModel,
    demoMode: Boolean(opts.demoEvents),
    multiAgentDefault: opts.multiAgentDefault ?? true
  };

  // Conversations auto-persist here and survive restarts until deleted. Demo
  // mode (screenshot/test fixtures) never touches disk.
  const store = deps.demoMode ? undefined : new ConversationStore(opts.agent.config.workspaceRoot);
  // Previously-saved threads, loaded as data-only "archived" entries; opening one
  // promotes it to a live session seeded with its history (see /api/sessions/activate).
  const archived = new Map<string, SavedConversation>();
  for (const c of store?.loadAll() ?? []) archived.set(c.id, c);

  const sessions = new Map<string, WebSession>();
  let counter = 0;
  const newId = () => `c${++counter}-${randomUUID().slice(0, 4)}`;
  const addSession = (agent: Agent, demoEvents?: WebEvent[]): WebSession => {
    const session = new WebSession(newId(), agent, deps, { demoEvents, store });
    sessions.set(session.id, session);
    return session;
  };
  const firstSession = addSession(opts.agent, opts.demoEvents);
  let activeId = firstSession.id;

  const resolveSession = (url: URL): WebSession =>
    sessions.get(url.searchParams.get("session") ?? "") ?? sessions.get(activeId) ?? firstSession;

  /** Merged list for the sidebar: live sessions + archived threads, newest first. */
  const conversationList = () => {
    const live = [...sessions.values()].map((s) => ({ ...s.summary(), archived: false }));
    const liveIds = new Set(sessions.keys());
    const arch = [...archived.values()]
      .filter((c) => !liveIds.has(c.id))
      .map((c) => ({ id: c.id, title: c.title, running: false, messageCount: c.messageCount, createdAt: c.createdAt, lastActivityAt: c.lastActivityAt, model: c.model, workspace: c.workspace, archived: true }));
    return [...live, ...arch].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  };

  /** Promote an archived thread to a live session seeded with its history. */
  const activateConversation = async (id: string): Promise<boolean> => {
    if (sessions.has(id)) {
      activeId = id;
      return true;
    }
    const saved = archived.get(id);
    if (!saved || !opts.createAgent) return false;
    const agent = await opts.createAgent();
    const session = new WebSession(id, agent, deps, { restore: saved, store });
    sessions.set(id, session);
    archived.delete(id);
    activeId = id;
    return true;
  };

  const sendJson = (res: http.ServerResponse, body: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
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

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      sendJson(res, { sessions: conversationList(), activeId });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/debug") {
      const id = url.searchParams.get("session");
      if (id) {
        const session = sessions.get(id);
        if (!session) return sendJson(res, { error: "unknown session" }, 404);
        return sendJson(res, session.debugState());
      }
      sendJson(res, { activeId, sessions: [...sessions.values()].map((s) => s.debugState()) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/file") {
      // Serve a workspace file (images for inline preview, or any text/source) —
      // path-confined to the session's workspace, with sensitive paths blocked.
      const session = resolveSession(url);
      const rel = url.searchParams.get("path") ?? "";
      const root = path.resolve(session.agent.config.workspaceRoot);
      const abs = path.resolve(root, rel);
      const blocked = /(^|[\\/])\.(git|env)([\\/]|$)/i.test(rel) || /(^|[\\/])node_modules([\\/]|$)/.test(rel);
      if (!abs.startsWith(root + path.sep) && abs !== root) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || blocked || stat.size > 8_000_000) {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not available");
          return;
        }
        res.writeHead(200, { "content-type": contentType(abs), "cache-control": "no-cache" });
        fs.createReadStream(abs).pipe(res);
      } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      const session = resolveSession(url);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const lastId = Number(url.searchParams.get("lastEventId") ?? req.headers["last-event-id"] ?? 0) || 0;
      session.attach(res, lastId);
      const heartbeat = setInterval(() => {
        try { res.write(":hb\n\n"); } catch { /* pruned on next emit */ }
      }, 25_000);
      heartbeat.unref?.();
      req.on("close", () => {
        clearInterval(heartbeat);
        session.clients.delete(res);
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      const session = resolveSession(url);
      sendJson(res, {
        ...session.state(),
        approvalModes: APPROVAL_MODES,
        canSwitchWorkspace: Boolean(opts.switchWorkspace),
        canSwitchModel: Boolean(opts.switchModel),
        canCreateSession: Boolean(opts.createAgent),
        commands: visibleSlashCommands().map((c) => ({ name: c.name, usage: c.usage, description: c.description })),
        sessions: conversationList(),
        activeId
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readJson(req);

      if (url.pathname === "/api/sessions") {
        if (!opts.createAgent) return sendJson(res, { error: "Creating conversations is unavailable in this session." }, 400);
        const agent = await opts.createAgent();
        const session = addSession(agent);
        activeId = session.id;
        return sendJson(res, { id: session.id, summary: session.summary() });
      }
      if (url.pathname === "/api/sessions/activate") {
        const id = String(body?.id ?? "");
        const ok = await activateConversation(id);
        return sendJson(res, { ok, activeId });
      }
      if (url.pathname === "/api/sessions/delete" || url.pathname === "/api/sessions/close") {
        // Permanent delete: remove the live session (if any), the archived copy,
        // and the on-disk file. Conversations persist until this is called.
        const id = String(body?.id ?? "");
        const session = sessions.get(id);
        if (session) {
          session.interrupt();
          session.closeClients();
          sessions.delete(id);
        }
        archived.delete(id);
        store?.delete(id);
        if (activeId === id) {
          // Fall back to another live session, creating a fresh one if none remain.
          activeId = [...sessions.keys()][0] ?? (opts.createAgent ? addSession(await opts.createAgent()).id : firstSession.id);
        }
        return sendJson(res, { ok: true, activeId, sessions: conversationList() });
      }

      const session = resolveSession(url);
      if (url.pathname === "/api/message") {
        const text = String(body?.text ?? "").trim();
        if (text) session.processInput(text);
        return sendJson(res, { ok: true, running: session.running });
      }
      if (url.pathname === "/api/interrupt") {
        session.interrupt();
        return sendJson(res, { ok: true });
      }
      if (url.pathname === "/api/respond") {
        const ok = session.resolvePending(String(body?.id ?? ""), body);
        return sendJson(res, { ok });
      }
      if (url.pathname === "/api/toggle") {
        session.setToggles(body);
        return sendJson(res, { ok: true });
      }
      if (url.pathname === "/api/trust") {
        const action = String(body?.action ?? "");
        const store = new WorkspaceTrustStore();
        const ws2 = session.agent.config.workspaceRoot;
        if (action === "clear") store.clearTrust(ws2);
        else if (action === "exact" || action === "descendants") store.setTrust(ws2, action as WorkspaceTrustScope);
        if (opts.switchWorkspace) {
          try {
            session.setAgent(await opts.switchWorkspace(ws2));
          } catch {
            /* keep current agent if rebuild fails */
          }
        } else {
          session.agent.config.workspaceTrusted = Boolean(store.getTrustFor(ws2));
        }
        const entry = store.getTrustFor(ws2);
        session.emit({ type: "output", title: "Workspace trust", text: entry ? `Updated: ${describeTrustEntry(entry)}` : "Trust cleared." });
        session.emit(session.stateEvent());
        return sendJson(res, { ok: true });
      }
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });

  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
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
        for (const session of sessions.values()) session.closeClients();
        for (const socket of sockets) {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        }
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      })
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".avif": "image/avif", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8"
};
function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "text/plain; charset=utf-8";
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
