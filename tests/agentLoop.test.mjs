import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../dist/agent/AgentLoop.js";
import { TOOL_EFFECTS } from "../dist/tools/toolEffects.js";

function functionCall(name, args = {}, callId = `call-${name}`) {
  return { type: "function_call", name, call_id: callId, arguments: JSON.stringify(args) };
}
function responseWithTool(id, call) {
  return { id, output: [call] };
}
function responseWithTools(id, calls) {
  return { id, output: calls };
}
function responseWithText(id, text) {
  return { id, output_text: text };
}

function toResult(raw) {
  const output = Array.isArray(raw.output) ? raw.output : [];
  const toolCalls = output
    .filter((o) => o.type === "function_call")
    .map((o) => ({ id: o.call_id, name: o.name, argsJson: o.arguments ?? "{}" }));
  let text = raw.output_text ?? "";
  for (const o of output) {
    if (o.type === "message" && Array.isArray(o.content)) {
      for (const c of o.content) if (typeof c.text === "string") text = text ? `${text}\n${c.text}` : c.text;
    }
  }
  return { id: raw.id ?? "", text: (text || "").trim(), toolCalls, usage: undefined, warnings: [] };
}

function effectsFor(name) {
  return TOOL_EFFECTS[name] ?? { readOnly: false, modifiesWorkspace: false, isShell: false, countsAsProgress: true };
}

function makeLoop({ responses, config = {}, execute, isReadOnly, contextItems = [] } = {}) {
  const requests = [];
  const toolCalls = [];
  const storedContextItems = [...contextItems];
  const usedNames = new Set();
  let index = 0;
  const provider = {
    id: "test-model",
    capabilities: { serverTools: [], promptCaching: true },
    async complete(req) {
      requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      const next = responses[index++];
      const raw = typeof next === "function" ? next(req) : next;
      return toResult(raw ?? responseWithText(`r${index}`, "done"));
    }
  };
  const loop = new AgentLoop(
    provider,
    {
      model: "test-model",
      toolChoice: "auto",
      maxSteps: 6,
      serverTools: false,
      enableWebSearch: false,
      enableXSearch: false,
      enableVerifier: false,
      verifierMaxRetries: 2,
      ...config
    },
    {
      upsert(id, item) {
        const i = storedContextItems.findIndex((e) => e.id === id);
        const full = { ...item, id, tokensEstimate: item.tokensEstimate ?? 1 };
        if (i === -1) storedContextItems.push(full);
        else storedContextItems[i] = full;
        return full;
      },
      nextStep() {},
      relevant() {
        return storedContextItems;
      },
      list() {
        return storedContextItems;
      },
      add(item) {
        storedContextItems.push(item);
        return item;
      }
    },
    {
      schemas() {
        return [];
      },
      isReadOnly(name) {
        return isReadOnly?.(name) ?? false;
      },
      list() {
        return [...usedNames].map((name) => ({ name, effects: effectsFor(name) }));
      },
      async execute(name, args) {
        usedNames.add(name);
        toolCalls.push({ name, args });
        if (name === "git_diff") return { ok: true, data: { stat: "", diff: "" }, summary: "" };
        if (name === "git_status") return { ok: true, data: {}, summary: "" };
        return execute?.(name, args) ?? { ok: true, data: {}, summary: "ok" };
      }
    },
    { background: { listRunning() { return []; }, async stopAll() { return []; } } },
    { select() { return []; }, projectInstructions() { return ""; } },
    { toolIndex() { return ""; }, select() { return []; } },
    ""
  );
  // ensure list() can see tools the executor touches even before execution
  loop.__used = usedNames;
  return { loop, requests, toolCalls, contextItems: storedContextItems, usedNames };
}

function allInput(req) {
  return req.messages
    .map((m) => ("content" in m ? m.content : `${m.role}:${m.name} ${m.argsJson ?? ""}`))
    .join("\n");
}

test("plan-only reprompt is appended to the transcript as a user message", async () => {
  const { loop, requests } = makeLoop({
    responses: [responseWithText("r1", "I will now use tools to inspect it."), responseWithText("r2", "done")]
  });
  await loop.run("fix bug", true);
  assert.equal(requests.length, 2);
  // the second request's transcript contains the prior assistant turn + the reprompt
  assert.match(allInput(requests[1]), /You provided a plan but did not request any function_call tools/);
  assert.match(allInput(requests[1]), /I will now use tools to inspect it\./);
});

