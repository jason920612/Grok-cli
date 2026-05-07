import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop, shouldContinueAfterPlanOnlyResponse } from "../dist/agent/AgentLoop.js";

// --- response shape helpers ---

function toolCallResp(name, callId, args = "{}") {
  return { id: `r-${callId}`, output: [{ type: "function_call", name, call_id: callId, arguments: args }] };
}

function multiToolResp(...calls) {
  return {
    id: "r-multi",
    output: calls.map(([name, callId, args]) => ({
      type: "function_call", name, call_id: callId, arguments: args ?? "{}"
    }))
  };
}

function textResp(text) {
  return { id: "r-text", output: [{ type: "message", content: [{ text }] }] };
}

function emptyResp() {
  return { id: "r-empty", output: [] };
}

// --- mock infrastructure ---

function makeSeqClient(sequence) {
  let i = 0;
  const calls = [];
  return {
    calls,
    api: {
      responses: {
        create: async (payload) => {
          calls.push(payload);
          return sequence[Math.min(i++, sequence.length - 1)];
        }
      }
    }
  };
}

function makeBackground() {
  return { listRunning: () => [], stopAll: async () => [], list: () => [] };
}

function makeTools(execFn) {
  return {
    schemas: () => [],
    isReadOnly: () => false,
    execute: execFn ?? (async () => ({ ok: true, data: {}, summary: "ok" }))
  };
}

function makeContext() {
  return { upsert: () => {}, nextStep: () => {}, add: () => {}, relevant: () => [] };
}

function makeConfig(overrides = {}) {
  return {
    model: "test-model",
    approval: "never",
    toolChoice: "auto",
    maxSteps: 10,
    serverTools: false,
    enableWebSearch: false,
    enableXSearch: false,
    workspaceRoot: "/tmp",
    sandboxProfile: "default",
    workspaceTrusted: false,
    conversationMode: "stateless",
    hybridResetAfterSteps: 10,
    hybridResetAfterFailures: 3,
    enableVerifier: false,
    verifierModel: "test-model",
    maxVerifierReprompts: 2,
    ...overrides
  };
}

function makeLoop(mock, configOverrides = {}, toolExecFn) {
  const bg = makeBackground();
  const toolCtx = { background: bg, sandbox: null };
  const skillLoader = { select: () => [] };
  const toolSkills = { toolIndex: () => "", select: () => [] };
  return new AgentLoop(
    mock.api,
    makeConfig(configOverrides),
    makeContext(),
    makeTools(toolExecFn),
    toolCtx,
    skillLoader,
    toolSkills,
    ""
  );
}

// --- shouldContinueAfterPlanOnlyResponse unit tests ---

test("shouldContinueAfterPlanOnlyResponse: true for intent on action task with no prior actions", () => {
  assert.equal(
    shouldContinueAfterPlanOnlyResponse("I'll now call the tool to fix this.", "fix the bug in main.ts", 0),
    true
  );
});

test("shouldContinueAfterPlanOnlyResponse: false when actions already taken", () => {
  assert.equal(
    shouldContinueAfterPlanOnlyResponse("I'll now call the tool to fix this.", "fix the bug in main.ts", 1),
    false
  );
});

test("shouldContinueAfterPlanOnlyResponse: false for non-action task", () => {
  assert.equal(
    shouldContinueAfterPlanOnlyResponse("I'll now use a tool to demonstrate.", "explain how closures work", 0),
    false
  );
});

test("shouldContinueAfterPlanOnlyResponse: false for empty text", () => {
  assert.equal(shouldContinueAfterPlanOnlyResponse("", "fix the bug", 0), false);
});

// --- AgentLoop integration tests ---

test("stateless mode never sends previous_response_id", async () => {
  const mock = makeSeqClient([
    toolCallResp("run_shell", "c1", '{"command":"echo hi","reason":"test"}'),
    textResp("Done.")
  ]);
  const loop = makeLoop(mock, { conversationMode: "stateless" });
  await loop.run("run echo hi", false);
  for (let i = 0; i < mock.calls.length; i++) {
    assert.equal(
      mock.calls[i].previous_response_id,
      undefined,
      `Call ${i} must not have previous_response_id in stateless mode`
    );
  }
});

