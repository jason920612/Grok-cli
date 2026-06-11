import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Orchestrator } from "../dist/agents/Orchestrator.js";

function gitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-orch-"));
  const git = (...a) => execFileSync("git", a, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "t");
  git("config", "core.autocrlf", "false");
  git("checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(root, "README.md"), "# repo\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return root;
}

function fnCall(name, args, id = `c-${name}`) {
  return { output: [{ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) }] };
}
function text(t) {
  return { output_text: t };
}
function toResult(raw) {
  const output = Array.isArray(raw.output) ? raw.output : [];
  const toolCalls = output.filter((o) => o.type === "function_call").map((o) => ({ id: o.call_id, name: o.name, argsJson: o.arguments ?? "{}" }));
  return { id: "r", text: (raw.output_text ?? "").trim(), toolCalls, usage: undefined, warnings: [] };
}

function scriptedProvider(responses) {
  let i = 0;
  return {
    id: "fake",
    capabilities: { serverTools: [], promptCaching: true },
    async complete() {
      const r = responses[i++] ?? text("done");
      return toResult(r);
    }
  };
}

function config(root) {
  return {
    model: "fake",
    approval: "auto-all",
    toolChoice: "auto",
    maxSteps: 12,
    serverTools: false,
    enableWebSearch: false,
    enableXSearch: false,
    workspaceRoot: root,
    sandboxProfile: "default",
    workspaceTrusted: true,
    conversationMode: "stateless",
    hybridResetAfterTurns: 10,
    hybridResetAfterFailures: 3,
    enableVerifier: false,
    verifierMaxRetries: 2,
    enableLlmSummary: false
  };
}

test("orchestrator delegates to a worker which edits in a worktree, opens a PR, and the merge integrates it", async () => {
  const root = gitRepo();
  const provider = scriptedProvider([
    // orchestrator
    fnCall("open_issue", { title: "Add feature file", body: "create feature.txt", assignees: ["worker1"] }),
    fnCall("spawn_agent", { name: "worker1", role: "Create the feature file as briefed.", brief: "Create feature.txt containing 'hello feature'." }),
    // worker1 (runs inside spawn_agent)
    fnCall("apply_patch", { patch: "*** Begin Patch\n*** Add File: feature.txt\n+hello feature\n*** End Patch", reason: "create feature file" }),
    fnCall("open_pr", { title: "Add feature.txt", body: "Created feature.txt with the requested content.", linkedIssue: 1 }),
    text("Worker done."),
    // back to orchestrator
    fnCall("review_pr", { number: 2, verdict: "approve", body: "Looks correct." }),
    fnCall("merge_pr", { number: 2 }),
    text("All issues resolved and merged into the integration branch.")
  ]);

  const orch = new Orchestrator(provider, config(root), "test-run-1", "add a feature file");
  const result = await orch.run("Add a feature.txt file containing 'hello feature'.");

  assert.match(result.report, /merged into the integration branch/i);
  assert.equal(result.integrationBranch, "agents/test-run-1/integration");
  // the merged result is on the integration branch
  const merged = execFileSync("git", ["show", `${result.integrationBranch}:feature.txt`], { cwd: root, encoding: "utf8" });
  assert.match(merged, /hello feature/);
});

test("orchestrator has no file-editing/shell tools — a direct apply_patch is rejected and writes nothing", async () => {
  const root = gitRepo();
  const provider = scriptedProvider([
    // The orchestrator (wrongly) tries to edit a file itself.
    fnCall("apply_patch", { patch: "*** Begin Patch\n*** Add File: sneaky.txt\n+nope\n*** End Patch", reason: "try direct edit" }),
    text("Cannot edit directly; would delegate instead.")
  ]);
  const orch = new Orchestrator(provider, config(root), "noedit-run", "edit a file");
  await orch.run("Create sneaky.txt directly.");
  // apply_patch is stripped from the orchestrator, so nothing was written.
  assert.equal(fs.existsSync(path.join(root, "sneaky.txt")), false);
});