test("transcript carries the tool call and its result forward to the next step", async () => {
  const { loop, requests } = makeLoop({
    responses: [
      responseWithTool("r1", functionCall("read_file_range", { path: "src/parser.ts", startLine: 1, endLine: 20 }, "c1")),
      responseWithText("r2", "done")
    ],
    isReadOnly: (n) => n === "read_file_range",
    execute: (n, a) => ({ ok: true, data: {}, summary: `${n} ${a.path}` })
  });
  await loop.run("inspect parser", true);
  const second = requests[1];
  // the model's tool call and the tool result are both present in the transcript
  assert.ok(second.messages.some((m) => m.role === "tool_call" && m.name === "read_file_range"));
  assert.ok(second.messages.some((m) => m.role === "tool" && /read_file_range src\/parser\.ts/.test(m.content)));
  // first request is just system + task (no premature tool turns)
  assert.deepEqual(requests[0].messages.map((m) => m.role), ["system", "user"]);
});

test("failed shell verification command can rerun after a successful patch", async () => {
  const { loop, toolCalls } = makeLoop({
    responses: [
      responseWithTool("r1", functionCall("run_python", { code: "import subprocess; subprocess.run(['npm','test'])" }, "c1")),
      responseWithTool("r2", functionCall("apply_patch", { patch: "x" }, "c2")),
      responseWithTool("r3", functionCall("run_python", { code: "import subprocess; subprocess.run(['npm','test'])" }, "c3")),
      responseWithText("r4", "final")
    ],
    execute: (name) => {
      if (name === "run_python") return { ok: true, data: { exitCode: 1, stdout: "fail" }, summary: "exit 1" };
      if (name === "apply_patch") return { ok: true, data: {}, summary: "patched" };
      return { ok: true, data: {}, summary: "ok" };
    }
  });
  const output = await loop.run("fix failing tests", true);
  assert.equal(toolCalls.filter((c) => c.name === "run_python").length, 2);
  assert.doesNotMatch(output, /repeated_failure_blocked/);
});

test("repeated failure guard blocks identical read-only failures", async () => {
  const { loop, toolCalls } = makeLoop({
    responses: [
      responseWithTool("r1", functionCall("read_file_range", { path: "missing.ts" }, "c1")),
      responseWithTool("r2", functionCall("read_file_range", { path: "missing.ts" }, "c2")),
      responseWithText("r3", "final")
    ],
    isReadOnly: (n) => n === "read_file_range",
    execute: () => ({ ok: false, error: { code: "not_found", message: "missing.ts not found" } })
  });
  const output = await loop.run("inspect missing file", true);
  assert.equal(toolCalls.length, 1);
  assert.match(output, /repeated_failure_blocked/);
});

test("repeated failure guard records malformed tool arguments", async () => {
  const bad = { type: "function_call", name: "read_file_range", call_id: "bad", arguments: "{" };
  const { loop, toolCalls } = makeLoop({
    responses: [responseWithTool("r1", bad), responseWithTool("r2", { ...bad, call_id: "bad2" }), responseWithText("r3", "final")],
    isReadOnly: (n) => n === "read_file_range"
  });
  const output = await loop.run("inspect file", true);
  assert.equal(toolCalls.length, 0);
  assert.match(output, /json_parse_error/);
  assert.match(output, /repeated_failure_blocked/);
});

test("multiple tool calls are rejected and corrected before execution", async () => {
  const { loop, requests, toolCalls } = makeLoop({
    responses: [
      responseWithTools("r1", [functionCall("read_file_range", { path: "a.ts" }, "c1"), functionCall("read_file_range", { path: "b.ts" }, "c2")]),
      responseWithText("r2", "done")
    ],
    isReadOnly: (n) => n === "read_file_range"
  });
  await loop.run("inspect files", true);
  assert.equal(toolCalls.length, 0);
  assert.match(allInput(requests[1]), /Invalid response: requested 2 tool calls/);
  assert.match(allInput(requests[1]), /exactly one tool call/);
});

test("repeated identical successful read-only call is blocked (no-progress)", async () => {
  const { loop, toolCalls } = makeLoop({
    responses: [
      responseWithTool("r1", functionCall("list_files", { glob: "**/*.ts" }, "c1")),
      responseWithTool("r2", functionCall("list_files", { glob: "**/*.ts" }, "c2")),
      responseWithText("r3", "done")
    ],
    isReadOnly: (n) => n === "list_files",
    execute: () => ({ ok: true, data: { files: ["a.ts"] }, summary: "1 file" })
  });
  const output = await loop.run("look around", true);
  assert.equal(toolCalls.filter((c) => c.name === "list_files").length, 1, "identical re-list blocked");
  assert.match(output, /repeated_failure_blocked/);
});

