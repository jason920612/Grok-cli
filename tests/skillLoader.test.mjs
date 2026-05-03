import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SkillLoader } from "../dist/skills/SkillLoader.js";
import { ContextManager } from "../dist/context/ContextManager.js";
import { buildModelInput } from "../dist/agent/modelInputBuilder.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";
import { LOCAL_TOOL_NAMES, createLocalToolRegistry } from "../dist/tools/definitions/index.js";
import { ApprovalPolicy, classifyPatchRisk } from "../dist/approval/ApprovalPolicy.js";
import { classifyCommand } from "../dist/approval/RiskClassifier.js";
import { formatApprovalPrompt } from "../dist/approval/promptApproval.js";
import { shouldContinueAfterPlanOnlyResponse } from "../dist/agent/AgentLoop.js";
import { CORE_SYSTEM_PROMPT } from "../dist/agent/prompts.js";
import { loadConfig } from "../dist/config/loadConfig.js";
import { parseResponse } from "../dist/api/responseParser.js";
import { parseMaxSteps, parseSandboxProfile, parseServerToolOverrides } from "../dist/cli.js";
import { SLASH_COMMANDS, visibleSlashCommands } from "../dist/ui/slashCommands.js";

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

test("built-in skills load when target workspace is not the package checkout", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-external-workspace-"));
  const loader = new SkillLoader(workspace);
  const skill = loader.loadAll().find((item) => item.id === "tree-based-code-navigation");
  assert.ok(skill);
  assert.match(skill.content, /Search before reading/);
});

test("built-in tool skills load when target workspace is not the package checkout", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "grok-external-workspace-"));
  const toolSkills = new ToolSkillRegistry(workspace);
  toolSkills.loadBuiltin(["read_file_range"]);
  const skill = toolSkills.get("read_file_range");
  assert.match(skill.full, /Read precise file ranges/);
  assert.doesNotMatch(skill.full, /Use read_file_range carefully with narrow scope/);
});

test("coding tasks select tree-based code navigation", () => {
  const loader = new SkillLoader(root);
  const selected = loader.select("debug a failing test with a stack trace and modify code");
  assert.ok(selected.some((skill) => skill.id === "tree-based-code-navigation"));
});

