import type { Skill } from "./Skill.js";

export class SkillRegistry {
  constructor(private readonly skills: Skill[]) {}

  list(): Skill[] {
    return this.skills;
  }

  format(skills: Skill[]): string {
    return skills.map((skill) => `## ${skill.title}\n${skill.content}`).join("\n\n");
  }
}
