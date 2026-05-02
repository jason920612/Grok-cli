export class OutputRingBuffer {
  private lines: string[] = [];
  private chars = 0;

  constructor(private readonly maxLines = 1000, private readonly maxChars = 200_000) {}

  push(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.lines.push(line);
      this.chars += line.length;
    }
    while (this.lines.length > this.maxLines || this.chars > this.maxChars) {
      const removed = this.lines.shift();
      if (removed) this.chars -= removed.length;
    }
  }

  read(maxLines = 120): string[] {
    return this.lines.slice(-Math.min(maxLines, 200));
  }
}
