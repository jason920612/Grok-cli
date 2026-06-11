import type { ToolEffects } from "./AgentTool.js";

/**
 * Single source of truth for each local tool's effects.
 *
 * This replaces the hand-maintained `READ_ONLY_LOCAL_TOOL_NAMES` set and the
 * loop's inline name checks (`apply_patch`, `run_shell`, `start_background_command`).
 * `validateToolEffects` runs at registry construction so a new tool that omits
 * an entry — or declares an impossible combination — fails fast instead of
 * silently defaulting to mutable.
 */
export const TOOL_EFFECTS: Record<string, ToolEffects> = {
  inspect_environment: ro(),
  check_project_tooling: ro(),
  list_files: ro(),
  get_file_overview: ro(),
  read_file_range: ro(),
  search_text: ro(),
  search_symbols: ro(),
  search_code: ro(),
  find_symbol: ro(),
  get_related_files: ro(),
  expand_node: ro(),
  git_status: ro(),
  git_diff: ro(),
  list_background_commands: ro(),
  read_background_output: ro(),
  // Mutating / effectful
  apply_patch: { readOnly: false, modifiesWorkspace: true, isShell: false, countsAsProgress: true },
  create_skill: { readOnly: false, modifiesWorkspace: false, isShell: false, countsAsProgress: true },
  remember: { readOnly: false, modifiesWorkspace: false, isShell: false, countsAsProgress: true },
  forget: { readOnly: false, modifiesWorkspace: false, isShell: false, countsAsProgress: true },
  run_python: { readOnly: false, modifiesWorkspace: false, isShell: true, countsAsProgress: false },
  start_background_command: { readOnly: false, modifiesWorkspace: false, isShell: true, countsAsProgress: false },
  stop_background_command: { readOnly: false, modifiesWorkspace: false, isShell: false, countsAsProgress: true },
  stop_all_background_commands: { readOnly: false, modifiesWorkspace: false, isShell: false, countsAsProgress: true }
};

function ro(): ToolEffects {
  return { readOnly: true, modifiesWorkspace: false, isShell: false, countsAsProgress: false };
}

/**
 * Assert every registered tool has effects declared and that the declarations
 * are internally consistent. Throws on the first violation.
 */
export function validateToolEffects(toolNames: string[]): void {
  for (const name of toolNames) {
    const effects = TOOL_EFFECTS[name];
    if (!effects) throw new Error(`Tool "${name}" has no declared effects in TOOL_EFFECTS.`);
    if (effects.readOnly && effects.modifiesWorkspace) {
      throw new Error(`Tool "${name}" cannot be both readOnly and modifiesWorkspace.`);
    }
    if (effects.readOnly && effects.isShell) {
      throw new Error(`Tool "${name}" cannot be both readOnly and a shell tool.`);
    }
    if (effects.readOnly && effects.countsAsProgress) {
      throw new Error(`Tool "${name}" is readOnly so it cannot count as progress.`);
    }
  }
}
