import type { AgentTool, ToolExecutionContext, ToolResult } from "./AgentTool.js";

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.name, tool);
  }

  list(): AgentTool[] {
    return [...this.tools.values()];
  }

  schemas(includeServerTools: Array<Record<string, unknown>> = []): Record<string, unknown>[] {
    return [...this.list().map((tool) => tool.schema), ...includeServerTools];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  isReadOnly(name: string): boolean {
    return this.tools.get(name)?.readOnly ?? false;
  }

  async execute(name: string, args: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: { code: "unknown_tool", message: `Unknown local tool: ${name}` } };
    }
    try {
      const data = await tool.execute(args, ctx);
      return { ok: true, data, summary: summarize(data) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "tool_execution_error",
          message: error instanceof Error ? error.message : String(error)
        }
      };
    }
  }
}

function summarize(data: unknown): string {
  const text = JSON.stringify(data);
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}
