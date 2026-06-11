import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_EFFECTS, validateToolEffects } from "../dist/tools/toolEffects.js";
import { LOCAL_TOOL_NAMES } from "../dist/tools/definitions/index.js";

// The set of read-only tools as it existed before effects were centralized.
// This locks behaviour: the migration must not silently reclassify any tool.
const HISTORICAL_READ_ONLY = new Set([
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
  "view_image",
  "git_status",
  "git_diff",
  "list_background_commands",
  "read_background_output"
]);

test("every local tool has declared effects", () => {
  assert.doesNotThrow(() => validateToolEffects(LOCAL_TOOL_NAMES));
  for (const name of LOCAL_TOOL_NAMES) {
    assert.ok(TOOL_EFFECTS[name], `missing effects for ${name}`);
  }
});

test("readOnly classification matches the historical read-only set exactly", () => {
  for (const name of LOCAL_TOOL_NAMES) {
    assert.equal(
      TOOL_EFFECTS[name].readOnly,
      HISTORICAL_READ_ONLY.has(name),
      `readOnly mismatch for ${name}`
    );
  }
});

test("shell-like tools (exit-code semantics) are the shell + python executors", () => {
  const shellTools = LOCAL_TOOL_NAMES.filter((name) => TOOL_EFFECTS[name].isShell);
  assert.deepEqual(shellTools.sort(), ["click_desktop", "run_python", "screenshot", "start_background_command"].sort());
});

test("only apply_patch is marked as modifying the workspace", () => {
  const modifies = LOCAL_TOOL_NAMES.filter((name) => TOOL_EFFECTS[name].modifiesWorkspace);
  assert.deepEqual(modifies, ["apply_patch"]);
});

test("countsAsProgress equals not-readOnly-and-not-shell (historical markProgress rule)", () => {
  for (const name of LOCAL_TOOL_NAMES) {
    const e = TOOL_EFFECTS[name];
    assert.equal(e.countsAsProgress, !e.readOnly && !e.isShell, `progress mismatch for ${name}`);
  }
});

test("validateToolEffects rejects missing and inconsistent declarations", () => {
  assert.throws(() => validateToolEffects(["does_not_exist"]), /no declared effects/);
});
