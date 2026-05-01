import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function startBackgroundCommandTool(skills: ToolSkillRegistry) {
  return makeTool(
    "start_background_command",
    "Start a long-running shell command in the background, such as a dev server, watcher, Storybook, emulator, or log tail. Must be stopped when no longer needed.",
    schemas.object({
      command: { type: "string" },
      reason: { type: "string" },
      successPattern: { type: "string", description: "Optional output pattern indicating the process is ready or achieved its purpose." },
      timeoutSeconds: { type: "number", description: "Seconds to wait for startup output before returning." }
    }, ["command", "reason"]),
    z.object({ command: z.string().min(1), reason: z.string().min(1), successPattern: z.string().optional(), timeoutSeconds: z.number().positive().max(60).optional() }),
    skills,
    async (args, ctx) => {
      const approval = await ctx.approval.approveCommand(args.command, args.reason, { background: true });
      if (!approval.approved) throw new Error(approval.message ?? `Background command rejected: ${approval.risk}`);
      const duplicate = ctx.background.listRunning().find((proc) => proc.command === args.command);
      if (duplicate) return { ...duplicate, duplicate: true, stopReminder: "Stop it when no longer needed." };
      const proc = ctx.background.start(args.command, args.reason, ctx.workspaceRoot, args.successPattern);
      await delay((args.timeoutSeconds ?? 3) * 1000);
      const output = ctx.background.read(proc.id, 120).join("\n");
      ctx.context.add({ type: "background_process", content: JSON.stringify({ ...proc, outputBuffer: [] }, null, 2), priority: 70, source: { command: args.command, processId: proc.id } });
      ctx.context.add({ type: "background_output_summary", content: output, priority: 55, expiresAfterSteps: 2, source: { processId: proc.id } });
      return { ...proc, initialOutput: output, stopReminder: "Call stop_background_command when this process has served its purpose." };
    }
  );
}
