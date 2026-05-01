import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { schemas } from "../toolSchemas.js";
import { makeTool } from "./helpers.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";

const createSkillArgs = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,80}$/, "id must be a lowercase slug such as api-review or prisma-debugging"),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  triggers: z.array(z.string().min(1).max(60)).min(1).max(20),
  content: z.string().min(1).max(20_000),
  overwrite: z.boolean().optional().default(false)
});

export function createSkillTool(skills: ToolSkillRegistry) {
  return makeTool(
    "create_skill",
    "Create or update a project-local Grok Code general skill markdown file under .grok-code/skills.",
    schemas.object({
      id: schemas.string("Lowercase skill slug, used as .grok-code/skills/<id>.md."),
      title: schemas.string("Human-readable skill title."),
      description: schemas.string("Short description of what this skill teaches the agent to do."),
      triggers: {
        type: "array",
        items: { type: "string" },
        description: "Keywords or phrases that should activate this skill."
      },
      content: schemas.string("Markdown body with concrete rules, workflow, examples, and avoidance guidance."),
      overwrite: schemas.boolean("Whether to replace an existing project skill file.")
    }, ["id", "title", "description", "triggers", "content"]),
    createSkillArgs,
    skills,
    async (args, ctx) => {
      const relativePath = `.grok-code/skills/${args.id}.md`;
      const absPath = ctx.sandbox.assertWritablePatchPath(relativePath);
      const skillDir = ctx.sandbox.assertWritablePatchPath(".grok-code/skills");
      const exists = await fs.stat(absPath).then((stat) => stat.isFile()).catch(() => false);
      if (exists && !args.overwrite) {
        throw new Error(`Skill already exists: ${relativePath}. Set overwrite=true to replace it.`);
      }

      const approved = await ctx.approval.approvePatch(`Create project skill ${args.id}`);
      if (!approved) throw new Error("Skill creation denied by approval policy.");

      const markdown = renderSkillMarkdown(args);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(absPath, markdown, "utf8");
      ctx.context.add({
        type: "general_skill",
        content: `Created project skill ${relativePath}\n${markdown.slice(0, 2000)}`,
        priority: 75,
        source: { path: relativePath }
      });
      return {
        path: path.relative(ctx.workspaceRoot, absPath).replace(/\\/g, "/"),
        created: !exists,
        overwritten: exists,
        reminder: "Project skills are loaded from .grok-code/skills/*.md on the next skill selection pass or CLI run."
      };
    }
  );
}

function renderSkillMarkdown(args: z.infer<typeof createSkillArgs>): string {
  const triggers = args.triggers.map((trigger) => `- ${trigger}`).join("\n");
  return `# ${args.title}

${args.description}

## Triggers

${triggers}

## Guidance

${args.content.trim()}
`;
}
