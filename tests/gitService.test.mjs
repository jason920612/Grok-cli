import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitService } from "../dist/agents/GitService.js";

function gitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-git-"));
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "base.txt"), "one\ntwo\nthree\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return { root };
}

let counter = 0;
const runId = () => `t${Date.now()}-${counter++}`;

test("worker work merges cleanly into the integration branch", () => {
  const { root } = gitRepo();
  const gs = new GitService(root, runId());
  assert.equal(gs.isGitRepo(), true);
  gs.setup();
  const { dir } = gs.addWorker("w1");

  fs.writeFileSync(path.join(dir, "new.txt"), "hello from w1\n");
  assert.equal(gs.commitWorker("w1", "add new.txt"), true);

  const merge = gs.mergeWorker("w1");
  assert.equal(merge.ok, true);
  assert.equal(fs.readFileSync(path.join(gs.integrationDir, "new.txt"), "utf8"), "hello from w1\n");

  gs.removeWorker("w1");
  gs.teardown();
});

test("two workers on disjoint files both merge cleanly", () => {
  const { root } = gitRepo();
  const gs = new GitService(root, runId());
  gs.setup();
  const a = gs.addWorker("a");
  const b = gs.addWorker("b");
  fs.writeFileSync(path.join(a.dir, "a.txt"), "A\n");
  fs.writeFileSync(path.join(b.dir, "b.txt"), "B\n");
  gs.commitWorker("a", "a");
  gs.commitWorker("b", "b");
  assert.equal(gs.mergeWorker("a").ok, true);
  assert.equal(gs.mergeWorker("b").ok, true);
  assert.ok(fs.existsSync(path.join(gs.integrationDir, "a.txt")));
  assert.ok(fs.existsSync(path.join(gs.integrationDir, "b.txt")));
  gs.teardown();
});

test("overlapping edits produce an explicit, reported merge conflict (not corruption)", () => {
  const { root } = gitRepo();
  const gs = new GitService(root, runId());
  gs.setup();
  const a = gs.addWorker("a");
  const b = gs.addWorker("b");
  fs.writeFileSync(path.join(a.dir, "base.txt"), "ONE\ntwo\nthree\n");
  fs.writeFileSync(path.join(b.dir, "base.txt"), "1\ntwo\nthree\n");
  gs.commitWorker("a", "a edits line 1");
  gs.commitWorker("b", "b edits line 1");

  assert.equal(gs.mergeWorker("a").ok, true);
  const second = gs.mergeWorker("b");
  assert.equal(second.ok, false);
  assert.ok(second.conflicts.includes("base.txt"));
  // merge was aborted: integration still has a's clean version
  assert.equal(fs.readFileSync(path.join(gs.integrationDir, "base.txt"), "utf8"), "ONE\ntwo\nthree\n");
  gs.teardown();
});
