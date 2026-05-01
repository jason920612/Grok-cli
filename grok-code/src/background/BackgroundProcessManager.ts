import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BackgroundProcess } from "./BackgroundProcess.js";
import { OutputRingBuffer } from "./OutputRingBuffer.js";

type Entry = {
  meta: BackgroundProcess;
  child: ChildProcessWithoutNullStreams;
  buffer: OutputRingBuffer;
};

export class BackgroundProcessManager {
  private entries = new Map<string, Entry>();

  start(command: string, reason: string, cwd: string, successPattern?: string): BackgroundProcess {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: "pipe",
      windowsHide: true
    });
    const id = randomUUID();
    const buffer = new OutputRingBuffer();
    const meta: BackgroundProcess = {
      id,
      pid: child.pid ?? -1,
      command,
      reason,
      cwd,
      status: "starting",
      startedAt: new Date().toISOString(),
      outputBuffer: [],
      successPattern
    };
    const entry: Entry = { meta, child, buffer };
    this.entries.set(id, entry);
    child.stdout.on("data", (data: Buffer) => {
      meta.status = "running";
      buffer.push(data.toString("utf8"));
      meta.outputBuffer = buffer.read(1000);
    });
    child.stderr.on("data", (data: Buffer) => {
      meta.status = "running";
      buffer.push(data.toString("utf8"));
      meta.outputBuffer = buffer.read(1000);
    });
    child.on("exit", (code) => {
      meta.status = meta.status === "stopped" ? "stopped" : code === 0 ? "exited" : "failed";
      meta.exitCode = code ?? undefined;
      meta.exitedAt = new Date().toISOString();
    });
    child.on("error", () => {
      meta.status = "failed";
      meta.exitedAt = new Date().toISOString();
    });
    return meta;
  }

  list(): BackgroundProcess[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.meta, outputBuffer: entry.buffer.read(20) }));
  }

  listRunning(): BackgroundProcess[] {
    return this.list().filter((item) => item.status === "starting" || item.status === "running");
  }

  read(id: string, maxLines = 120): string[] {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown background process: ${id}`);
    return entry.buffer.read(maxLines);
  }

  async stop(id: string, reason: string): Promise<BackgroundProcess> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown background process: ${id}`);
    entry.meta.reason = `${entry.meta.reason}; stop reason: ${reason}`;
    if (entry.meta.status === "running" || entry.meta.status === "starting") {
      entry.meta.status = "stopped";
      entry.child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!entry.child.killed) entry.child.kill("SIGKILL");
    }
    entry.meta.exitedAt = entry.meta.exitedAt ?? new Date().toISOString();
    return { ...entry.meta, outputBuffer: entry.buffer.read(20) };
  }

  async stopAll(reason: string): Promise<BackgroundProcess[]> {
    const stopped: BackgroundProcess[] = [];
    for (const process of this.listRunning()) {
      stopped.push(await this.stop(process.id, reason));
    }
    return stopped;
  }
}
