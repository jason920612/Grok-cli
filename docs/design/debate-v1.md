# Multi-agent debate v1 — discussion, critique, decision

> **REMOVED (kept for history).** The debate system (per-PR adversarial critics +
> judge, and the up-front `debate_design` proposer/judge round) was reverted: in
> practice it multiplied token cost and caused the orchestrator to loop
> (re-verifying merged files and spawning extra "polish/verify" workers without
> terminating). The orchestrator is now plain: plan → delegate (parallel workers
> that verify their own work) → review → merge → done. This document describes the
> removed design only.

Problem: the orchestrator only *allocates* tasks. Agents don't debate; the
orchestrator decides the plan alone and rubber-stamps its own delegated PRs.
The Board already has the primitives (issue / PR / comment / @mention / DM /
review verdicts) — what's missing is adversarial roles and a process that
*requires* discussion.

Agreed design (2026-06-11):

## Three forms (all opt-in via config.enableDebate, default on)

1. **Adversarial PR review** — when a worker opens a PR, independent critic
   agent(s) review the diff with a mandate to FIND PROBLEMS (bugs, regressions,
   missing verification, scope drift), each posting findings + a verdict
   (approve / request_changes) with evidence. If changes are requested, the
   author worker gets one revision round with the findings, then re-review.
   This replaces the orchestrator self-approving.

2. **Design debate (pre-build)** — for non-trivial/ambiguous tasks, 2–3 proposer
   agents argue distinct designs (e.g. simplest / extensible / performant),
   cross-critique on the board, then a decision is made and drives decomposition.

3. **Interface-contract negotiation** — parallel workers with shared contracts
   (APIs, data shapes) agree the contract up front (in their briefs / on the
   board) before coding, so the pieces integrate.

## Decider: independent judge, evidence-weighted majority

A neutral **judge agent** reads every participant's position AND its evidence.
It defaults to the MAJORITY position, but must weigh evidence quality and may
OVERRIDE the majority when the minority has decisively stronger, concrete
evidence — explicitly guarding against a misled majority (groupthink). The judge
must justify its decision citing the evidence, and report {decision, rationale,
majorityWas, overrodeMajority}.

## Mechanism

- **Discussant loop**: a read-only AgentLoop (read/search/git tools + board
  comment; no edit/shell, no worktree) used for proposers / critics / judges.
  Runs in the relevant root (worker worktree for PR critique, repo root for
  design debate) and returns a structured position (ends with a VERDICT/JSON tail
  the orchestrator parses).
- **Structural, not just prompted**: the Orchestrator code drives the critique /
  debate / judge rounds, so debate actually happens (prompts alone didn't).
- **Cost control**: configurable critic count (default 2), capped revision
  rounds (default 1), debate only for non-trivial work.

## Build order

1. Adversarial PR review + judge (this is the highest-leverage form). ← first
2. Design debate before decomposition.
3. Interface-contract negotiation.
