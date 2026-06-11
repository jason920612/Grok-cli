import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectMemory } from "../dist/memory/ProjectMemory.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-mem-"));
}

test("remember adds entries and persists to json + rendered md", () => {
  const root = tmp();
  const mem = new ProjectMemory(root);
  const e = mem.remember({ section: "Intent", content: "Build a local coding agent" });
  assert.equal(e.section, "Intent");
  assert.ok(e.id);

  assert.ok(fs.existsSync(path.join(root, ".grok-code", "memory.json")));
  const md = fs.readFileSync(path.join(root, ".grok-code", "memory.md"), "utf8");
  assert.match(md, /## Intent/);
  assert.match(md, /Build a local coding agent/);
});

test("remember with id updates the existing entry", () => {
  const root = tmp();
  const mem = new ProjectMemory(root);
  const e = mem.remember({ section: "Cautions", content: "flaky test X" });
  const updated = mem.remember({ section: "Cautions", content: "flaky test X (retry twice)", id: e.id });
  assert.equal(updated.id, e.id);
  assert.equal(mem.entries().length, 1);
  assert.match(updated.content, /retry twice/);
});

test("forget removes an entry", () => {
  const root = tmp();
  const mem = new ProjectMemory(root);
  const e = mem.remember({ section: "Assumptions", content: "node >= 20" });
  assert.equal(mem.forget(e.id), true);
  assert.equal(mem.forget("nope"), false);
  assert.equal(mem.entries().length, 0);
});

test("memory survives reload from disk", () => {
  const root = tmp();
  const m1 = new ProjectMemory(root);
  m1.remember({ section: "Decisions", content: "pure stateless loop" });
  const m2 = new ProjectMemory(root);
  assert.equal(m2.entries().length, 1);
  assert.equal(m2.entries()[0].content, "pure stateless loop");
});

test("toPreamble is empty without memory and grouped with memory", () => {
  const root = tmp();
  const mem = new ProjectMemory(root);
  assert.equal(mem.toPreamble(), "");
  mem.remember({ section: "Intent", content: "goal A" });
  mem.remember({ section: "Conventions", content: "use apply_patch" });
  const p = mem.toPreamble();
  assert.match(p, /Intent:/);
  assert.match(p, /goal A/);
  assert.match(p, /Conventions:/);
});
