# create_skill

Create or update a project-local general skill under `.grok-code/skills`.

- Use when the user wants the agent to remember a reusable workflow, coding convention, project policy, domain rule, review checklist, or debugging procedure.
- Use when no existing skill fits a recurring workflow and the task would benefit from durable project-local guidance.
- If public/current guidance is needed before designing the skill, use available web_search or x_search server-side tools first.
- Keep the skill concrete and operational: include triggers, rules, workflow, good examples, and things to avoid.
- Do not use this for secrets, credentials, one-off task notes, raw logs, or large generated content.
- Prefer lowercase slug ids such as `api-review`, `database-migrations`, or `react-component-style`.
- Use `overwrite=true` only when intentionally replacing an existing project skill.
- After creating a skill, mention that it is project-local and loaded from `.grok-code/skills/*.md`.
