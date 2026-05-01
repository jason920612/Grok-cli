export type BackgroundProcess = {
  id: string;
  pid: number;
  command: string;
  reason: string;
  cwd: string;
  status: "starting" | "running" | "exited" | "failed" | "stopped";
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  outputBuffer: string[];
  successPattern?: string;
};
