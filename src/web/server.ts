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
  | { type: "mode"; agents: boolean; yes: boolean };

export type WebServerOptions = {
  agent: Agent;
  multiAgentDefault?: boolean;
  /** 0 (default) lets the OS pick a free port. */
  port?: number;
  openBrowser?: boolean;
  /** Pre-baked events for screenshot/demo runs — no live agent calls. */
  demoEvents?: WebEvent[];
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
  const agent = opts.agent;
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

  agent.askUser = webAskUser;
  agent.approval.prompter = webPrompter;

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
        if (text) void runTask(text);
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