test("orchestrator's ask_user reaches the interactive askUser hook", async () => {
  const root = gitRepo();
  let asked = null;
  const provider = scriptedProvider([
    fnCall("ask_user", { questions: [{ question: "Which framework?", options: ["React", "Vue"] }] }),
    text("Thanks, proceeding with React.")
  ]);
  const orch = new Orchestrator(provider, config(root), "ask-run", "build an app", {
    askUser: async (questions) => {
      asked = questions;
      return questions.map((q) => ({ question: q.question, answer: "React" }));
    }
  });
  await orch.run("Build an app.");
  assert.ok(asked, "askUser hook was invoked");
  assert.equal(asked[0].question, "Which framework?");
});

test("an interrupt propagates to a running worker and unwinds the run (no hang)", async () => {
  const root = gitRepo();
  const controller = new AbortController();
  let calls = 0;
  const provider = {
    id: "fake",
    capabilities: { serverTools: [], promptCaching: true },
    async complete(req) {
      calls++;
      const blob = req.messages.map((m) => ("content" in m ? m.content : "")).join("\n");
      if (blob.includes('sub-agent "w1"')) {
        // Worker's turn — simulate the user hitting Stop mid-worker.
        controller.abort();
        return toResult(text("working on it"));
      }
      if (calls === 1) return toResult(fnCall("spawn_agent", { name: "w1", role: "do it", brief: "do the thing" }));
      return toResult(text("done"));
    }
  };
  const orch = new Orchestrator(provider, config(root), "int-run", "task");
  await assert.rejects(() => orch.run("task", controller.signal), /interrupt/i);
});

test("debate: an independent critic reviews the worker's PR before merge", async () => {
  const root = gitRepo();
  const used = new Set();
  const provider = {
    id: "fake",
    capabilities: { serverTools: [], promptCaching: true },
    async complete(req) {
      const blob = req.messages.map((m) => ("content" in m ? m.content : "")).join("\n");
      if (/adversarial code reviewer/i.test(blob)) {
        used.add("critic");
        return toResult(text("Checked the diff; the change is correct and verified.\nVERDICT: approve"));
      }
      if (blob.includes('sub-agent "w1"')) {
        used.add("worker");
        if (!used.has("w1patch")) { used.add("w1patch"); return toResult(fnCall("apply_patch", { patch: "*** Begin Patch\n*** Add File: f.txt\n+ok\n*** End Patch", reason: "x" })); }
        if (!used.has("w1pr")) { used.add("w1pr"); return toResult(fnCall("open_pr", { title: "add f", body: "done", linkedIssue: 1 })); }
        return toResult(text("worker done"));
      }
      used.add("orchestrator");
      if (!used.has("spawned")) { used.add("spawned"); return toResult(fnCall("spawn_agent", { name: "w1", role: "make f.txt", brief: "create f.txt" })); }
      if (!used.has("merged")) { used.add("merged"); return toResult(fnCall("merge_pr", { number: 1 })); }
      return toResult(text("All merged."));
    }
  };
  const orch = new Orchestrator(provider, { ...config(root), enableDebate: true, debateCritics: 1 }, "debate-run", "make f");
  const result = await orch.run("Create f.txt.");
  assert.ok(used.has("critic"), "an independent critic reviewed the PR");
  const merged = execFileSync("git", ["show", `${result.integrationBranch}:f.txt`], { cwd: root, encoding: "utf8" });
  assert.match(merged, /ok/);
});

test("debate: design is debated by proposers + a judge before building", async () => {
  const root = gitRepo();
  const used = new Set();
  const provider = {
    id: "fake",
    capabilities: { serverTools: [], promptCaching: true },
    async complete(req) {
      const blob = req.messages.map((m) => ("content" in m ? m.content : "")).join("\n");
      if (/design proposer/i.test(blob)) { used.add("proposer"); return toResult(text("Proposal: approach X. Evidence: existing module Y.")); }
      if (/design judge/i.test(blob)) { used.add("judge"); return toResult(text("CHOSEN DESIGN: approach X, sub-tasks A and B.")); }
      if (!used.has("debated")) { used.add("debated"); return toResult(fnCall("debate_design", { question: "How should we build feature F?" })); }
      return toResult(text("Plan ready."));
    }
  };
  const orch = new Orchestrator(provider, { ...config(root), enableDebate: true, debateProposers: 2 }, "design-run", "build F");
  await orch.run("Build feature F.");
  assert.ok(used.has("proposer"), "proposer agents argued designs");
  assert.ok(used.has("judge"), "a judge decided the design");
});

