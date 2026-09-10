// Electron entry for one cell of the secret-durability matrix.
//
// Windows-only, and it owns everything it touches: the profile is a temp
// directory the parent created and deletes, the value sealed is a synthetic
// fixture, and nothing reads the user's real profile, real identity or any key
// material.
//
// It uses the REAL `SecretStore` and the REAL Electron `safeStorage` cipher from
// `dist/`. A mock would answer a question nobody asked: what is under test is
// Electron's OSCrypt key lifecycle, not our wrapper's arithmetic.
//
// The parent chooses the cell; this process reports what happened in it.

import { app, safeStorage } from "electron";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const FIXTURE = "durability-fixture-v1";

function emit(payload) {
  process.stdout.write(`RELAYIUM_DURABILITY ${JSON.stringify(payload)}\n`);
}

// ## The platform guard lives HERE, not only in the parent
//
// Below this line the process calls `safeStorage`, and on a developer's Mac that
// is the owner's real Keychain — a prompt, or a read, that this task is not
// permitted to cause. A parent-side check protects only the paths the parent
// controls; a mis-set environment variable, a stray `electron .` or a future
// caller would walk straight past it. The one place that can guarantee the call
// never happens is the process that would make it.
if (process.platform !== "win32") {
  emit({ fatal: `secret durability is Windows-only; refusing to run on ${process.platform}` });
  app.exit(2);
}

const verb = process.env["RELAYIUM_DURABILITY_VERB"] ?? "seal";
const profile = process.env["RELAYIUM_DURABILITY_PROFILE"];
const dataRoot = process.env["RELAYIUM_DURABILITY_DATA_ROOT"];
const holdMs = Number(process.env["RELAYIUM_DURABILITY_HOLD_MS"] ?? "0");
/** `quit` = normal shutdown. `exit` = abrupt, the crash analogue. */
const exitMode = process.env["RELAYIUM_DURABILITY_EXIT"] ?? "quit";
/** `1` reproduces the product's single-instance composition; `0` is adversarial. */
const useLock = (process.env["RELAYIUM_DURABILITY_LOCK"] ?? "1") === "1";

if (!profile || !dataRoot) {
  emit({ fatal: "profile and data root must both be supplied" });
  app.exit(2);
}

// The owned profile. BOTH are set: `sessionData` is what Electron uses for
// `Local State`, and it defaults to `userData` — setting only one leaves the
// other pointing at the real profile.
app.setPath("userData", profile);
app.setPath("sessionData", profile);

// ## The lock is taken at the product's timing
//
// `main.ts` calls `requestSingleInstanceLock()` before `whenReady()`, and this
// mirrors that.
//
// HYPOTHESIS, not established fact: that Electron initialises OSCrypt during
// native start-up, before any of this JavaScript runs, so a second process can
// reach the shared profile's key before the JS lock can turn it away. The cited
// support is `electron_browser_main_parts.cc` calling `OSCrypt::Init(local_state)`
// in browser main parts; whether that ordering holds relative to script
// execution is what this matrix is measuring. It must not be restated as a
// cause until a cell demonstrates it.
//
// Reproducing the product's timing is the point regardless. A child with no lock
// at all would have two cipher users running concurrently in a composition the
// product never has, and would prove nothing about the product.
let role = "only-instance";
if (useLock && !app.requestSingleInstanceLock()) {
  // The loser, exactly as the shipping app behaves.
  role = "second-instance-loser";
  emit({ verb, role, outcome: "lost-single-instance-lock" });
  app.exit(0);
} else if (!useLock) {
  // ADVERSARIAL CELL, labelled. No lock is taken, so two processes genuinely
  // share the profile. This is not the product's composition and a result here
  // must never be reported as product behaviour — it exists only to show what
  // concurrent cipher users do to the key, if anything.
  role = "no-lock-adversarial";
}

/** Closed metadata about the OSCrypt key. Never its value. */
function localState() {
  const file = path.join(profile, "Local State");
  if (!existsSync(file)) return { present: false };
  const bytes = readFileSync(file);
  const out = {
    present: true,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
  };
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    const key = parsed?.os_crypt?.encrypted_key;
    out.encryptedKey = typeof key === "string";
    out.encryptedKeyLength = out.encryptedKey ? key.length : 0;
  } catch {
    out.parseFailed = true;
  }
  return out;
}

/** The closed code, undecorated. See the comment at the catch site below. */
function classify(err) {
  return {
    outcome: "threw",
    code: typeof err?.code === "string" ? err.code : null,
    errorName: err?.constructor?.name ?? "Error",
  };
}

