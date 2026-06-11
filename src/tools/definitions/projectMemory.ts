import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import { MEMORY_SECTIONS } from "../../memory/ProjectMemory.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const SECTION_LIST = MEMORY_SECTIONS.join(" | ");

export function rememberTool(skills: ToolSkillRegistry) {
  return makeTool(
    "remember",
    `Record durable project knowledge in core memory (persists across runs): the user's intent, core assumptions, cautions/gotchas, key decisions, conventions. Section is one of: ${SECTION_LIST}. Pass an existing id to update that entry. Only record what is NOT recoverable from code; do not record one-off task details.`,
    schemas.object({ section: { type: "string" }, content: { type: "string" }, id: { type: "string" } }, ["section", "content"]),
    z.object({ section: z.enum(MEMORY_SECTIONS), content: z.string().min(1), id: z.string().optional() }),
    skills,
    async (args, ctx) => {
      if (!ctx.memory) throw new Error("Project memory is not available in this context.");
      const entry = ctx.memory.remember({ section: args.section, content: args.content, id: args.id });
      return { id: entry.id, section: entry.section, content: entry.content, updated: Boolean(args.id) };
    }
  );
}

export function forgetTool(skills: ToolSkillRegistry) {
  return makeTool(
    "forget",
    "Remove a project core-memory entry by id (use when a remembered fact is now wrong or obsolete).",
    schemas.object({ id: { type: "string" } }, ["id"]),
    z.object({ id: z.string().min(1) }),
    skills,
    async (args, ctx) => {
      if (!ctx.memory) throw new Error("Project memory is not available in this context.");
      const removed = ctx.memory.forget(args.id);
      return { id: args.id, removed };
    }
  );
}
