import type OpenAI from "openai";
import type { GrokCodeConfig } from "../config/loadConfig.js";
import { ContextManager } from "../context/ContextManager.js";
import { WorkspaceSandbox } from "../workspace/WorkspaceSandbox.js";
import { BackgroundProcessManager } from "../background/BackgroundProcessManager.js";
import { ApprovalPolicy } from "../approval/ApprovalPolicy.js";
import { ToolSkillRegistry } from "../tool-skills/ToolSkillRegistry.js";
import { LOCAL_TOOL_NAMES, createLocalToolRegistry } from "../tools/definitions/index.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import { scanRepo } from "../workspace/RepoScanner.js";
import { AgentLoop } from "./AgentLoop.js";

export class Agent {
  readonly context = new ContextManager();
  readonly sandbox: WorkspaceSandbox;
  readonly background = new BackgroundProcessManager();
  readonly approval: ApprovalPolicy;
  readonly toolSkills: ToolSkillRegistry;
  readonly tools;
  readonly skillLoader: SkillLoader;

  constructor(private readonly client: OpenAI, readonly config: GrokCodeConfig, originalTask = "") {
    this.sandbox = new WorkspaceSandbox(config.workspaceRoot, config.sandboxProfile, config.workspaceTrusted);
    this.approval = new ApprovalPolicy(config.approval, originalTask);
    this.toolSkills = new ToolSkillRegistry(config.workspaceRoot);
    this.toolSkills.loadBuiltin(LOCAL_TOOL_NAMES);
    this.tools = createLocalToolRegistry(this.toolSkills);
    this.skillLoader = new SkillLoader(config.workspaceRoot);
    this.context.upsert("repo-summary", { type: "repo_summary", content: scanRepo(config.workspaceRoot), priority: 80, pinned: true });
    this.context.upsert("environment-policy", { type: "environment_policy", content: "Prefer project-local setup. Global environment changes require explicit approval.", priority: 100, pinned: true });
  }

  async bootstrap(): Promise<void> {
    const toolCtx = this.toolContext();
    await this.tools.execute("inspect_environment", { includeVersions: true, includeNetworkCheck: false }, toolCtx);
    await this.tools.execute("git_status", {}, toolCtx);
  }

  async run(task: string, oneShot: boolean, signal?: AbortSignal): Promise<string> {
    const loop = new AgentLoop(this.client, this.config, this.context, this.tools, this.toolContext(), this.skillLoader, this.toolSkills, this.skillLoader.projectInstructions());
    return loop.run(task, oneShot, signal);
  }

  toolContext() {
    return {
      workspaceRoot: this.config.workspaceRoot,
      sandbox: this.sandbox,
      approval: this.approval,
      background: this.background,
      context: this.context
    };
  }
}
