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
];

/** The last of what the child said, for a failure that needs explaining. */
const TRANSCRIPT_BYTES = 8000;
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

const child = spawn(String(electronPath), [smokeMain, ...owned], {
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

let out = "";
let err = "";
let timedOut = false;
child.stdout.on("data", (d) => {
  out += d;
});
child.stderr.on("data", (d) => {
  err += d;
});

const timer = setTimeout(() => {
  timedOut = true;
  child.kill("SIGKILL");
}, TIMEOUT_MS);

// Cleanup happens here and only here, because only here are the child's handles
// on those directories certainly closed.
child.on("exit", (code) => {
  clearTimeout(timer);
  if (timedOut) {
    finish(1, `smoke: no result within ${TIMEOUT_MS}ms\n${out}\n${err}\n`);
    return;
  }
  const line = out.split("\n").find((l) => l.startsWith("RELAYIUM_SMOKE "));
  if (!line) {
    finish(1, `smoke: produced no result line (exit ${code})\n${out}\n${err}\n`);
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
    finish(1, `smoke: ${failures.length} failed\n${failures.join("\n")}\n${transcript()}`);
    return;
  }
  if (code !== 0) {
    finish(1, `smoke: assertions passed but the app exited ${code}\n${err}\n`);
    return;
  }
  process.stdout.write(`smoke: all resident lifecycle assertions passed\n`);
  finish(0, null);
});
