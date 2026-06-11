/**
 * Mid-task interjection channel.
 *
 * While a task runs, the user can type a line; it is queued here and the loop
 * drains it at the top of the next step, appending it to the transcript as a
 * user message. The current step is never interrupted — the agent reads the
 * note when it comes up for air, then continues with the new context.
 */
export class Interjections {
  private queue: string[] = [];

  push(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.queue.push(trimmed);
  }

  /** Take and clear all pending notes. */
  drain(): string[] {
    if (this.queue.length === 0) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }

  get pending(): number {
    return this.queue.length;
  }
}