test("commit and push tasks select git workflow skill", () => {
  const loader = new SkillLoader(root);
  const selected = loader.select("write commit and push");
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
  assert.equal(tools.isReadOnly("search_code"), true);
  assert.equal(tools.isReadOnly("git_diff"), true);
  assert.equal(tools.isReadOnly("apply_patch"), false);
  assert.equal(tools.isReadOnly("run_shell"), false);
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

test("Windows destructive delete commands are hard-denied", () => {
  assert.equal(classifyCommand("Remove-Item -LiteralPath dist -Recurse -Force"), "deny");
  assert.equal(classifyCommand("Remove-Item -Force -Recurse dist"), "deny");
  assert.equal(classifyCommand("Remove-Item -r -f dist"), "deny");
  assert.equal(classifyCommand("del /s /q dist"), "deny");
  assert.equal(classifyCommand("rmdir /s /q dist"), "deny");
  assert.equal(classifyCommand("rd /q /s dist"), "deny");
});

test("plan-only retry detection handles Chinese action tasks", () => {
  assert.equal(
    shouldContinueAfterPlanOnlyResponse("\u6211\u6703\u5148\u7528\u5de5\u5177\u6aa2\u67e5\uff0c\u63a5\u8457\u4fee\u6539\u3002", "\u8acb\u4fee bug \u4e26\u57f7\u884c\u6e2c\u8a66", 0),
    true
  );
  assert.equal(
    shouldContinueAfterPlanOnlyResponse("\u6211\u53ef\u4ee5\u63d0\u4f9b\u4e00\u4e9b\u5efa\u8b70\u3002", "\u8acb\u4fee bug", 1),
    false
  );
  assert.equal(
    shouldContinueAfterPlanOnlyResponse("I will use tools to inspect the project.", "explain the project structure", 0),
    false
  );
  assert.equal(
    shouldContinueAfterPlanOnlyResponse("I will use tools to inspect the issue.", "open pr for the fix", 0),
    true
  );
});

test("patch approval classifies higher-risk patch metadata", async () => {
  const safePatch = { files: [{ path: "src/example.ts", operation: "modify", additions: 3, deletions: 1 }] };
  const packagePatch = { files: [{ path: "package.json", operation: "modify", additions: 1, deletions: 1 }] };
  const deletePatch = { files: [{ path: "src/old.ts", operation: "delete", additions: 0, deletions: 20 }] };
  const largeDeletionPatch = { files: [{ path: "src/big.ts", operation: "modify", additions: 0, deletions: 101 }] };

  assert.equal(classifyPatchRisk(safePatch), "safe");
  assert.equal(classifyPatchRisk(packagePatch), "ask");
  assert.equal(classifyPatchRisk(deletePatch), "ask");
  assert.equal(classifyPatchRisk(largeDeletionPatch), "ask");

  const autoSafe = new ApprovalPolicy("auto-safe");
  assert.equal(await autoSafe.approvePatch("safe patch", safePatch), true);
  assert.equal(await autoSafe.approvePatch("package patch", packagePatch), false);

  const autoLocal = new ApprovalPolicy("auto-local");
  assert.equal(await autoLocal.approvePatch("package patch", packagePatch), true);
});

test("approval prompt summarizes decision details without invoking skills", () => {
  const prompt = formatApprovalPrompt("npm install", "install local dependencies", "network", {
    operation: "run shell command",
    policy: "on-request",
    scope: "workspace shell",
    rememberKey: "foreground:network:npm install",
    files: [{ path: "package.json", operation: "modify", additions: 1, deletions: 1 }]
  });

  assert.match(prompt, /Approval required/);
  assert.match(prompt, /Operation:.*run shell command/);
  assert.match(prompt, /Policy:.*on-request/);
  assert.match(prompt, /Remember rule:.*foreground:network:npm install/);
  assert.match(prompt, /modify package\.json \(\+1\/-1\)/);
});

test("help shows a focused slash command set while aliases remain registered", () => {
  const visible = visibleSlashCommands().map((command) => command.name);
  const all = SLASH_COMMANDS.map((command) => command.name);

  assert.ok(visible.includes("/help"));
  assert.ok(visible.includes("/approval"));
  assert.ok(visible.includes("/skills"));
  assert.ok(all.includes("/workspace"));
  assert.equal(visible.includes("/workspace"), false);
  assert.equal(visible.includes("/tools"), false);
  assert.equal(visible.includes("/env"), false);
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
  assert.equal(config.workspaceTrusted, false);
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

test("negative server-side search flags map to explicit config overrides", () => {
  assert.deepEqual(parseServerToolOverrides([]), {
    serverTools: undefined,
    enableWebSearch: undefined,
    enableXSearch: undefined
  });
  assert.deepEqual(parseServerToolOverrides(["--no-web-search"]), {
    serverTools: undefined,
    enableWebSearch: false,
    enableXSearch: undefined
  });
  assert.deepEqual(parseServerToolOverrides(["--no-server-tools", "--no-x-search"]), {
    serverTools: false,
    enableWebSearch: undefined,
    enableXSearch: false
  });
});

test("CLI max steps parser accepts only positive integers", () => {
  assert.equal(parseMaxSteps(undefined), undefined);
  assert.equal(parseMaxSteps("1"), 1);
  assert.equal(parseMaxSteps("30"), 30);
  assert.throws(() => parseMaxSteps("0"), /--max-steps must be a positive integer/);
  assert.throws(() => parseMaxSteps("-1"), /--max-steps must be a positive integer/);
  assert.throws(() => parseMaxSteps("1.5"), /--max-steps must be a positive integer/);
  assert.throws(() => parseMaxSteps("abc"), /--max-steps must be a positive integer/);
});

test("CLI sandbox profile parser accepts known profiles only", () => {
  assert.equal(parseSandboxProfile(undefined), undefined);
  assert.equal(parseSandboxProfile("default"), "default");
  assert.equal(parseSandboxProfile("test"), "test");
  assert.throws(() => parseSandboxProfile("wide-open"), /--profile must be one of/);
});
