/**
 * Local GitHub-shaped collaboration board (subagents-v1.md §4).
 *
 * In-process Issue / PR / Comment / DM store that backs multi-agent
 * coordination on top of real local git (branches/worktrees handled by
 * GitService). Per-agent views are thread-scoped so an agent only loads the
 * issues/PRs addressed to it — the structure itself filters context (token
 * efficiency, §6).
 */

export type AgentId = string;

export type Comment = {
  id: string;
  author: AgentId;
  body: string;
  mentions: AgentId[];
  refs?: string[];
  round: number;
};

export type Issue = {
  number: number;
  title: string;
  body: string;
  author: AgentId;
  assignees: AgentId[];
  labels: string[];
  status: "open" | "closed";
  comments: Comment[];
};

export type Review = { by: AgentId; verdict: "approve" | "request_changes" | "comment"; body: string; round: number };

export type PullRequest = {
  number: number;
  title: string;
  body: string;
  author: AgentId;
  branch: string;
  base: string;
  linkedIssue?: number;
  status: "open" | "merged" | "closed";
  reviews: Review[];
  comments: Comment[];
};

export type DirectMessage = { id: string; from: AgentId; to: AgentId; body: string; refs?: string[]; round: number };

export class Board {
  private nextNumber = 1;
  private commentSeq = 0;
  private dmSeq = 0;
  round = 0;
  readonly issues = new Map<number, Issue>();
  readonly prs = new Map<number, PullRequest>();
  readonly dms: DirectMessage[] = [];

  openIssue(input: { title: string; body: string; author: AgentId; assignees?: AgentId[]; labels?: string[] }): Issue {
    const issue: Issue = {
      number: this.nextNumber++,
      title: input.title,
      body: input.body,
      author: input.author,
      assignees: input.assignees ?? [],
      labels: input.labels ?? [],
      status: "open",
      comments: []
    };
    this.issues.set(issue.number, issue);
    return issue;
  }

  assignIssue(number: number, assignees: AgentId[]): Issue {
    const issue = this.requireIssue(number);
    issue.assignees = [...new Set([...issue.assignees, ...assignees])];
    return issue;
  }

  closeIssue(number: number): void {
    this.requireIssue(number).status = "closed";
  }

  comment(on: "issue" | "pr", number: number, input: { author: AgentId; body: string; mentions?: AgentId[]; refs?: string[] }): Comment {
    const target = on === "issue" ? this.requireIssue(number) : this.requirePr(number);
    const comment: Comment = {
      id: `c${++this.commentSeq}`,
      author: input.author,
      body: input.body,
      mentions: input.mentions ?? [],
      refs: input.refs,
      round: this.round
    };
    target.comments.push(comment);
    return comment;
  }

  openPr(input: { title: string; body: string; author: AgentId; branch: string; base: string; linkedIssue?: number }): PullRequest {
    const pr: PullRequest = {
      number: this.nextNumber++,
      title: input.title,
      body: input.body,
      author: input.author,
      branch: input.branch,
      base: input.base,
      linkedIssue: input.linkedIssue,
      status: "open",
      reviews: [],
      comments: []
    };
    this.prs.set(pr.number, pr);
    return pr;
  }

  reviewPr(number: number, input: { by: AgentId; verdict: Review["verdict"]; body: string }): Review {
    const pr = this.requirePr(number);
    const review: Review = { by: input.by, verdict: input.verdict, body: input.body, round: this.round };
    pr.reviews.push(review);
    return review;
  }

  /** Mark a PR merged and close its linked issue. (The git merge is GitService's job.) */
  mergePr(number: number): PullRequest {
    const pr = this.requirePr(number);
    pr.status = "merged";
    if (pr.linkedIssue !== undefined && this.issues.has(pr.linkedIssue)) {
      this.issues.get(pr.linkedIssue)!.status = "closed";
    }
    return pr;
  }

  sendDm(input: { from: AgentId; to: AgentId; body: string; refs?: string[] }): DirectMessage {
    const dm: DirectMessage = { id: `d${++this.dmSeq}`, from: input.from, to: input.to, body: input.body, refs: input.refs, round: this.round };
    this.dms.push(dm);
    return dm;
  }

  openIssues(): Issue[] {
    return [...this.issues.values()].filter((i) => i.status === "open");
  }

  openPrs(): PullRequest[] {
    return [...this.prs.values()].filter((p) => p.status === "open");
  }

  requireIssue(number: number): Issue {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`No issue #${number}.`);
    return issue;
  }

  requirePr(number: number): PullRequest {
    const pr = this.prs.get(number);
    if (!pr) throw new Error(`No PR #${number}.`);
    return pr;
  }

  /**
   * Thread-scoped context view for one agent. The orchestrator sees all open
   * issues/PRs (it manages them); a worker sees only what is addressed to it.
   */
  viewFor(agentId: AgentId, isOrchestrator = false): string {
    const lines: string[] = [];

    const renderComments = (comments: Comment[]) =>
      comments.map((c) => `    @${c.author}: ${c.body}${c.refs?.length ? ` [refs: ${c.refs.join(",")}]` : ""}`);

    const issuesToShow = isOrchestrator
      ? this.openIssues()
      : this.openIssues().filter((i) => i.assignees.includes(agentId));
    if (issuesToShow.length > 0) {
      lines.push("Open issues:");
      for (const i of issuesToShow) {
        lines.push(`  #${i.number} ${i.title} [${i.assignees.map((a) => `@${a}`).join(" ") || "unassigned"}]`);
        if (i.body) lines.push(`    ${i.body}`);
        lines.push(...renderComments(i.comments));
      }
    }

    const prsToShow = isOrchestrator
      ? this.openPrs()
      : this.openPrs().filter((p) => p.author === agentId);
    if (prsToShow.length > 0) {
      lines.push("Open PRs:");
      for (const p of prsToShow) {
        lines.push(`  PR #${p.number} ${p.title} (by @${p.author}, ${p.branch} -> ${p.base}${p.linkedIssue ? `, closes #${p.linkedIssue}` : ""})`);
        for (const r of p.reviews) lines.push(`    review @${r.by}: ${r.verdict} — ${r.body}`);
        lines.push(...renderComments(p.comments));
      }
    }

    if (!isOrchestrator) {
      const mentions = this.mentionsFor(agentId);
      if (mentions.length > 0) {
        lines.push("Mentions of you:");
        for (const m of mentions) lines.push(`  ${m}`);
      }
    }

    const myDms = this.dms.filter((d) => d.to === agentId || d.from === agentId);
    if (myDms.length > 0) {
      lines.push("Direct messages:");
      for (const d of myDms) lines.push(`  ${d.from} -> ${d.to}: ${d.body}`);
    }

    // Compact index so every agent knows the landscape without loading threads.
    const index = [
      ...this.openIssues().map((i) => `#${i.number} issue "${i.title}" [${i.status}]`),
      ...this.openPrs().map((p) => `#${p.number} PR "${p.title}" [${p.status}]`)
    ];
    if (index.length > 0) lines.push("Board index:", ...index.map((s) => `  ${s}`));

    return lines.join("\n") || "Board is empty.";
  }

  private mentionsFor(agentId: AgentId): string[] {
    const out: string[] = [];
    for (const i of this.issues.values()) {
      for (const c of i.comments) if (c.mentions.includes(agentId)) out.push(`#${i.number}: @${c.author}: ${c.body}`);
    }
    for (const p of this.prs.values()) {
      for (const c of p.comments) if (c.mentions.includes(agentId)) out.push(`PR #${p.number}: @${c.author}: ${c.body}`);
    }
    return out;
  }
}
