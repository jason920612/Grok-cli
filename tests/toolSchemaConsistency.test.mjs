import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createLocalToolRegistry } from "../dist/tools/definitions/index.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";
import { assertSchemaMatchesZod } from "../dist/tools/toolSchemas.js";

test("all local tools have JSON/Zod schemas that agree (no drift)", () => {
  // Constructing the registry runs assertSchemaMatchesZod for every tool.
  assert.doesNotThrow(() => createLocalToolRegistry(new ToolSkillRegistry(process.cwd())));
});

test("assertSchemaMatchesZod catches property-name drift", () => {
  const json = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
  const zodObj = z.object({ b: z.string() });
  assert.throws(() => assertSchemaMatchesZod("x", json, zodObj), /schema drift/);
});

test("assertSchemaMatchesZod catches required-field drift", () => {
  const json = { type: "object", properties: { a: { type: "string" } }, required: [] };
  const zodObj = z.object({ a: z.string() }); // required in Zod, optional in JSON
  assert.throws(() => assertSchemaMatchesZod("x", json, zodObj), /required/);
});

test("assertSchemaMatchesZod accepts an aligned pair", () => {
  const json = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] };
  const zodObj = z.object({ a: z.string(), b: z.number().optional() });
  assert.doesNotThrow(() => assertSchemaMatchesZod("x", json, zodObj));
});
