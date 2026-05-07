import type { ContextManager } from "../context/ContextManager.js";
import type { Skill } from "../skills/Skill.js";
import type { ToolSkill } from "../tool-skills/ToolSkill.js";
import { CORE_SYSTEM_PROMPT, ENVIRONMENT_POLICY } from "./prompts.js";

export type ModelInputBuildOptions = {
  task: string;
  context: ContextManager;
  toolIndex: string;
  generalSkills: Skill[];
  toolSkills: ToolSkill[];
  projectInstructions: string;
  situationSnapshot?: string;
};

export function buildModelInput(options: ModelInputBuildOptions): string {
  const relevant = options.context.relevant(options.task)
    .filter((item) => !["general_skill", "tool_skill", "tool_index", "system_instruction", "environment_policy"].includes(item.type))
    .map((item) => `<${item.type} id="${item.id}">\n${item.content}\n</${item.type}>`)
    .join("\n\n");
  return `<System>
${CORE_SYSTEM_PROMPT}
</System>

<Environment Policy>
${ENVIRONMENT_POLICY}
</Environment Policy>

<Tool Index>
${options.toolIndex}
</Tool Index>

<Active General Skills>
${options.generalSkills.map((skill) => skill.content).join("\n\n")}
</Active General Skills>

<Active Full Tool Skills>
${options.toolSkills.map((skill) => skill.full).join("\n\n")}
</Active Full Tool Skills>

<Project Instructions>
${options.projectInstructions || "None."}
</Project Instructions>

<Relevant Context>
${relevant || "No additional context yet."}
</Relevant Context>
${options.situationSnapshot ? `
<Situation Memory>
${options.situationSnapshot}
</Situation Memory>
` : ""}
<User Task>
${options.task}
</User Task>`;
}
