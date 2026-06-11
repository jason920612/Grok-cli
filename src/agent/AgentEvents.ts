/**
 * Agent lifecycle event bus (§7.5).
 *
 * The loop emits structured events instead of calling `console.log` directly.
 * `ConsoleEventSink` is the default listener (preserves CLI behaviour); headless
 * embeddings swap in their own sink, and tests use a capture sink to assert on
 * behaviour. This is also the future mount point for streaming UI / metrics /
 * audit logs.
 */
import chalk from "chalk";

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

const LABEL_COLORS = [chalk.cyan, chalk.green, chalk.yellow, chalk.magenta, chalk.blue, chalk.red];
function colorForLabel(label: string): (s: string) => string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  return LABEL_COLORS[hash % LABEL_COLORS.length];
}

/**
 * Event sink for multi-agent runs. Concurrent workers can't each drive a live
 * ora spinner (they corrupt each other on one TTY), so the loop suppresses
 * spinners when labeled and routes every event through here instead: one
 * prefixed line per event, colored + indented per agent so interleaved output
 * stays readable (who did what).
 */
export class LabeledEventSink implements AgentEventSink {
  private readonly tag: string;
  private readonly indent: string;

  constructor(label: string, isWorker = false) {
    this.tag = colorForLabel(label)(`[${label}]`);
    this.indent = isWorker ? "  " : "";
  }

  emit(event: AgentEvent): void {
    const line = (body: string) => console.log(`${this.indent}${this.tag} ${body}`);
    switch (event.type) {
      case "warn":
        line(chalk.yellow(event.message));
        break;
      case "model_text":
        line(chalk.dim(truncateOneLine(event.message)));
        break;
      default:
        line(event.message);
    }
  }
}

function truncateOneLine(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

export class CaptureEventSink implements AgentEventSink {
  readonly events: AgentEvent[] = [];
  emit(event: AgentEvent): void {
    this.events.push(event);
  }
}
