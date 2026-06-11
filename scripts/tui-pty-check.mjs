// Drives the real built CLI inside a pseudo-terminal to verify the interactive
// input mechanics that only manifest on a true TTY:
//   1. each line is accepted with a SINGLE Enter (no swallowed first Enter)
//   2. /exit returns promptly (process does not hang until Ctrl+C)
// Uses only local slash commands (/help, /status, /exit) so no API key/network
// is needed. A dummy XAI_API_KEY and a throwaway HOME (pre-seeded trust) keep it
// hermetic.
//
// Run:  node scripts/tui-pty-check.mjs
import pty from "@homebridge/node-pty-prebuilt-multiarch";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(projectRoot, "dist", "index.js");
if (!fs.existsSync(entry)) {
  console.error(`Build first: ${entry} missing`);
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "grok-home-"));
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "grok-ws-")));
fs.mkdirSync(path.join(home, ".grok-code"), { recursive: true });
fs.writeFileSync(
  path.join(home, ".grok-code", "trust.json"),
  JSON.stringify(
    { version: 1, entries: [{ workspace: ws, scope: "exact", updatedAt: new Date().toISOString() }], recentWorkspaces: [ws] },
    null,
    2
  )
);

const term = pty.spawn(process.execPath, [entry], {
  name: "xterm-color",
  cols: 100,
  rows: 30,
  cwd: ws,
  env: { ...process.env, USERPROFILE: home, HOME: home, XAI_API_KEY: "test-dummy", FORCE_COLOR: "0" }
});

let raw = "";
term.onData((d) => {
  raw += d;
});
const clean = () => raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");

let exited = null;
term.onExit((e) => {
  exited = e;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(re, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (re.test(clean())) return resolve();
      if (exited) return reject(new Error(`process exited early waiting for ${label} (code ${exited.exitCode})`));
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${label}\n--- buffer tail ---\n${clean().slice(-500)}`));
      setTimeout(tick, 40);
    };
    tick();
  });
}

function waitExit(timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (exited) return resolve(exited);
      if (Date.now() - start > timeoutMs) return reject(new Error("timeout: process did not exit after /exit (hang bug)"));
      setTimeout(tick, 40);
    };
    tick();
  });
}

async function main() {
  // 1. Reaches the interactive prompt.
  await waitFor(/\/exit to quit/, 20000, "intro banner");

  // 2. First command accepted with a single Enter.
  await sleep(200);
  term.write("/help\r");
  await waitFor(/Show session status/, 8000, "/help output (1st single-Enter line)");

  // 3. Second command, single Enter again — this is the double-Enter regression.
  await sleep(300);
  term.write("/status\r");
  await waitFor(/tokens this session/, 8000, "/status output (2nd single-Enter line)");

  // 4. A third line, to be sure the single-Enter invariant holds across rounds.
  await sleep(300);
  term.write("/help\r");
  await waitFor(/Toggle multi-agent mode/, 8000, "/help output (3rd single-Enter line)");

  // 5. /diff returns cleanly (no changes in this throwaway non-git workspace).
  await sleep(300);
  term.write("/diff\r");
  await waitFor(/No changes in the working tree/, 8000, "/diff (no-changes path)");

  // 6. /yes toggles always-approve.
  await sleep(300);
  term.write("/yes\r");
  await waitFor(/Always-approve.*ON/, 8000, "/yes toggle");

  // 7. Exit promptly — no hang.
  await sleep(300);
  term.write("/exit\r");
  const e = await waitExit(6000);

  const ok = clean().includes("Goodbye.");
  console.log("\n\n================ RESULT ================");
  console.log(`single-Enter per line : PASS (3 lines accepted with one CR each)`);
  console.log(`prompt exit code      : ${e.exitCode}`);
  console.log(`printed "Goodbye."    : ${ok ? "yes" : "no"}`);
  console.log(`no hang after /exit   : PASS (exited within 6s)`);
  console.log("=======================================");
  process.exit(0);
}

main().catch((err) => {
  console.error("\n\nPTY CHECK FAILED:\n" + err.message);
  try {
    term.kill();
  } catch {}
  process.exit(1);
});
