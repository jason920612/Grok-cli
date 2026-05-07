import type { ContextManager } from "../context/ContextManager.js";
import type { Skill } from "../skills/Skill.js";
import type { ToolSkill } from "../tool-skills/ToolSkill.js";
import { CORE_SYSTEM_PROMPT, ENVIRONMENT_POLICY, STATELESS_EPISTEMIC_STANCE } from "./prompts.js";

export type ModelInputBuildOptions = {
  task: string;
  context: ContextManager;
  toolIndex: string;
  generalSkills: Skill[];
  toolSkills: ToolSkill[];
  projectInstructions: string;
};

export type StatelessInputBuildOptions = {
  task: string;
  verifiedObservations: string[];
  lastFailure?: {
    toolName: string;
    args: string;
    error: string;
    attempts: number;
  };
  toolIndex: string;
  generalSkills: Skill[];
  toolSkills: ToolSkill[];
  projectInstructions: string;
};

export function buildStatelessInput(options: StatelessInputBuildOptions): string {
  const observations = options.verifiedObservations.length > 0
    ? options.verifiedObservations.map((o) => `- ${o}`).join("\n")
    : "None yet.";

  const failureSection = options.lastFailure
    ? `\n<Last Failure>
Tool: ${options.lastFailure.toolName}
Args: ${options.lastFailure.args}
Error: ${options.lastFailure.error}
Attempts: ${options.lastFailure.attempts}
Constraint: Do not retry this exact call unchanged. Narrow the scope, inspect the root cause, or choose a different approach.
</Last Failure>`
    : "";

  return `<System>
${CORE_SYSTEM_PROMPT}

${STATELESS_EPISTEMIC_STANCE}
</System>

<Tool Index>
${options.toolIndex}
</Tool Index>

<Active General Skills>
${options.generalSkills.map((skill) => skill.content).join("\n\n") || "None."}
</Active General Skills>

<Active Full Tool Skills>
${options.toolSkills.map((skill) => skill.full).join("\n\n") || "None."}
</Active Full Tool Skills>

<Project Instructions>
${options.projectInstructions || "None."}
</Project Instructions>

<Current Task>
${options.task}
</Current Task>

<Verified Workspace Observations>
${observations}
</Verified Workspace Observations>
${failureSection}`;
}

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

<User Task>
${options.task}
</User Task>`;
}