test("multi-tool non-final responses are rejected with one-tool correction", async () => {
  const mock = makeSeqClient([
    multiToolResp(
      ["run_shell", "c1", '{"command":"ls","reason":"a"}'],
      ["run_shell", "c2", '{"command":"pwd","reason":"b"}']
    ),
    toolCallResp("run_shell", "c3", '{"command":"ls","reason":"ok"}'),
    textResp("Done.")
  ]);
  const loop = makeLoop(mock);
  await loop.run("list files", false);

  assert.ok(mock.calls.length >= 2, "Should make at least 2 API calls");
  const correctionInput = mock.calls[1]?.input ?? "";
  assert.ok(
    typeof correctionInput === "string" && correctionInput.includes("exactly one tool call"),
    `Expected 'exactly one tool call' in correction, got: ${String(correctionInput).slice(0, 300)}`
  );
});

test("narrated intent fails closed after reprompt budget is exhausted", async () => {
  const intentText = "I'll now call the tool to fix this.";
  // Always return intent-only text; loop must stop rather than accept it
  const mock = makeSeqClient([textResp(intentText)]);
  const loop = makeLoop(mock, { conversationMode: "stateless", maxSteps: 10 });
  const result = await loop.run("fix the bug in main.ts", false);
  assert.ok(
    result.includes("[agent stopped:"),
    `Expected stopped message, got: ${result.slice(0, 300)}`
  );
});

test("empty response retries once then stops gracefully", async () => {
  const mock = makeSeqClient([emptyResp()]);
  const loop = makeLoop(mock);
  const result = await loop.run("do something", false);
  assert.equal(mock.calls.length, 2, "Should call API twice (initial + one retry)");
  assert.ok(
    result.includes("[agent stopped: repeated empty responses"),
    `Got: ${result.slice(0, 300)}`
  );
});

test("same failed tool+args is blocked on blind retry", async () => {
  const failArgs = '{"command":"npm test","reason":"run tests"}';
  const mock = makeSeqClient([
    toolCallResp("run_shell", "c1", failArgs),          // step 1 — tool fails
    toolCallResp("run_shell", "c2", failArgs),          // step 2 — blind retry → blocked
    toolCallResp("run_shell", "c3", '{"command":"npm test --force","reason":"retry"}'),
    textResp("Done.")
  ]);
  const toolExec = async (_name, args) => {
    if (args.command === "npm test") return { ok: false, error: { message: "exit 1" } };
    return { ok: true, data: {}, summary: "ok" };
  };
  const loop = makeLoop(mock, {}, toolExec);
  await loop.run("run tests", false);

  // The 3rd API call (after blind retry block) must contain the correction
  const correctionInput = mock.calls[2]?.input ?? "";
  assert.ok(
    typeof correctionInput === "string" && correctionInput.includes("BLIND RETRY BLOCKED"),
    `Expected BLIND RETRY BLOCKED in 3rd call, got: ${String(correctionInput).slice(0, 300)}`
  );
});

test("failure context is injected into next prompt after tool failure", async () => {
  const mock = makeSeqClient([
    toolCallResp("run_shell", "c1", '{"command":"fail-cmd","reason":"test"}'),
    textResp("I see the previous command failed, I'll take a different approach.")
  ]);
  const toolExec = async () => ({ ok: false, error: { message: "command not found" } });
  const loop = makeLoop(mock, { conversationMode: "stateless" }, toolExec);
  await loop.run("run command", false);

  // Step 2 prompt is rebuilt from snapshot — must include failure warning
  const step2Input = mock.calls[1]?.input ?? "";
  assert.ok(
    typeof step2Input === "string" && step2Input.includes("MUST NOT repeat blindly"),
    `Expected failure context in step 2 prompt, got: ${String(step2Input).slice(0, 400)}`
  );
});

test("memory facts include provenance and confidence labels in prompt", async () => {
  const mock = makeSeqClient([
    toolCallResp("read_file_range", "c1", '{"path":"src/foo.ts","start":1,"end":10}'),
    textResp("The file contains the fix.")
  ]);
  const toolExec = async () => ({ ok: true, data: { content: "export const x = 1;" }, summary: "read ok" });
  const loop = makeLoop(mock, { conversationMode: "stateless" }, toolExec);
  await loop.run("read the file", false);

  // Step 2 prompt includes snapshot with [VERIFIED] label
  const step2Input = mock.calls[1]?.input ?? "";
  assert.ok(
    typeof step2Input === "string" && step2Input.includes("[VERIFIED]"),
    `Expected [VERIFIED] confidence label in prompt, got: ${String(step2Input).slice(0, 400)}`
  );
});
