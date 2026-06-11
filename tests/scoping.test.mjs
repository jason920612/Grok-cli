import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserProfile } from "../dist/memory/UserProfile.js";
import { noteUserLevelTool } from "../dist/tools/definitions/userProfile.js";
import { askUserTool } from "../dist/tools/definitions/askUser.js";
import { ToolSkillRegistry } from "../dist/tool-skills/ToolSkillRegistry.js";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "grok-scope-"));
}

test("UserProfile tracks level per domain and persists", () => {
  const root = tmp();
  const p = new UserProfile(root);
  p.setLevel("Backend", "expert");
  p.setLevel("frontend", "novice");
  assert.equal(p.level("backend"), "expert"); // normalized
  assert.equal(p.level("frontend"), "novice");
  assert.equal(p.level("ml"), undefined);

  const reloaded = new UserProfile(root);
  assert.equal(reloaded.level("backend"), "expert");
  assert.equal(reloaded.level("frontend"), "novice");
});

test("UserProfile preamble lists per-domain levels (empty when unknown)", () => {
  const root = tmp();
  const p = new UserProfile(root);
  assert.equal(p.toPreamble(), "");
  p.setLevel("backend", "expert");
  assert.match(p.toPreamble(), /backend: expert/);
});

test("note_user_level tool records into the profile", async () => {
  const root = tmp();
  const profile = new UserProfile(root);
  const tool = noteUserLevelTool(new ToolSkillRegistry(root));
  const result = await tool.execute({ domain: "database", level: "intermediate" }, { userProfile: profile });
  assert.equal(result.level, "intermediate");
  assert.equal(profile.level("database"), "intermediate");
});

test("ask_user returns answers when an interactive user is available", async () => {
  const root = tmp();
  const tool = askUserTool(new ToolSkillRegistry(root));
  const askUser = async (questions) => questions.map((q) => ({ question: q.question, answer: "yes" }));
  const result = await tool.execute({ questions: [{ question: "Quick sketch or polished?" }] }, { askUser });
  assert.equal(result.interactive, true);
  assert.equal(result.answers[0].answer, "yes");
});

test("ask_user degrades gracefully with no interactive user (one-shot)", async () => {
  const root = tmp();
  const tool = askUserTool(new ToolSkillRegistry(root));
  const result = await tool.execute({ questions: [{ question: "anything?" }] }, {});
  assert.equal(result.interactive, false);
  assert.match(result.note, /assumptions/i);
});
