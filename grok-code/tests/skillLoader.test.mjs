import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SkillLoader } from "../dist/skills/SkillLoader.js";
import { ContextManager } from "../dist/context/ContextManager.js";
import { buildModelInput } from "../dist/agent/modelInputBuilder.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";
import { LOCAL_TOOL_NAMES, createLocalToolRegistry } from "../dist/tools/definitions/index.js";

const root = process.cwd();
const skillPath = path.join(root, "src", "skills", "builtin", "tree-based-code-navigation.md");

test("tree-based code navigation skill file exists and loads", () => {
  assert.equal(fs.existsSync(skillPath), true);
  const loader = new SkillLoader(root);
  const skill = loader.loadAll().find((item) => item.id === "tree-based-code-navigation");
  assert.ok(skill);
  assert.match(skill.content, /Search before reading/);
  assert.match(skill.content, /Read exact ranges/);
  assert.match(skill.content, /Expand only high-confidence nodes/);
});

test("coding tasks select tree-based code navigation", () => {
  const loader = new SkillLoader(root);
  const selected = loader.select("debug a failing test with a stack trace and modify code");
  assert.ok(selected.some((skill) => skill.id === "tree-based-code-navigation"));
});

test("non-coding tasks do not select tree-based code navigation unconditionally", () => {
  const loader = new SkillLoader(root);
  const selected = loader.select("write a short poem about Taipei weather");
  assert.equal(selected.some((skill) => skill.id === "tree-based-code-navigation"), false);
});

test("model input includes core tree navigation rules when selected", () => {
  const loader = new SkillLoader(root);
  const skills = loader.select("find relevant files and fix the implementation");
  const prompt = buildModelInput({
    task: "find relevant files and fix the implementation",
    context: new ContextManager(),
    toolIndex: "Available tools:\n- search_text: keyword search\n- read_file_range: exact range reads",
    generalSkills: skills,
    toolSkills: [],
    projectInstructions: ""
  });
  assert.match(prompt, /Search before reading/);
  assert.match(prompt, /Read exact ranges/);
  assert.match(prompt, /Expand only high-confidence nodes/);
});

test("tree search tools are registered and indexed", () => {
  const toolSkills = new ToolSkillRegistry(root);
  toolSkills.loadBuiltin(LOCAL_TOOL_NAMES);
  const tools = createLocalToolRegistry(toolSkills);
  const names = tools.list().map((tool) => tool.name);
  assert.ok(names.includes("search_code"));
  assert.ok(names.includes("find_symbol"));
  assert.ok(names.includes("expand_node"));
  assert.ok(names.includes("get_related_files"));
  const index = toolSkills.toolIndex();
  assert.match(index, /search_code/);
  assert.match(index, /find_symbol/);
  assert.match(index, /expand_node/);
  assert.match(index, /get_related_files/);
});
