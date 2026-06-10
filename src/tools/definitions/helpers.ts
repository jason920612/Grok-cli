import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z, type ZodTypeAny } from "zod";
import type { AgentTool, ToolExecutionContext } from "../AgentTool.js";
import { assertSchemaMatchesZod } from "../toolSchemas.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const execFileAsync = promisify(execFile);

export function makeTool<T extends ZodTypeAny>(
  name: string,
  description: string,
  parameters: unknown,
  validator: T,
  skillRegistry: ToolSkillRegistry,
  execute: (args: z.infer<T>, ctx: ToolExecutionContext) => Promise<unknown>
): AgentTool {
  assertSchemaMatchesZod(name, parameters, validator);
  return {
    name,
    description,
    schema: { type: "function", name, description, parameters },
    execute: async (args, ctx) => execute(validator.parse(args), ctx),
    skill: skillRegistry.get(name),
    locality: "local",
    readOnly: false
  };
}

export async function commandExists(command: string): Promise<boolean> {
  const cmd = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(cmd, [command], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function summarizeOutput(text: string, maxLines = 200, maxChars = 20_000): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  const errorLines = lines.filter((line) => /error|failed|exception|traceback|cannot|not found/i.test(line));
  const selected = lines.length <= maxLines
    ? lines
    : [...lines.slice(0, 40), ...errorLines.slice(0, 40), ...lines.slice(-120)];
  let joined = Array.from(new Set(selected)).join("\n");
  const truncated = lines.length > maxLines || joined.length > maxChars;
  if (joined.length > maxChars) joined = `${joined.slice(0, maxChars)}\n[truncated]`;
  return { text: joined, truncated };
}
