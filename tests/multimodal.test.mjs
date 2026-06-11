import test from "node:test";
import assert from "node:assert/strict";
import { XaiResponsesProvider } from "../dist/api/XaiResponsesProvider.js";

test("provider sends images as Responses-API input_image content parts", async () => {
  let body;
  const provider = new XaiResponsesProvider({
    apiKey: "k",
    model: "grok-build-0.1",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ id: "r", output: [], usage: {} }) };
    }
  });
  await provider.complete({
    messages: [{ role: "user", content: "what does this UI look like?", images: ["data:image/png;base64,AAAA"] }],
    tools: [],
    toolChoice: "auto"
  });
  const userItem = body.input.find((i) => i.role === "user");
  assert.ok(Array.isArray(userItem.content), "image message content is a parts array");
  assert.ok(userItem.content.some((c) => c.type === "input_text" && c.text === "what does this UI look like?"));
  assert.ok(userItem.content.some((c) => c.type === "input_image" && c.image_url === "data:image/png;base64,AAAA"));
});

test("plain text messages stay a string (no needless content array)", async () => {
  let body;
  const provider = new XaiResponsesProvider({
    apiKey: "k",
    model: "grok-build-0.1",
    fetchImpl: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ id: "r", output: [], usage: {} }) };
    }
  });
  await provider.complete({ messages: [{ role: "user", content: "hello" }], tools: [], toolChoice: "auto" });
  assert.equal(body.input.find((i) => i.role === "user").content, "hello");
});