test("loop stops after maxSteps when the model never returns a final answer", async () => {
  const { loop, toolCalls } = makeLoop({
    config: { maxSteps: 2 },
    responses: [
      responseWithTool("r1", functionCall("read_file_range", { path: "a.ts" }, "c1")),
      responseWithTool("r2", functionCall("read_file_range", { path: "b.ts" }, "c2")),
      responseWithTool("r3", functionCall("read_file_range", { path: "c.ts" }, "c3"))
    ],
    isReadOnly: (n) => n === "read_file_range",
    execute: (n, a) => ({ ok: true, data: {}, summary: `${n} ${a.path}` })
  });
  const output = await loop.run("keep inspecting forever", true);
  assert.equal(toolCalls.filter((c) => c.name === "read_file_range").length, 2);
  assert.match(output, /Stopped after max steps without a final model message\./);
  assert.match(output, /\[Final checks\]/);
});

test("empty-response guard reprompts once then stops on repeated empty responses", async () => {
  const { loop, requests } = makeLoop({
    config: { maxSteps: 6 },
    responses: [responseWithText("r1", ""), responseWithText("r2", "")]
  });
  const output = await loop.run("do something", true);
  assert.equal(requests.length, 2);
  assert.match(allInput(requests[1]), /Your previous response was empty/);
  assert.match(output, /\[Agent stopped: model returned repeated empty responses without tool calls or a final answer\.\]/);
});

test("verifier audits zero-tool final answers and reports retry exhaustion", async () => {
  const { loop, contextItems } = makeLoop({
    config: { enableVerifier: true, verifierMaxRetries: 1 },
    responses: [
      responseWithText("r1", "src/agent/Agent.ts exports Agent"),
      (req) => {
        assert.equal(req.parallelToolCalls, false);
        assert.equal(req.toolChoice, "none");
        assert.equal(req.tools.length, 0);
        return responseWithText(
          "v1",
          JSON.stringify({
            verdict: "needs_more_evidence",
            reason: "No tool evidence.",
            unsupportedClaims: ["export claim"],
            unsupportedAssumptions: [],
            missingEvidence: ["read src/agent/Agent.ts"],
            requiredNextActions: ["read_file_range src/agent/Agent.ts"],
            confidence: "high"
          })
        );
      },
      responseWithText("r2", "src/agent/Agent.ts exports Agent")
    ]
  });
  const output = await loop.run("does src/agent/Agent.ts export Agent?", true);
  assert.match(output, /Retry budget exhausted/);
  assert.match(output, /read src\/agent\/Agent\.ts/);
  assert.deepEqual(
    contextItems.filter((i) => i.type === "verification_task").map((i) => i.content),
    ["read_file_range src/agent/Agent.ts"]
  );
});

test("verifier receives runtime memory facts with provenance", async () => {
  const { loop, requests } = makeLoop({
    config: { enableVerifier: true, verifierMaxRetries: 1 },
    contextItems: [
      { type: "file_range", content: "src/agent/Agent.ts:1-3\n1: export class Agent {}", priority: 70, factSource: "tool_output", factConfidence: "verified", source: { path: "src/agent/Agent.ts", startLine: 1, endLine: 3 }, tokensEstimate: 10 },
      { type: "task_summary", content: "The executor thinks Agent is exported.", priority: 60, factSource: "model_inference", factConfidence: "inferred", tokensEstimate: 10 }
    ],
    responses: [
      responseWithText("r1", "src/agent/Agent.ts exports Agent"),
      () =>
        responseWithText(
          "v1",
          JSON.stringify({ verdict: "pass", reason: "ok", unsupportedClaims: [], unsupportedAssumptions: [], missingEvidence: [], requiredNextActions: [], confidence: "high" })
        )
    ]
  });
  await loop.run("does src/agent/Agent.ts export Agent?", true);
  const verifierReq = requests.find((r) => r.toolChoice === "none");
  const input = String(verifierReq.messages[0].content);
  assert.match(input, /<runtime_memory_facts>/);
  assert.match(input, /confidence=verified/);
  assert.match(input, /path=src\/agent\/Agent\.ts/);
  assert.match(input, /confidence=inferred/);
});

test("verifier API failures include diagnostic details in feedback", async () => {
  const apiError = new Error("Connection error.");
  apiError.status = 503;
  apiError.code = "service_unavailable";
  const { loop } = makeLoop({
    config: { enableVerifier: true, verifierMaxRetries: 1 },
    responses: [
      responseWithText("r1", "4"),
      () => {
        throw apiError;
      },
      responseWithText("r2", "4")
    ]
  });
  const output = await loop.run("What is 2+2?", true);
  assert.match(output, /Verifier API call failed: Connection error\./);
  assert.match(output, /status=503/);
  assert.match(output, /code=service_unavailable/);
});
