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
