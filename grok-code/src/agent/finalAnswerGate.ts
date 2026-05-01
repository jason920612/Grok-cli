import type { BackgroundProcessManager } from "../background/BackgroundProcessManager.js";
import type { ToolRegistry } from "../tools/ToolRegistry.js";
import type { ToolExecutionContext } from "../tools/AgentTool.js";

export async function finalAnswerGate(options: {
  oneShot: boolean;
  userAskedToKeepBackground?: boolean;
  background: BackgroundProcessManager;
  tools: ToolRegistry;
  toolCtx: ToolExecutionContext;
  hasModifiedFiles: boolean;
}): Promise<{ backgroundStatus: string; diffChecked: boolean; diffPreview?: string }> {
  const running = options.background.listRunning();
  let backgroundStatus = "No running background commands.";
  if (running.length > 0 && options.oneShot && !options.userAskedToKeepBackground) {
    const stopped = await options.background.stopAll("one-shot final cleanup");
    backgroundStatus = `Stopped ${stopped.length} background command(s).`;
  } else if (running.length > 0) {
    backgroundStatus = `Still running: ${running.map((p) => `${p.id} ${p.command}`).join(", ")}`;
  }

  let diffChecked = false;
  let diffPreview: string | undefined;
  if (options.hasModifiedFiles) {
    await options.tools.execute("git_status", {}, options.toolCtx);
    const diffResult = await options.tools.execute("git_diff", {}, options.toolCtx);
    if (diffResult.ok && isDiffData(diffResult.data)) {
      diffPreview = [`git diff --stat`, diffResult.data.stat, `git diff`, diffResult.data.diff].filter(Boolean).join("\n");
    }
    diffChecked = true;
  }
  return { backgroundStatus, diffChecked, diffPreview };
}

function isDiffData(value: unknown): value is { stat: string; diff: string } {
  return typeof value === "object" && value !== null && "stat" in value && "diff" in value;
}
