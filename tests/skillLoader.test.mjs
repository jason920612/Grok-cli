import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SkillLoader } from "../dist/skills/SkillLoader.js";
import { ContextManager } from "../dist/context/ContextManager.js";
import { buildModelInput } from "../dist/agent/modelInputBuilder.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";
import { LOCAL_TOOL_NAMES, createLocalToolRegistry } from "../dist/tools/definitions/index.js";
import { ApprovalPolicy } from "../dist/approval/ApprovalPolicy.js";
import { CORE_SYSTEM_PROMPT } from "../dist/agent/prompts.js";
import { loadConfig } from "../dist/config/loadConfig.js";
import { parseResponse } from "../dist/api/responseParser.js";

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

test("commit and push tasks select git workflow skill", () => {
  const loader = new SkillLoader(root);
  const selected = loader.select("幫我寫commit並push");
  assert.ok(selected.some((skill) => skill.id === "git-commit-push"));
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

test("approval policy supports local and all automation levels", async () => {
  const onRequest = new ApprovalPolicy("on-request");
  assert.equal((await onRequest.approveCommand("git status --short", "inspect")).approved, true);
  assert.equal(await onRequest.approvePatch("workspace patch"), true);

  const autoLocal = new ApprovalPolicy("auto-local");
  assert.equal((await autoLocal.approveCommand("npm install", "install local dependencies")).approved, true);

  const autoAll = new ApprovalPolicy("auto-all");
  assert.equal((await autoAll.approveCommand("npm install", "install local dependencies")).approved, true);
  assert.equal((await autoAll.approveCommand("git push origin main", "push")).approved, false);

  const never = new ApprovalPolicy("never");
  assert.equal(await never.approvePatch("workspace patch"), false);
});

test("system prompt requires plans and final action summaries", () => {
  assert.match(CORE_SYSTEM_PROMPT, /Before requesting tools, briefly tell the user/);
  assert.match(CORE_SYSTEM_PROMPT, /request the tools in the same turn/);
  assert.match(CORE_SYSTEM_PROMPT, /If no existing skill fits/);
  assert.match(CORE_SYSTEM_PROMPT, /create_skill/);
  assert.match(CORE_SYSTEM_PROMPT, /same language the user used/);
  assert.match(CORE_SYSTEM_PROMPT, /plain terminal/);
  assert.match(CORE_SYSTEM_PROMPT, /not Markdown formatting/);
  assert.match(CORE_SYSTEM_PROMPT, /Before the first tool call, provide a brief plan/);
  assert.match(CORE_SYSTEM_PROMPT, /final answer must summarize the completed actions/);
});

test("response parser deduplicates repeated output text fields", () => {
  const parsed = parseResponse({
    id: "resp_1",
    output_text: "same answer",
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: "same answer" },
          { type: "output_text", output_text: "same answer" }
        ]
      }
    ]
  });
  assert.equal(parsed.finalText, "same answer");
});

test("xAI server-side search tools are enabled by default", () => {
  const config = loadConfig(root);
  assert.equal(config.serverTools, true);
  assert.equal(config.enableWebSearch, true);
  assert.equal(config.enableXSearch, true);
});

test("undefined CLI overrides do not disable default server-side search tools", () => {
  const config = loadConfig(root, {
    serverTools: undefined,
    enableWebSearch: undefined,
    enableXSearch: undefined
  });
  assert.equal(config.serverTools, true);
  assert.equal(config.enableWebSearch, true);
  assert.equal(config.enableXSearch, true);
});