/**
 * Wait for the parent to say when to end.
 *
 * ## Why not stdin
 *
 * The first version read a command line from stdin. On Windows run
 * 34464477919 every cell released instantly with `released: "quit"`: a GUI
 * Electron process gets an immediately-closed stdin, `end` fired at once, and
 * the handler treated EOF as a command. Every cell then measured a process that
 * had already exited — the forced cells' `taskkill` returned 128 (gone), the
 * releases hit EPIPE, and the "second instance" found no lock to lose because
 * there was nothing left holding it.
 *
 * The lesson is not "stdin needs a guard". It is that **absence must never be
 * readable as a command**. A closed pipe, a missing file and a timeout all mean
 * "no instruction", and only a positive, authenticated instruction may release.
 *
 * ## The control file
 *
 * The parent writes `<token> <command>` to a path only this cell knows. The
 * token is per-child and must match, so a stale file from an earlier cell, a
 * truncated read mid-write, or an empty file cannot be mistaken for an order.
 * Nothing about the file NOT existing can release the child.
 */
async function waitForCommand() {
  const control = process.env["RELAYIUM_DURABILITY_CONTROL"];
  const token = process.env["RELAYIUM_DURABILITY_TOKEN"];
  if (!control || !token) return "no-control-channel";

  const deadline = Date.now() + holdMs;
  for (;;) {
    if (existsSync(control)) {
      try {
        const [got, command] = readFileSync(control, "utf8").trim().split(/\s+/);
        // Both halves required. A partial read during the parent's write yields
        // a mismatch and simply retries.
        if (got === token && typeof command === "string" && command.length > 0) return command;
      } catch {
        // Mid-write or transiently locked; retry rather than treat as an order.
      }
    }
    if (Date.now() > deadline) return "deadline";
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function finish(report) {
  report.localStateAtEnd = localState();
  // The barrier the parent waits on. Everything the cell does afterwards is
  // sequenced from here, not from a stopwatch started at spawn.
  emit(report);

  if (holdMs > 0) {
    const command = await waitForCommand();
    // Recorded so a cell that ran on the backstop rather than on an instruction
    // is visible as such, instead of looking like a clean run.
    emit({ verb, role, released: command });
    if (command === "exit") {
      app.exit(0);
      return;
    }
    app.quit();
    return;
  }
  if (exitMode === "quit") app.quit();
  else app.exit(0);
}

app.whenReady().then(async () => {
  const report = { verb, role, exitMode, useLock, available: false, localStateAtStart: localState() };
  try {
    report.available = safeStorage.isEncryptionAvailable();
    if (!report.available) {
      report.outcome = "cipher-unavailable";
      void finish(report);
      return;
    }

    const { SecretStore, electronCipher } = await import("../../dist/main/secrets.js");
    const store = new SecretStore(dataRoot, await electronCipher());

    if (verb === "seal") {
      await store.put("durability", FIXTURE);
      report.outcome = "sealed";
      // ## Read it back in the SAME process, immediately
      //
      // This is what separates "the write or the first process's own decrypt was
      // already broken" from "the key changed between processes". Without it, a
      // failing fresh-process read has two explanations and the matrix cannot
      // choose between them.
      try {
        const echoed = await store.get("durability");
        report.sameProcessRead = echoed === FIXTURE ? "ok" : "wrong-plaintext";
      } catch (err) {
        report.sameProcessRead = classify(err).code ?? "threw";
      }
    } else {
      // Round trip, not merely "did not throw": a store returning the wrong
      // plaintext is not readable.
      const value = await store.get("durability");
      report.outcome = value === FIXTURE ? "ok" : "wrong-plaintext";
    }
  } catch (err) {
    // ## The whole reason this harness exists
    //
    // `SecretStore.get` throws `SecretStoreError(kind)` where kind is one of
    // `not-found`, `unreadable`, `undecryptable` — an absent file, an IO or
    // permission failure, and a key that no longer decrypts what it encrypted.
    //
    // The product surface cannot tell them apart: `StoreHealth` is
    // `ok | unreadable | unavailable`, and `app-service.ts:339` maps everything
    // that is not `encryption-unavailable` onto `unreadable`. So the
    // `store: "unreadable"` both Windows runs reported is compatible with a key
    // mismatch AND with a plain read error.
    //
    // No production debug channel was added to obtain this; it is a test-only
    // probe against the real store.
    Object.assign(report, classify(err));
  }
  void finish(report);
});
