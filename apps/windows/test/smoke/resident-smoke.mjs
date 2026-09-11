// Launch a real Electron and drive the RESIDENT lifecycle.
//
// Same ownership rules as `electron-smoke.mjs` — this wrapper creates the two
// temporary directories, passes them in, and removes them after the child has
// exited — because the resident run has more ways to end and none of them may
// leave a profile behind.
//
// Original header follows.
//
// Launch a real Electron and require the real app to come up.
//
// Exit code is the result; the JSON line names what failed. Kept as a plain
// script rather than a vitest case because it must own the process it spawns and
// its own timeout — a hung Electron is a failure mode this has to report, not
// inherit.
//
// ## The parent owns the temporary directories
//
// They are created here, passed to the child as arguments, and removed here
// AFTER the child's exit has been observed. The child never deletes them.
//
// The child used to. It could not do it correctly: its cleanup ran before
// `app.exit()`, while Chromium still held handles inside the profile directory.
// On Windows an open handle makes the removal fail outright, and the child's
// best-effort `catch` then discarded the error — leaving a profile behind while
// the run reported success. Deleting only once the process is gone is the only
// point at which the handles are guaranteed closed, and a failure here is
// REPORTED rather than swallowed: this script does not claim to have removed a
// path it could not remove.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";

const smokeMain = fileURLToPath(new URL("./resident-main.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../..", import.meta.url));
// Raised with the Device Inbox scenarios, which add a sign-in, a consent
// refusal and acceptance, a hide, a page navigation, a message opened from a
// real encrypted vault, a refused quit and an account change. The budget is a
// backstop against a hung Electron, not a performance target.
const TIMEOUT_MS = 180_000;

const owned = [
  mkdtempSync(path.join(tmpdir(), "relayium-resident-profile-")),
  mkdtempSync(path.join(tmpdir(), "relayium-resident-secrets-")),
  // Where the injected picker points. A real lease writes real staging bytes
  // here, so the cleanup this smoke exercises has something to clean up.
  mkdtempSync(path.join(tmpdir(), "relayium-resident-dest-")),
  // The Device Inbox's own data root. Task-owned, because this run writes a
  // real encrypted vault and a real journal into it — and because
  // `currentDataRoot()` refuses to invent one on a host that is not Windows,
  // which is where this smoke actually executes.
  mkdtempSync(path.join(tmpdir(), "relayium-resident-inbox-")),
  // The stored-send journal. Task-owned for the same reasons: this run writes a
  // real upload journal and real key custody into it.
  mkdtempSync(path.join(tmpdir(), "relayium-resident-send-")),
  // The update journal and staging. Task-owned for the same reason the others
  // are: this run writes a real journal, and `currentDataRoot()` legitimately
  // refuses on a host that is not Windows.
  mkdtempSync(path.join(tmpdir(), "relayium-resident-update-")),
  // A SECOND send journal, used only by the restart phase.
  //
  // The first phase deliberately leaves an upload whose outcome could not be
  // established — that is what `scenarioStoredSendAmbiguous` is for — and that
  // record is durable. Sharing the journal would mean the restart phase always
  // has one unresolved upload, the install consent always refuses (correctly),
  // and the installer could never be reached. Two journals keep both scenarios
  // honest instead of weakening either.
  mkdtempSync(path.join(tmpdir(), "relayium-resident-send-restart-")),
];

/** The last of what the child said, for a failure that needs explaining. */
const TRANSCRIPT_BYTES = 8000;
/**
 * The child's own measurements, whatever the outcome.
 *
 * `RELAYIUM_*` lines are counts, closed codes and rendered copy — never a path,
 * a key or a secret — emitted deliberately so a run can be compared against
 * another run rather than only read for its assertions.
 */
function diagnostics() {
  const lines = out.split("\n").filter((line) => line.startsWith("RELAYIUM_") && !line.startsWith("RELAYIUM_SMOKE "));
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function transcript() {
  const tail = (label, text) =>
    text.length === 0 ? "" : `--- child ${label} (last ${String(TRANSCRIPT_BYTES)} bytes) ---\n${text.slice(-TRANSCRIPT_BYTES)}\n`;
  return `${tail("stdout", out)}${tail("stderr", err)}`;
}

/** Returns the paths that could NOT be removed, so nothing is claimed falsely. */
function removeOwned() {
  const stuck = [];
  for (const dir of owned) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      stuck.push(`${dir}: ${String(err)}`);
    }
  }
  return stuck;
}

