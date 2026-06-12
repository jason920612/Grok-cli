// Live multi-agent smoke test. Runs a real `--yes` task in a throwaway workspace
// against the actual model and checks BEHAVIOUR (what unit tests can't): did it
// ask when open, stay a single worker for a single-file deliverable, review +
// merge + apply, finish without hitting the step cap, exit cleanly — and what did
// it cost. Use this after touching the multi-agent loop / orchestrator.
//
//   npm run build
//   node scripts/smoke-multiagent.mjs                 # default dashboard task
//   node scripts/smoke-multiagent.mjs "your task…"    # custom task
//
// Requires XAI_API_KEY in the environment or in a .env the CLI can load.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "dist", "index.js");
const DEFAULT_TASK = "做一個整理美股每天主要指數價格波動的儀表板網頁";
const task = process.argv[2] || DEFAULT_TASK;
const TIMEOUT_MS = 25 * 60 * 1000;

if (!fs.existsSync(cliEntry)) {
  console.error(`dist not built — run "npm run build" first (missing ${cliEntry})`);
  process.exit(2);
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "grok-smoke-"));
fs.writeFileSync(path.join(ws, "README.md"), "# smoke-test workspace\n");
console.log(`workspace: ${ws}`);
console.log(`task:      ${task}\n`);

const child = spawn(process.execPath, [cliEntry, task, "--yes"], {
  cwd: ws,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"]
});

let log = "";
child.stdout.on("data", (d) => (log += d.toString("utf8")));
child.stderr.on("data", (d) => (log += d.toString("utf8")));

const killer = setTimeout(() => {
  console.error(`\n[smoke] timed out after ${TIMEOUT_MS / 1000}s — killing`);
  child.kill("SIGKILL");
}, TIMEOUT_MS);

const started = Date.now();
child.on("exit", (code) => {
  clearTimeout(killer);
  const wallSec = Math.round((Date.now() - started) / 1000);
  report(code, wallSec);
});

function lastUsage(label) {
  const re = new RegExp(`\\[${label}[^\\]]*\\][^\\n]*in [^\\n]*call`, "g");
  const m = log.match(re);
  return m ? m[m.length - 1].trim() : null;
}

function report(code, wallSec) {
  const lines = log.split(/\r?\n/);
  const agentLabels = new Set();
  for (const l of lines) {
    const m = l.match(/^\s*\[([^\]]+)\]/);
    if (m && !/Changes applied/.test(m[1])) agentLabels.add(m[1].replace(/^worker:/, ""));
  }
  const workers = [...agentLabels].filter((a) => a !== "orchestrator");
  const has = (re) => re.test(log);
  const count = (re) => (log.match(re) || []).length;

  const asked = has(/tool batch \d+:[^\n]*ask_user/);
  const merged = has(/: merge_pr/);
  const applied = has(/Changes applied to your files/);
  const stoppedAtCap = has(/Stopped after max steps/);
  const updatePlans = count(/\[orchestrator\][^\n]*: update_plan/g);
  const batches = count(/Provider returned \d+ tool calls/g);

  const checks = [
    ["exited cleanly (code 0)", code === 0],
    ["did NOT hit the step cap", !stoppedAtCap],
    ["asked a scoping question (ask_user)", asked],
    ["spawned worker(s)", has(/: spawn_agent/)],
    ["reviewed a PR", has(/: review_pr/)],
    ["merged a PR", merged],
    ["applied changes to the workspace", applied],
    ["no update_plan spam (<10)", updatePlans < 10]
  ];

  console.log("\n================ SMOKE RESULT ================");
  for (const [name, ok] of checks) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log("----------------------------------------------");
  console.log(`  workers:            ${workers.length} (${workers.join(", ") || "none"})`);
  console.log(`  parallel batches:   ${batches}`);
  console.log(`  orchestrator update_plan calls: ${updatePlans}`);
  console.log(`  lazy-gate rejects:  ${count(/REJECTED . this patch contains lazy|REJECTED — this patch contains lazy/g)}`);
  console.log(`  doom-loop warnings: ${count(/Doom-loop warning/g)}   terminations: ${count(/Doom-loop: turn terminated/g)}`);
  console.log(`  todo-gate nudges:   ${count(/still has \d+ step\(s\) pending/g)}`);
  console.log(`  auto-continues:     ${count(/output truncated . auto-continuing|auto-continuing/g)}`);
  console.log(`  wall time:          ${wallSec}s   exit: ${code}`);
  try {
    const logPath = path.join(os.tmpdir(), "grok-smoke-last.log");
    fs.writeFileSync(logPath, log);
    console.log(`  full log:           ${logPath}`);
  } catch { /* best effort */ }
  const orch = lastUsage("orchestrator");
  for (const w of workers) {
    const u = lastUsage(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (u) console.log(`  usage ${u}`);
  }
  if (orch) console.log(`  usage ${orch}`);
  console.log("==============================================");

  const passed = checks.every(([, ok]) => ok);
  console.log(passed ? "\nSMOKE PASS\n" : "\nSMOKE FAIL — inspect the run above\n");
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(passed ? 0 : 1);
}
