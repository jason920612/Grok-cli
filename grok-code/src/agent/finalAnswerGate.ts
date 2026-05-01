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
}): Promise<{ backgroundStatus: string; diffChecked: boolean }> {
  const running = options.background.listRunning();
  let backgroundStatus = "No running background commands.";
  if (running.length > 0 && options.oneShot && !options.userAskedToKeepBackground) {
    const stopped = await options.background.stopAll("one-shot final cleanup");
    backgroundStatus = `Stopped ${stopped.length} background command(s).`;
  } else if (running.length > 0) {
    backgroundStatus = `Still running: ${running.map((p) => `${p.id} ${p.command}`).join(", ")}`;
  }

  let diffChecked = false;
  if (options.hasModifiedFiles) {
    await options.tools.execute("git_status", {}, options.toolCtx);
    await options.tools.execute("git_diff", {}, options.toolCtx);
    diffChecked = true;
  }
  return { backgroundStatus, diffChecked };
}
