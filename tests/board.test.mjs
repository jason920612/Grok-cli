import test from "node:test";
import assert from "node:assert/strict";
import { Board } from "../dist/agents/Board.js";

test("issues and PRs share one increasing number space", () => {
  const b = new Board();
  const i = b.openIssue({ title: "task A", body: "do A", author: "orchestrator" });
  const p = b.openPr({ title: "PR A", body: "", author: "worker1", branch: "wt/w1", base: "integ", linkedIssue: i.number });
  assert.equal(i.number, 1);
  assert.equal(p.number, 2);
});

test("merge_pr marks merged and auto-closes the linked issue", () => {
  const b = new Board();
  const i = b.openIssue({ title: "t", body: "", author: "orchestrator", assignees: ["w1"] });
  const p = b.openPr({ title: "p", body: "", author: "w1", branch: "wt/w1", base: "integ", linkedIssue: i.number });
  b.mergePr(p.number);
  assert.equal(b.requirePr(p.number).status, "merged");
  assert.equal(b.requireIssue(i.number).status, "closed");
  assert.equal(b.openIssues().length, 0);
});

test("worker view shows only assigned issues + own PRs + mentions + dms", () => {
  const b = new Board();
  const a = b.openIssue({ title: "A for w1", body: "", author: "orchestrator", assignees: ["w1"] });
  const bIssue = b.openIssue({ title: "B for w2", body: "", author: "orchestrator", assignees: ["w2"] });
  b.comment("issue", bIssue.number, { author: "orchestrator", body: "hey @w1 take a look", mentions: ["w1"] });
  b.sendDm({ from: "orchestrator", to: "w1", body: "psst use the cache" });

  const view = b.viewFor("w1", false);
  assert.match(view, /#1 A for w1/);          // assigned
  assert.doesNotMatch(view, /B for w2[^"]*\n {4}/); // not shown as a full thread for w1
  assert.match(view, /Mentions of you/);
  assert.match(view, /hey @w1/);
  assert.match(view, /psst use the cache/);
});

test("orchestrator view shows all open issues and PRs", () => {
  const b = new Board();
  b.openIssue({ title: "A", body: "", author: "orchestrator", assignees: ["w1"] });
  b.openIssue({ title: "B", body: "", author: "orchestrator", assignees: ["w2"] });
  const view = b.viewFor("orchestrator", true);
  assert.match(view, /#1 A/);
  assert.match(view, /#2 B/);
});

test("reviews and comments attach to a PR", () => {
  const b = new Board();
  const p = b.openPr({ title: "p", body: "", author: "w1", branch: "wt/w1", base: "integ" });
  b.comment("pr", p.number, { author: "orchestrator", body: "looks good" });
  b.reviewPr(p.number, { by: "orchestrator", verdict: "approve", body: "ship it" });
  const pr = b.requirePr(p.number);
  assert.equal(pr.comments.length, 1);
  assert.equal(pr.reviews[0].verdict, "approve");
});
