import fg from "fast-glob";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

export function listFilesTool(skills: ToolSkillRegistry) {
  return makeTool(
    "list_files",
    "List workspace files without reading file contents.",
    schemas.object({ path: schemas.string("Subdirectory to list."), glob: schemas.string("Glob pattern."), maxResults: schemas.number("Maximum results.") }),
    z.object({ path: z.string().optional(), glob: z.string().optional(), maxResults: z.number().int().positive().max(1000).optional() }),
    skills,
    async (args, ctx) => {
      const base = args.path ?? ".";
      ctx.sandbox.resolvePath(base);
      const pattern = args.glob ?? "**/*";
      const entries = await fg(pattern, { cwd: ctx.sandbox.resolvePath(base), dot: true, onlyFiles: true, ignore: ["**/.git/**", "**/node_modules/**"] });
      const files = entries
        .map((entry) => (base === "." ? entry : `${base.replace(/\\/g, "/")}/${entry}`))
        .filter((entry) => !ctx.sandbox.isPathDenied(entry, "read"))
        .slice(0, args.maxResults ?? 200);
      ctx.context.add({ type: "search_result", content: `list_files ${base} ${pattern}\n${files.join("\n")}`, priority: 45, expiresAfterSteps: 3 });
      return { files, truncated: entries.length > files.length };
    }
  );
}
