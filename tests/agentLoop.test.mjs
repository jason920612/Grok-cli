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

function makeLoop({ responses, config = {}, execute, isReadOnly } = {}) {
  const payloads = [];
  const toolCalls = [];
  let index = 0;
  const client = {
    responses: {
      create: async (payload) => {
        payloads.push(payload);
        return responses[index++] ?? responseWithText(`r${index}`, "done");
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
      ...config
    },
    {
      upsert() {},
      nextStep() {},
      relevant() {
        return [];
      },
      add() {}
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
  return { loop, payloads, toolCalls };
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
