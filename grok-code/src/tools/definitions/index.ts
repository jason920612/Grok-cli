import { ToolRegistry } from "../ToolRegistry.js";
import type { ToolSkillRegistry } from "../../tool-skills/ToolSkillRegistry.js";
import { inspectEnvironmentTool } from "./inspectEnvironment.js";
import { checkProjectToolingTool } from "./checkProjectTooling.js";
import { listFilesTool } from "./listFiles.js";
import { getFileOverviewTool } from "./getFileOverview.js";
import { readFileRangeTool } from "./readFileRange.js";
import { searchTextTool } from "./searchText.js";
import { searchSymbolsTool } from "./searchSymbols.js";
import { searchCodeTool } from "./searchCode.js";
import { findSymbolTool } from "./findSymbol.js";
import { getRelatedFilesTool } from "./getRelatedFiles.js";
import { expandNodeTool } from "./expandNode.js";
import { createSkillTool } from "./createSkill.js";
import { applyPatchTool } from "./applyPatch.js";
import { runShellTool } from "./runShell.js";
import { gitStatusTool } from "./gitStatus.js";
import { gitDiffTool } from "./gitDiff.js";
import { startBackgroundCommandTool } from "./startBackgroundCommand.js";
import { listBackgroundCommandsTool } from "./listBackgroundCommands.js";
import { readBackgroundOutputTool } from "./readBackgroundOutput.js";
import { stopBackgroundCommandTool } from "./stopBackgroundCommand.js";
import { stopAllBackgroundCommandsTool } from "./stopAllBackgroundCommands.js";

export const LOCAL_TOOL_NAMES = [
  "inspect_environment",
  "check_project_tooling",
  "list_files",
  "get_file_overview",
  "read_file_range",
  "search_text",
  "search_symbols",
  "search_code",
  "find_symbol",
  "get_related_files",
  "expand_node",
  "create_skill",
  "apply_patch",
  "run_shell",
  "git_status",
  "git_diff",
  "start_background_command",
  "list_background_commands",
  "read_background_output",
  "stop_background_command",
  "stop_all_background_commands"
];

export function createLocalToolRegistry(skills: ToolSkillRegistry): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    inspectEnvironmentTool(skills),
    checkProjectToolingTool(skills),
    listFilesTool(skills),
    getFileOverviewTool(skills),
    readFileRangeTool(skills),
    searchTextTool(skills),
    searchSymbolsTool(skills),
    searchCodeTool(skills),
    findSymbolTool(skills),
    getRelatedFilesTool(skills),
    expandNodeTool(skills),
    createSkillTool(skills),
    applyPatchTool(skills),
    runShellTool(skills),
    gitStatusTool(skills),
    gitDiffTool(skills),
    startBackgroundCommandTool(skills),
    listBackgroundCommandsTool(skills),
    readBackgroundOutputTool(skills),
    stopBackgroundCommandTool(skills),
    stopAllBackgroundCommandsTool(skills)
  ]) {
    registry.register(tool);
  }
  return registry;
}
