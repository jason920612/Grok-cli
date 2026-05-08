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

// Simulates Grok outputting reasoning text alongside a tool call in the same turn.
function responseWithToolAndText(id, call, text) {
  return { id, output: [call], output_text: text };
}

function makeLoop({ responses, config = {}, execute, isReadOnly, contextItems = [] } = {}) {
  const payloads = [];
  const toolCalls = [];
  const upsertCalls = [];
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
      enableIntermediateVerifier: false,
      intermediateAuditMaxPerLoop: 5,
      ...config
    },
    {
      upsert(id, item) { upsertCalls.push({ id, ...item }); },
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
  return { loop, payloads, toolCalls, upsertCalls };
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

test("repeated empty search_symbols results are blocked with a strategy correction", async () => {
  const { loop, toolCalls } = makeLoop({
    responses: [
      responseWithTool("r1", functionCall("search_symbols", { query: "verifier" }, "c1")),
      responseWithTool("r2", functionCall("search_symbols", { query: "hybrid" }, "c2")),
      responseWithTool("r3", functionCall("search_symbols", { query: "conversation-mode" }, "c3")),
      responseWithTool("r4", functionCall("search_symbols", { query: "stateless" }, "c4")),
      responseWithText("r5", "done")
    ],
    isReadOnly(name) {
      return name === "search_symbols";
    },
    execute(name) {
      if (name === "search_symbols") return { ok: true, data: { results: [] }, summary: "no symbols" };
      return { ok: true, data: {}, summary: "ok" };
    }
  });

  const output = await loop.run("find hybrid verifier issue", true);

  assert.equal(toolCalls.filter((call) => call.name === "search_symbols").length, 3);
  assert.match(output, /search_symbols has returned unproductive results 3 times/);
  assert.match(output, /Switch strategy: use search_text for string values/);
  assert.match(output, /list_files with a concrete subdirectory/);
});

test("verifier audits zero-tool final answers and reports retry exhaustion", async () => {
  const { loop, payloads } = makeLoop({
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

test("intermediate verifier detects assumptions and injects warning into context and stateful pendingInput", async () => {
  const auditVerdict = JSON.stringify({
    hasUnsupportedAssumptions: true,
    unsupportedAssumptions: [
      {
        claim: "The config uses UTC timestamps",
        whyUnsupported: "No file read confirms timezone setting",
        requiredVerification: "read_file_range config.ts"
      }
    ],
    requiredNextActions: ["read_file_range config.ts"]
  });

  let auditPayload;
  // payloads sequence: [executor-step1, audit, executor-step2]
  const { loop, payloads, upsertCalls } = makeLoop({
    config: { enableIntermediateVerifier: true, intermediateAuditMaxPerLoop: 5 },
    responses: [
      // executor turn 1: reasoning text accompanies tool call (real Grok behavior)
      responseWithToolAndText("r1", functionCall("read_file_range", { path: "src/formatter.ts" }, "c1"), "The config likely uses UTC timestamps."),
      // intermediate audit call (parallel_tool_calls: false, no tools field)
      (payload) => {
        auditPayload = payload;
        return responseWithText("a1", auditVerdict);
      },
      // executor turn 2: sees warning injected into pendingInput, gives final answer
      responseWithText("r2", "done")
    ],
    isReadOnly(name) { return name === "read_file_range"; },
    execute(name, args) { return { ok: true, data: {}, summary: `read ${args.path}` }; }
  });

  const output = await loop.run("fix timestamp formatting", true);

  // Audit call must be a stateless verifier call (no tools, parallel_tool_calls: false)
  assert.ok(auditPayload, "intermediate audit API call should have been made");
  assert.equal("tools" in auditPayload, false);
  assert.equal(auditPayload.parallel_tool_calls, false);
  assert.match(JSON.stringify(auditPayload.input), /<accumulated_evidence>/);
  assert.match(JSON.stringify(auditPayload.input), /<executor_reasoning_this_turn>/);

  // Warning must be upserted into context
  const warning = upsertCalls.find((c) => c.id === "intermediate-assumption-warning");
  assert.ok(warning, "assumption warning should be upserted into context");
  assert.equal(warning.type, "intermediate_assumption_warning");
  assert.match(warning.content, /The config uses UTC timestamps/);
  assert.equal(warning.expiresAfterSteps, 3);

  // In stateful mode the warning must also appear in the next executor turn's input
  // payloads[0]=executor-step1, payloads[1]=audit, payloads[2]=executor-step2
  const step2Payload = payloads[2];
  assert.match(JSON.stringify(step2Payload.input), /Intermediate Audit/);

  assert.match(output, /done/);
});

test("intermediate verifier fails open on API error and does not block the loop", async () => {
  const { loop, upsertCalls } = makeLoop({
    config: { enableIntermediateVerifier: true, intermediateAuditMaxPerLoop: 5 },
    responses: [
      // executor turn 1: reasoning text + tool call
      responseWithToolAndText("r1", functionCall("read_file_range", { path: "src/foo.ts" }, "c1"), "The function looks fine."),
      // intermediate audit call throws — should be caught and treated as no assumptions
      () => { throw new Error("audit API timeout"); },
      // executor turn 2: continues normally
      responseWithText("r2", "done")
    ],
    isReadOnly(name) { return name === "read_file_range"; },
    execute() { return { ok: true, data: {}, summary: "ok" }; }
  });

  const output = await loop.run("check foo", true);

  // No warning injected on API failure
  assert.equal(upsertCalls.filter((c) => c.id === "intermediate-assumption-warning").length, 0);
  // Loop completed normally despite audit error
  assert.match(output, /done/);
});

test("intermediate verifier is skipped when disabled", async () => {
  let auditCalled = false;
  const { loop, upsertCalls } = makeLoop({
    config: { enableIntermediateVerifier: false },
    responses: [
      responseWithTool("r1", functionCall("read_file_range", { path: "src/foo.ts" }, "c1")),
      (payload) => {
        // If an audit call is made it would have parallel_tool_calls: false and no tools
        if (!("tools" in payload) && payload.parallel_tool_calls === false) auditCalled = true;
        return responseWithText("r2", "done");
      }
    ],
    isReadOnly(name) { return name === "read_file_range"; },
    execute() { return { ok: true, data: {}, summary: "ok" }; }
  });

  await loop.run("check foo", true);

  assert.equal(auditCalled, false, "audit should not be called when disabled");
  assert.equal(upsertCalls.filter((c) => c.id === "intermediate-assumption-warning").length, 0);
});

test("intermediate verifier respects max audit cap per loop", async () => {
  let auditCallCount = 0;
  const noAssumptions = JSON.stringify({ hasUnsupportedAssumptions: false, unsupportedAssumptions: [], requiredNextActions: [] });
  const isAuditCall = (payload) => !("tools" in payload) && payload.parallel_tool_calls === false;

  // cap=2, 4 tool-call turns: only the first 2 trigger an audit call
  // responses order: exec1, audit1, exec2, audit2, exec3, exec4, final
  const { loop } = makeLoop({
    config: { enableIntermediateVerifier: true, intermediateAuditMaxPerLoop: 2, maxSteps: 12 },
    responses: [
      responseWithToolAndText("r0", functionCall("read_file_range", { path: "src/f0.ts" }, "c0"), "reasoning 0"),
      (payload) => { if (isAuditCall(payload)) auditCallCount++; return responseWithText("a0", noAssumptions); },
      responseWithToolAndText("r1", functionCall("read_file_range", { path: "src/f1.ts" }, "c1"), "reasoning 1"),
      (payload) => { if (isAuditCall(payload)) auditCallCount++; return responseWithText("a1", noAssumptions); },
      responseWithToolAndText("r2", functionCall("read_file_range", { path: "src/f2.ts" }, "c2"), "reasoning 2"),
      responseWithToolAndText("r3", functionCall("read_file_range", { path: "src/f3.ts" }, "c3"), "reasoning 3"),
      responseWithText("final", "done")
    ],
    isReadOnly(name) { return name === "read_file_range"; },
    execute() { return { ok: true, data: {}, summary: "ok" }; }
  });

  await loop.run("inspect files", true);

  assert.equal(auditCallCount, 2, "audit should stop after intermediateAuditMaxPerLoop");
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