function finish(code, message) {
  const stuck = removeOwned();
  if (message) process.stderr.write(message);
  if (stuck.length > 0) {
    process.stderr.write(`smoke: could not remove ${stuck.length} owned directory(ies)\n${stuck.join("\n")}\n`);
    process.exit(1);
  }
  process.exit(code);
}

/**
 * The run is TWO processes over the same directories.
 *
 * `first` drives every scenario and leaves durable state behind — an enrolled
 * account, a received delivery, a named history. `restart` is a second Electron
 * over the SAME profile, secrets and Inbox root, and it exists to prove the one
 * thing the first cannot: that what the user was shown survives the app being
 * closed and opened again. Reloading the page in the first process would not
 * have proved it, because the store that answers is the one that wrote it.
 *
 * The directories are removed only after BOTH have exited, for the reason this
 * file's header gives: only then are the handles certainly closed.
 */
const PHASES = ["first", "restart"];
let phaseIndex = 0;

function spawnPhase(phase) {
  return spawn(String(electronPath), [smokeMain, ...owned, phase], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    // Ambient engineering overrides are CLEARED, not inherited.
    //
    // This wrapper spreads `process.env`, so a developer who had exported these
    // for an engineering run would silently hand them to the smoke child: the
    // run would then take the engineering branch, reach the real platform
    // cipher, and touch their login keychain. The smoke supplies its own store
    // by injection and must not depend on the environment being clean — so it
    // makes it clean.
    RELAYIUM_WINDOWS_ENGINEERING: undefined,
    RELAYIUM_WINDOWS_DATA_ROOT: undefined,
    RELAYIUM_WINDOWS_ORIGIN: undefined,
  },
  });
}

let out = "";
let err = "";
let timedOut = false;
let child = null;
let timer = null;

function runPhase(phase) {
  // Each phase's transcript starts clean, so a failure names the process it
  // actually came from rather than the one before it.
  out = "";
  err = "";
  timedOut = false;
  child = spawnPhase(phase);
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    err += d;
  });
  timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, TIMEOUT_MS);
  child.on("exit", (code) => onExit(phase, code));
}

// Cleanup happens after the LAST phase and only there, because only then are the
// children's handles on those directories certainly closed.
function onExit(phase, code) {
  clearTimeout(timer);
  if (timedOut) {
    finish(1, `smoke [${phase}]: no result within ${TIMEOUT_MS}ms\n${out}\n${err}\n`);
    return;
  }
  const line = out.split("\n").find((l) => l.startsWith("RELAYIUM_SMOKE "));
  if (!line) {
    finish(1, `smoke [${phase}]: produced no result line (exit ${code})\n${out}\n${err}\n`);
    return;
  }
  const { failures } = JSON.parse(line.slice("RELAYIUM_SMOKE ".length));
  if (failures.length > 0) {
    // ## The child's transcript survives a failure
    //
    // It did not, and that cost a diagnosis: this branch printed the failure
    // list and dropped everything the child had written, so a scenario that
    // threw reported "Script failed to execute" with the renderer error, the
    // failing expression and every progress line already captured in `err` and
    // discarded here. The timeout branch above kept them; the branch that
    // actually fires on a broken assertion did not.
    //
    // Bounded rather than unbounded: this is a diagnostic tail, not a log.
    finish(1, `smoke [${phase}]: ${failures.length} failed\n${failures.join("\n")}\n${diagnostics()}${transcript()}`);
    return;
  }
  if (code !== 0) {
    finish(1, `smoke [${phase}]: assertions passed but the app exited ${code}\n${err}\n`);
    return;
  }
  process.stdout.write(diagnostics());
  process.stdout.write(`smoke [${phase}]: assertions passed\n`);
  phaseIndex += 1;
  if (phaseIndex < PHASES.length) {
    runPhase(PHASES[phaseIndex]);
    return;
  }
  // Diagnostics surface on BOTH paths. They were only ever printed when the run
  // failed, which is precisely backwards for a measurement: the passing run is
  // the baseline a failing one is compared against, and on a Windows CI failure
  // there was nothing green to compare with.
  process.stdout.write(`smoke: all resident lifecycle assertions passed, across ${String(PHASES.length)} processes\n`);
  finish(0, null);
}

runPhase(PHASES[phaseIndex]);
