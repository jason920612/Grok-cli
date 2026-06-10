/**
 * Agent lifecycle event bus (§7.5).
 *
 * The loop emits structured events instead of calling `console.log` directly.
 * `ConsoleEventSink` is the default listener (preserves CLI behaviour); headless
 * embeddings swap in their own sink, and tests use a capture sink to assert on
 * behaviour. This is also the future mount point for streaming UI / metrics /
 * audit logs.
 */

export type AgentEvent =
  | { type: "step"; step: number; message: string }
  | { type: "info"; message: string }
  | { type: "warn"; message: string }
  | { type: "tool_batch"; step: number; message: string }
  | { type: "verifier"; message: string }
  | { type: "model_text"; message: string };

export interface AgentEventSink {
  emit(event: AgentEvent): void;
}

export class ConsoleEventSink implements AgentEventSink {
  emit(event: AgentEvent): void {
    if (event.type === "warn") console.log(`[Warning] ${event.message}`);
    else console.log(event.message);
  }
}

export class CaptureEventSink implements AgentEventSink {
  readonly events: AgentEvent[] = [];
  emit(event: AgentEvent): void {
    this.events.push(event);
  }
}