function routedProvider(queues) {
  const q = Object.fromEntries(Object.entries(queues).map(([k, v]) => [k, [...v]]));
  return {
    id: "fake",
    capabilities: { serverTools: [], promptCaching: true },
    async complete(req) {
      const blob = req.messages.map((m) => ("content" in m ? m.content : "")).join("\n");
      let key = "orchestrator";
      if (blob.includes('sub-agent "wa"')) key = "wa";
      else if (blob.includes('sub-agent "wb"')) key = "wb";
      const r = (q[key] && q[key].shift()) ?? text("done");
      return toResult(r);
    }
  };
}

test("non-git workspace: ephemeral git applies the result to the working tree and removes .git", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-eph-"));
  fs.writeFileSync(path.join(root, "README.md"), "# project\n");
  assert.equal(fs.existsSync(path.join(root, ".git")), false);

  const provider = scriptedProvider([
    fnCall("open_issue", { title: "Add util", body: "create util.txt", assignees: ["w1"] }),
    fnCall("spawn_agent", { name: "w1", role: "create util", brief: "Create util.txt with 'UTIL'." }),
    fnCall("apply_patch", { patch: "*** Begin Patch\n*** Add File: util.txt\n+UTIL\n*** End Patch", reason: "u" }),
    fnCall("open_pr", { title: "add util.txt", body: "done", linkedIssue: 1 }),
    text("w1 done"),
    fnCall("merge_pr", { number: 2 }),
    text("Done; applied.")
  ]);

  const orch = new Orchestrator(provider, config(root), "eph-run", "add util");
  const result = await orch.run("Add util.txt with 'UTIL'.");

  assert.equal(result.ephemeral, true);
  // change is applied directly to the user's working tree
  assert.equal(fs.readFileSync(path.join(root, "util.txt"), "utf8"), "UTIL\n");
  // and git is gone — the user never sees it
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
});

test("orchestrator runs two workers in parallel on disjoint files and merges both", async () => {
  const root = gitRepo();
  // Workers run concurrently (Promise.all), so route provider responses per agent.
  const provider = routedProvider({
    orchestrator: [
      fnCall("open_issue", { title: "file A", body: "create a.txt", assignees: ["wa"] }),
      fnCall("open_issue", { title: "file B", body: "create b.txt", assignees: ["wb"] }),
      fnCall("spawn_agents", {
        workers: [
          { name: "wa", role: "make a.txt", brief: "Create a.txt." },
          { name: "wb", role: "make b.txt", brief: "Create b.txt." }
        ]
      }),
      fnCall("merge_pr", { number: 3 }),
      fnCall("merge_pr", { number: 4 }),
      text("Both merged.")
    ],
    wa: [
      fnCall("apply_patch", { patch: "*** Begin Patch\n*** Add File: a.txt\n+AAA\n*** End Patch", reason: "a" }),
      fnCall("open_pr", { title: "add a.txt", body: "done a", linkedIssue: 1 }),
      text("wa done")
    ],
    wb: [
      fnCall("apply_patch", { patch: "*** Begin Patch\n*** Add File: b.txt\n+BBB\n*** End Patch", reason: "b" }),
      fnCall("open_pr", { title: "add b.txt", body: "done b", linkedIssue: 2 }),
      text("wb done")
    ]
  });

  const orch = new Orchestrator(provider, config(root), "test-run-2", "create two files");
  const result = await orch.run("Create a.txt and b.txt in parallel.");
  const a = execFileSync("git", ["show", `${result.integrationBranch}:a.txt`], { cwd: root, encoding: "utf8" });
  const b = execFileSync("git", ["show", `${result.integrationBranch}:b.txt`], { cwd: root, encoding: "utf8" });
  assert.match(a, /AAA/);
  assert.match(b, /BBB/);
});
