import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../dist/agent/AgentLoop.js";

function functionCall(name, args = {}, callId = `call-${name}`) {
  return {
    type: "function_call",
    name,
    call_id: callId,
    arguments: JSON.stringify(args)
  };
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

function makeLoop({ responses, config = {}, execute, isReadOnly, contextItems = [] } = {}) {
  const payloads = [];
  const toolCalls = [];
  const storedContextItems = [...contextItems];
  let index = 0;
  const client = {
    responses: {
      create: async (payload) => {
        payloads.push(payload);
        const next = responses[index++];
        if (typeof next === "function") return next(payload);
        return next ?? responseWithText(`r${index}`, "done");
      }
    }
  };
  const loop = new AgentLoop(
    client,
    {
      model: "test-model",
      toolChoice: "auto",
      maxSteps: 6,
      serverTools: false,
      enableWebSearch: false,
      enableXSearch: false,
      conversationMode: "stateful",
      hybridResetAfterTurns: 10,
      hybridResetAfterFailures: 3,
      enableVerifier: false,
      verifierMaxRetries: 2,
      ...config
    },
    {
      upsert(id, item) {
        const existingIndex = storedContextItems.findIndex((entry) => entry.id === id);
        const full = { ...item, id, tokensEstimate: item.tokensEstimate ?? 1 };
        if (existingIndex === -1) storedContextItems.push(full);
        else storedContextItems[existingIndex] = full;
        return full;
      },
      nextStep() {},
      relevant() {
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
      async execute(name, args) {
        toolCalls.push({ name, args });
        if (name === "git_diff") return { ok: true, data: { stat: "", diff: "" }, summary: "" };
        if (name === "git_status") return { ok: true, data: {}, summary: "" };
        return execute?.(name, args) ?? { ok: true, data: {}, summary: "ok" };
      }
    },
    {
      background: {
        listRunning() {
          return [];
        },
        async stopAll() {
          return [];
        }
      }
    },
    { select() { return []; } },
    {
      toolIndex() {
        return "";
      },
      select() {
        return [];
      }
    },
    ""
  );
  return { loop, payloads, toolCalls, contextItems: storedContextItems };
}

test("stateless plan-only reprompt is injected into the next stateless prompt", async () => {
  const { loop, payloads } = makeLoop({
    config: { conversationMode: "stateless" },
    responses: [
      responseWithText("r1", "I will now use tools to inspect it."),
      responseWithText("r2", "done")
    ]
  });

  await loop.run("fix bug", true);

  assert.equal(payloads.length, 2);
  assert.match(String(payloads[1].input), /You provided a plan but did not request any function_call tools/);
  assert.match(String(payloads[1].input), /<Runtime Feedback>/);
});

test("stateless prompt separates verified facts, prior actions, and inferences", async () => {
  const { loop, payloads } = makeLoop({
    config: { conversationMode: "stateless" },
    contextItems: [
      {
        type: "task_summary",
        content: "Likely needs parser changes.",
        priority: 60,
        factSource: "model_inference",
        factConfidence: "inferred",
        tokensEstimate: 10
      }
    ],
    responses: [
      responseWithTool("r1", functionCall("read_file_range", { path: "src/parser.ts", startLine: 1, endLine: 20 }, "c1")),
      responseWithText("r2", "done")
    ],
    isReadOnly(name) {
      return name === "read_file_range";
    },
    execute(name, args) {
      return { ok: true, data: {}, summary: `${name} ${args.path}` };
    }
  });

  await loop.run("inspect parser", true);

  const secondInput = String(payloads[1].input);
  assert.match(secondInput, /<Situation Memory>/);
  assert.match(secondInput, /Verified workspace \/ runtime observations:/);
  assert.match(secondInput, /read_file_range succeeded: read_file_range src\/parser\.ts/);
  assert.match(secondInput, /Prior local agent actions:/);
  assert.match(secondInput, /step 1: read_file_range/);
  assert.match(secondInput, /Model inferences \/ hypotheses, not verified facts:/);
  assert.match(secondInput, /Likely needs parser changes/);
});

test("failed shell verification command can rerun after a successful patch", async () => {
  const { loop, toolCalls } = makeLoop({
    responses: [
      responseWithTool("r1", functionCall("run_shell", { command: "npm test" }, "c1")),
      responseWithTool("r2", functionCall("apply_patch", { patch: "x" }, "c2")),
      responseWithTool("r3", functionCall("run_shell", { command: "npm test" }, "c3")),
      responseWithText("r4", "final")
    ],
    execute(name) {
      if (name === "run_shell") return { ok: true, data: { exitCode: 1, stdout: "fail" }, summary: "exit 1" };
      if (name === "apply_patch") return { ok: true, data: {}, summary: "patched" };
      return { ok: true, data: {}, summary: "ok" };
    }
  });

  const output = await loop.run("fix failing tests", true);

  assert.equal(toolCalls.filter((call) => call.name === "run_shell").length, 2);
  assert.doesNotMatch(output, /repeated_failure_blocked/);
});

test("repeated failure guard blocks identical read-only failures", async () => {
  const { loop, toolCalls } = makeLoop({
    responses: [
      responseWithTool("r1", functionCall("read_file_range", { path: "missing.ts" }, "c1")),
      responseWithTool("r2", functionCall("read_file_range", { path: "missing.ts" }, "c2")),
      responseWithText("r3", "final")
    ],
    isReadOnly(name) {
      return name === "read_file_range";
    },
    execute() {
      return { ok: false, error: { code: "not_found", message: "missing.ts not found" } };
    }
  });

  const output = await loop.run("inspect missing file", true);

  assert.equal(toolCalls.length, 1);
  assert.match(output, /repeated_failure_blocked/);
});

test("repeated failure guard records malformed tool arguments", async () => {
  const malformedCall = {
    type: "function_call",
    name: "read_file_range",
    call_id: "bad-json",
    arguments: "{"
  };
  const { loop, toolCalls } = makeLoop({
    responses: [
      responseWithTool("r1", malformedCall),
      responseWithTool("r2", { ...malformedCall, call_id: "bad-json-again" }),
      responseWithText("r3", "final")
    ],
    isReadOnly(name) {
      return name === "read_file_range";
    }
  });

  const output = await loop.run("inspect file", true);

  assert.equal(toolCalls.length, 0);
  assert.match(output, /json_parse_error/);
  assert.match(output, /repeated_failure_blocked/);
});

test("multiple tool calls are rejected and corrected before execution", async () => {
  const { loop, payloads, toolCalls } = makeLoop({
    config: { conversationMode: "stateless" },
    responses: [
      responseWithTools("r1", [
        functionCall("read_file_range", { path: "a.ts" }, "c1"),
        functionCall("read_file_range", { path: "b.ts" }, "c2")
      ]),
      responseWithText("r2", "done")
    ],
    isReadOnly(name) {
      return name === "read_file_range";
    }
  });

  await loop.run("inspect files", true);

  assert.equal(toolCalls.length, 0);
  assert.match(String(payloads[1].input), /Invalid response: requested 2 tool calls/);
  assert.match(String(payloads[1].input), /exactly one tool call/);
});

test("hybrid resets conversation after invalid plan-only response", async () => {
  const { loop, payloads } = makeLoop({
    config: { conversationMode: "hybrid" },
    responses: [
      responseWithText("r1", "I will now use tools to inspect it."),
      responseWithText("r2", "done")
    ]
  });

  await loop.run("fix bug", true);

  assert.equal(payloads[1].previous_response_id, undefined);
  assert.match(String(payloads[1].input), /<Current Task>/);
  assert.match(String(payloads[1].input), /<Runtime Feedback>/);
});

test("verifier audits zero-tool final answers and reports retry exhaustion", async () => {
  const { loop, payloads, contextItems } = makeLoop({
    config: { enableVerifier: true, verifierMaxRetries: 1 },
    responses: [
      responseWithText("r1", "src/agent/Agent.ts exports Agent"),
      (payload) => {
        assert.equal("tool_choice" in payload, false);
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

  const verifierPayload = payloads.find((payload) => payload.parallel_tool_calls === false);
  const verifierInput = JSON.stringify(verifierPayload?.input);
  assert.equal("tools" in verifierPayload, false);
  assert.equal("tool_choice" in verifierPayload, false);
  assert.match(String(verifierInput), /No tool calls recorded/);
  assert.match(output, /Retry budget exhausted/);
  assert.match(output, /read src\/agent\/Agent\.ts/);
  assert.deepEqual(
    contextItems
      .filter((item) => item.type === "verification_task")
      .map((item) => item.content),
    ["read_file_range src/agent/Agent.ts"]
  );
});

test("verifier receives runtime memory facts with provenance", async () => {
  const { loop, payloads } = makeLoop({
    config: { enableVerifier: true, verifierMaxRetries: 1 },
    contextItems: [
      {
        type: "file_range",
        content: "src/agent/Agent.ts:1-3\n1: export class Agent {}",
        priority: 70,
        factSource: "tool_output",
        factConfidence: "verified",
        source: { path: "src/agent/Agent.ts", startLine: 1, endLine: 3 },
        tokensEstimate: 10
      },
      {
        type: "task_summary",
        content: "The executor thinks Agent is exported.",
        priority: 60,
        factSource: "model_inference",
        factConfidence: "inferred",
        tokensEstimate: 10
      }
    ],
    responses: [
      responseWithText("r1", "src/agent/Agent.ts exports Agent"),
      (payload) => {
        assert.equal("tool_choice" in payload, false);
        return responseWithText(
          "v1",
          JSON.stringify({
            verdict: "pass",
            reason: "The file_range evidence supports the claim.",
            unsupportedClaims: [],
            unsupportedAssumptions: [],
            missingEvidence: [],
            requiredNextActions: [],
            confidence: "high"
          })
        );
      }
    ]
  });

  await loop.run("does src/agent/Agent.ts export Agent?", true);

  const verifierInput = JSON.stringify(payloads.find((payload) => payload.parallel_tool_calls === false)?.input);
  assert.match(verifierInput, /<runtime_memory_facts>/);
  assert.match(verifierInput, /confidence=verified/);
  assert.match(verifierInput, /path=src\/agent\/Agent\.ts/);
  assert.match(verifierInput, /confidence=inferred/);
});

test("verifier receives visible executor trace as claims not evidence", async () => {
  const { loop, payloads } = makeLoop({
    config: { enableVerifier: true, verifierMaxRetries: 1 },
    responses: [
      responseWithTool("r1", functionCall("read_file_range", { path: "src/agent/Agent.ts", startLine: 1, endLine: 20 }, "c1")),
      responseWithText("r2", "The function already handles null values."),
      (payload) => {
        assert.equal("tool_choice" in payload, false);
        return responseWithText(
          "v1",
          JSON.stringify({
            verdict: "needs_more_evidence",
            reason: "The trace claim lacks supporting evidence.",
            unsupportedClaims: ["The function already handles null values."],
            unsupportedAssumptions: [
              {
                claim: "The function already handles null values.",
                whyUnsupported: "The provided file evidence does not show null handling.",
                requiredVerification: "Read the relevant function body or tests."
              }
            ],
            missingEvidence: ["Relevant function body or test output"],
            requiredNextActions: ["read_file_range around the target function"],
            confidence: "high"
          })
        );
      }
    ],
    isReadOnly(name) {
      return name === "read_file_range";
    },
    execute(name, args) {
      return { ok: true, data: {}, summary: `${name} ${args.path}` };
    }
  });

  await loop.run("check null handling", true);

  const verifierInput = JSON.stringify(payloads.find((payload) => payload.parallel_tool_calls === false)?.input);
  assert.match(verifierInput, /<executor_visible_trace_claims_not_evidence>/);
  assert.match(verifierInput, /The function already handles null values/);
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
