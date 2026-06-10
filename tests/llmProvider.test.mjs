import test from "node:test";
import assert from "node:assert/strict";
import { XaiResponsesProvider, createXaiProvider, XaiHttpError } from "../dist/api/XaiResponsesProvider.js";

function fakeFetch(response, capture, { ok = true, status = 200 } = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    capture.body = JSON.parse(init.body);
    return {
      ok,
      status,
      json: async () => response,
      text: async () => (typeof response === "string" ? response : JSON.stringify(response))
    };
  };
}

function makeProvider(response, capture, opts = {}) {
  return new XaiResponsesProvider({
    apiKey: "test-key",
    model: "grok-test",
    fetchImpl: fakeFetch(response, capture, opts)
  });
}

test("provider POSTs to the xAI responses endpoint with auth and no previous_response_id", async () => {
  const capture = {};
  const provider = makeProvider({ id: "r1", output_text: "hello" }, capture);

  await provider.complete({
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "tool", toolCallId: "c1", content: "{\"ok\":true}" }
    ],
    tools: [],
    toolChoice: "auto"
  });

  assert.match(String(capture.url), /\/v1\/responses$/);
  assert.equal(capture.init.method, "POST");
  assert.equal(capture.init.headers.authorization, "Bearer test-key");
  assert.equal(capture.body.model, "grok-test");
  assert.equal("previous_response_id" in capture.body, false);
  assert.deepEqual(capture.body.input, [
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { type: "function_call_output", call_id: "c1", output: "{\"ok\":true}" }
  ]);
  assert.equal(capture.body.parallel_tool_calls, true);
});

test("provider maps function calls and final text into CompletionResult", async () => {
  const capture = {};
  const response = {
    id: "r2",
    output: [
      { type: "function_call", name: "read_file_range", call_id: "c9", arguments: "{\"path\":\"a.ts\"}" },
      { type: "message", content: [{ text: "done" }] }
    ],
    usage: { input_tokens: 1200, output_tokens: 50, input_tokens_details: { cached_tokens: 1000 } }
  };
  const provider = makeProvider(response, capture);

  const result = await provider.complete({ messages: [], tools: [], toolChoice: "auto" });

  assert.equal(result.id, "r2");
  assert.equal(result.text, "done");
  assert.deepEqual(result.toolCalls, [{ id: "c9", name: "read_file_range", argsJson: "{\"path\":\"a.ts\"}" }]);
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 50, cachedInputTokens: 1000 });
  assert.deepEqual(result.warnings, []);
});

test("provider surfaces parse anomalies as warnings instead of dropping them", async () => {
  const capture = {};
  const response = {
    output: [
      { type: "function_call", name: "a", call_id: "c1", arguments: "{}" },
      { type: "function_call", name: "b", call_id: "c2", arguments: "{}" }
    ]
  };
  const provider = makeProvider(response, capture);

  const result = await provider.complete({ messages: [], tools: [], toolChoice: "auto" });

  assert.ok(result.warnings.some((w) => /missing an id/.test(w)));
  assert.ok(result.warnings.some((w) => /2 tool calls in one turn/.test(w)));
});

test("non-2xx responses throw XaiHttpError with status and body", async () => {
  const capture = {};
  const provider = makeProvider("upstream overloaded", capture, { ok: false, status: 503 });

  await assert.rejects(
    () => provider.complete({ messages: [], tools: [], toolChoice: "auto" }),
    (err) => {
      assert.ok(err instanceof XaiHttpError);
      assert.equal(err.status, 503);
      assert.match(err.message, /status=503/);
      assert.match(err.message, /upstream overloaded/);
      return true;
    }
  );
});

test("createXaiProvider reads XAI_API_KEY from the environment", async () => {
  const previous = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "env-key";
  try {
    const capture = {};
    const provider = createXaiProvider({ model: "grok-test", fetchImpl: fakeFetch({ id: "r", output_text: "x" }, capture) });
    await provider.complete({ messages: [], tools: [], toolChoice: "auto" });
    assert.equal(capture.init.headers.authorization, "Bearer env-key");
  } finally {
    if (previous === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previous;
  }
});

test("createXaiProvider throws a helpful error when the key is missing", () => {
  const previous = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;
  try {
    assert.throws(() => createXaiProvider({ model: "grok-test" }), /Missing XAI_API_KEY/);
  } finally {
    if (previous !== undefined) process.env.XAI_API_KEY = previous;
  }
});

test("capabilities expose server tools and prompt caching", () => {
  const provider = new XaiResponsesProvider({ apiKey: "k", model: "grok-test" });
  assert.deepEqual(provider.capabilities.serverTools, ["web_search", "x_search"]);
  assert.equal(provider.capabilities.promptCaching, true);
});
