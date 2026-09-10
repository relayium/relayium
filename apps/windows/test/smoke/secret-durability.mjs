// Why does a sealed identity stop being readable?
//
// Windows runs 34457162517 and 34460496151 both reported `store: "unreadable"`
// after a relaunch, with `Local State` byte-identical across every sample and
// the ciphertext byte-identical too.
//
// One HYPOTHESIS consistent with that: the key which reached disk was never the
// key the identity was sealed with. It is not the only one, it is not
// established, and nothing here may report it as the cause — the matrix exists
// to distinguish it from a plain read failure, not to confirm it.
//
// Nor is the control decisive on its own. If `no-second-graceful` fails, the
// crash and second-instance hypotheses are not the explanation for THAT cell —
// but a failure there does not rule out those mechanisms also acting in the
// cells that involve them. Causes can coexist; a red control narrows nothing by
// itself.
//
// The product surface cannot say which, because `StoreHealth` is
// `ok | unreadable | unavailable` and `app-service.ts:339` maps every non-
// availability failure onto `unreadable`. `SecretStore` itself distinguishes
// `not-found`, `unreadable` and `undecryptable`; this harness reads that closed
// code directly from the real store, without adding a production debug channel.
//
// Four cells, each on its own fresh profile so no cell can contaminate another:
//
//   | cell                    | ends by     | second instance |
//   |-------------------------|-------------|-----------------|
//   | no-second-graceful      | app.quit()  | no              |
//   | no-second-forced        | taskkill /F | no              |
//   | second-graceful         | app.quit()  | yes             |
//   | second-forced           | taskkill /F | yes             |
//
// `no-second-graceful` is the control. If it fails, neither the crash nor the
// second instance is the cause and both hypotheses are dead.
//
// Every cell records the seal process's own immediate read as well as the fresh
// process's read. Those answer different questions: the first says whether the
// write and same-key decrypt worked at all, the second whether the key survived
// the process boundary.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import electronPath from "electron";

const failures = [];
const cells = [];
/** Children this run spawned, held until their close is OBSERVED. */
const live = new Set();
/** Only directories this run created. */
const ownedDirs = [];

const CHILD = path.join(import.meta.dirname, "secret-durability-main.mjs");
/** Backstop only. The child is released by command, not by this elapsing. */
const HOLD_DEADLINE_MS = 120_000;
const BARRIER_TIMEOUT_MS = 60_000;
const CHILD_TIMEOUT_MS = 60_000;
const KILL_TIMEOUT_MS = 10_000;

function bail(reason) {
  process.stdout.write(`RELAYIUM_DURABILITY_SUITE ${JSON.stringify({ failures: [reason], cells: [] })}\n`);
  process.exit(1);
}

// Windows-only, and the child enforces it independently — on any other host it
// would reach the owner's real Keychain.
if (process.platform !== "win32") bail(`secret durability is Windows-only; ran on ${process.platform}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A child this run owns, from spawn to observed close.
 *
 * `close`, not `exit`: `exit` fires when the process ends, which can be before
 * its stdio has drained, so a report emitted just before termination can be
 * missed entirely.
 *
 * The PID stays owned until close is OBSERVED. Dropping it at kill time — which
 * an earlier revision did — meant a kill that silently failed left a live
 * process nothing would clean up, while the directory it was still writing into
 * was removed underneath it.
 */
class OwnedChild {
  constructor(label, child) {
    this.label = label;
    this.child = child;
    this.pid = child.pid ?? null;
    this.stdout = "";
    this.stderr = "";
    this.exit = null;
    this.signal = null;
    this.closed = false;
    this.killPerformed = null;
    live.add(this);
    child.stdout?.on("data", (d) => (this.stdout += d.toString()));
    child.stderr?.on("data", (d) => (this.stderr += d.toString()));
    this.closePromise = new Promise((resolve) => {
      child.on("close", (code, signal) => {
        this.exit = code;
        this.signal = signal ?? null;
        this.closed = true;
        live.delete(this);
        resolve();
      });
      // Recorded, but NOT treated as closure. `error` can fire after a process
      // has already started — a failed kill, a broken pipe — and a process that
      // errored is not a process that ended. Only `close` proves closed, so only
      // `close` releases ownership. If close never follows, the bounded join
      // below reports it and the child stays owned.
      child.on("error", (err) => {
        this.spawnError = String(err);
      });
    });
  }

  reports() {
    return this.stdout
      .split(/\r?\n/)
      .filter((l) => l.startsWith("RELAYIUM_DURABILITY "))
      .map((l) => {
        try {
          return JSON.parse(l.slice("RELAYIUM_DURABILITY ".length));
        } catch {
          return null;
        }
      })
      .filter((r) => r !== null);
  }

  /**
   * Wait until the child reports something matching `predicate`.
   *
   * THE barrier. The parent acts on what the child has actually done, never on
   * elapsed time: a slow start-up would otherwise have the second instance
   * launched, or the kill delivered, before the seal had happened at all, and
   * the cell would report a result about a sequence that never occurred.
   */
  async waitForReport(predicate, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.reports().find(predicate);
      if (found) return found;
      if (this.closed) return null;
      if (Date.now() > deadline) {
        failures.push(`${this.label}: never reported ${what} within ${timeoutMs}ms`);
        return null;
      }
      await sleep(50);
    }
  }

  release(command) {
    const stdin = this.child.stdin;
    if (!stdin) {
      failures.push(`${this.label}: no stdin to release through`);
      return false;
    }
    // EPIPE arrives as an asynchronous stream event, not as a throw from
    // `write`, so a try/catch alone would report success on a pipe that had
    // already closed and the cell would wait out its deadline believing it had
    // asked the child to quit.
    stdin.on("error", (err) => failures.push(`${this.label}: stdin error during release (${String(err)})`));
    try {
      stdin.write(`${command}\n`);
      stdin.end();
      return true;
    } catch (err) {
      failures.push(`${this.label}: could not release (${String(err)})`);
      return false;
    }
  }

  /**
   * Terminate, recording whether the termination actually happened.
   *
   * Asserting that a forced cell really was forced needs evidence the kill was
   * performed, not a note that it was requested.
   */
  kill() {
    if (this.pid === null || this.closed) return;
    // Bounded. Without a timeout `spawnSync` can block indefinitely, which
    // would make the "bounded" join above unbounded in exactly the situation it
    // exists for.
    const r = spawnSync("taskkill.exe", ["/PID", String(this.pid), "/T", "/F"], {
      stdio: "ignore",
      timeout: KILL_TIMEOUT_MS,
    });
    this.killPerformed = r.status === 0;
    if (r.error) failures.push(`${this.label}: taskkill did not complete (${String(r.error)})`);
    else if (r.status !== 0) failures.push(`${this.label}: taskkill failed with status ${r.status}`);
  }

  /** Join with a bounded escalation. Never returns before close is observed. */
  async join(timeoutMs) {
    if (await Promise.race([this.closePromise.then(() => true), sleep(timeoutMs).then(() => false)])) return true;
    this.kill();
    if (await Promise.race([this.closePromise.then(() => true), sleep(timeoutMs).then(() => false)])) return true;
    // Still owned, deliberately: cleanup must not delete a profile directory a
    // live process is still writing into.
    failures.push(`${this.label}: did not close after a bounded kill; pid ${this.pid} left running`);
    return false;
  }
}

function spawnChild(label, env, { withStdin = false } = {}) {
  return new OwnedChild(
    label,
    spawn(String(electronPath), [CHILD], {
      env: { ...process.env, ...env },
      stdio: [withStdin ? "pipe" : "ignore", "pipe", "pipe"],
    }),
  );
}

/** One matrix cell, on a profile and data root nothing else has touched. */
async function cell(name, { forced, secondInstance }) {
  const base = mkdtempSync(path.join(tmpdir(), "relayium-durability-"));
  ownedDirs.push(base);
  const profile = path.join(base, "profile");
  const dataRoot = path.join(base, "data");
  // Created before the child sets them. `app.setPath` was measured NOT to throw
  // on a missing directory, so a missing profile would not have failed loudly —
  // it would have produced a cell whose profile was wherever Electron went next.
  mkdirSync(profile, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });

  const env = {
    RELAYIUM_DURABILITY_PROFILE: profile,
    RELAYIUM_DURABILITY_DATA_ROOT: dataRoot,
    RELAYIUM_DURABILITY_LOCK: "1",
  };
  const record = { cell: name, endedBy: forced ? "forced-kill" : "graceful-quit", secondInstance };

  const seal = spawnChild(
    `${name}/seal`,
    { ...env, RELAYIUM_DURABILITY_VERB: "seal", RELAYIUM_DURABILITY_HOLD_MS: String(HOLD_DEADLINE_MS) },
    { withStdin: true },
  );
  const sealed = await seal.waitForReport((r) => typeof r.outcome === "string", BARRIER_TIMEOUT_MS, "a seal outcome");
  record.barrierObserved = sealed !== null;

  if (secondInstance) {
    if (!record.barrierObserved) {
      failures.push(`${name}: not starting a second instance — the seal barrier was never observed`);
    } else if (seal.closed) {
      failures.push(`${name}: the sealing process closed before a second instance could overlap it`);
    } else {
      const second = spawnChild(`${name}/second`, { ...env, RELAYIUM_DURABILITY_VERB: "read", RELAYIUM_DURABILITY_HOLD_MS: "0" });
      const overlapped = !seal.closed;
      const secondJoined = await second.join(CHILD_TIMEOUT_MS);
      if (!secondJoined) {
        failures.push(`${name}: aborting — the second instance never closed, so the profile may still be in use`);
        record.aborted = "second-instance-never-closed";
        cells.push(record);
        return;
      }
      const r = second.reports()[0] ?? null;
      record.secondInstanceResult = {
        overlappedLivePrimary: overlapped,
        originalExit: second.exit,
        outcome: r?.outcome ?? null,
        role: r?.role ?? null,
        error: second.spawnError ?? null,
      };
      if (!overlapped) failures.push(`${name}: the second instance did not overlap a live primary`);
      if (r?.outcome !== "lost-single-instance-lock") {
        failures.push(`${name}: the second instance did not lose the lock (${r?.outcome ?? "no report"})`);
      }
      if (second.exit !== 0) failures.push(`${name}: the second instance exited ${second.exit}, expected 0`);
    }
  }

  if (forced) seal.kill();
  else seal.release("quit");
  const sealJoined = await seal.join(CHILD_TIMEOUT_MS);

  const sealReport = seal.reports().find((r) => typeof r.outcome === "string") ?? null;
  record.seal = {
    originalExit: seal.exit,
    signal: seal.signal,
    // Surfaced, not just stored: an error that never reaches the report is the
    // same as a swallowed one.
    error: seal.spawnError ?? null,
    killPerformed: seal.killPerformed,
    released: seal.reports().find((r) => typeof r.released === "string")?.released ?? null,
    outcome: sealReport?.outcome ?? null,
    immediateRead: sealReport?.sameProcessRead ?? null,
    localStateAtStart: sealReport?.localStateAtStart ?? null,
    localStateAtEnd: sealReport?.localStateAtEnd ?? null,
  };
  // Asserted, not merely recorded: a "forced" cell whose kill silently failed
  // and a "graceful" cell that crashed would both otherwise look like data.
  if (forced && seal.killPerformed !== true) failures.push(`${name}: the forced kill was not performed`);
  if (!forced && seal.exit !== 0) failures.push(`${name}: graceful shutdown exited ${seal.exit}, expected 0`);
  if (!forced && record.seal.released !== "quit") {
    // A cell released by the deadline backstop was not driven by this parent;
    // whatever it measured, it did not measure a commanded graceful shutdown.
    failures.push(`${name}: graceful cell was released by "${record.seal.released ?? "nothing"}", not by command`);
  }

  // The join is what licenses the fresh read, so a join that did NOT close is
  // not something to continue past: a reader started against a profile another
  // process may still be writing measures that race, not the key lifecycle.
  if (!sealJoined) {
    failures.push(`${name}: aborting before the fresh read — the sealing process never closed`);
    record.aborted = "seal-never-closed";
    cells.push(record);
    return;
  }

  // No settle delay: the join above is the guarantee that nothing still holds
  // the profile. A sleep here would be a guess standing in for it.
  const read = spawnChild(`${name}/read`, { ...env, RELAYIUM_DURABILITY_VERB: "read", RELAYIUM_DURABILITY_HOLD_MS: "0" });
  await read.join(CHILD_TIMEOUT_MS);
  const readReport = read.reports()[0] ?? null;
  record.freshRead = {
    originalExit: read.exit,
    error: read.spawnError ?? null,
    outcome: readReport?.outcome ?? null,
    // `not-found` / `unreadable` / `undecryptable` — the closed cause the
    // product surface cannot express.
    code: readReport?.code ?? null,
    localStateAtStart: readReport?.localStateAtStart ?? null,
  };
  cells.push(record);

  if (record.seal.outcome !== "sealed") {
    failures.push(`${name}: seal did not complete (outcome ${record.seal.outcome ?? "none"}, exit ${record.seal.originalExit})`);
  }
  if (record.seal.immediateRead !== "ok") {
    failures.push(`${name}: the sealing process could not read back its own secret (${record.seal.immediateRead ?? "no report"})`);
  }
  if (record.freshRead.originalExit !== 0) {
    failures.push(`${name}: the fresh reader exited ${record.freshRead.originalExit}, expected 0`);
  }
  if (record.freshRead.outcome !== "ok") {
    failures.push(`${name}: a fresh process could not read the sealed secret (${record.freshRead.outcome ?? "no report"}${record.freshRead.code ? `, code ${record.freshRead.code}` : ""})`);
  }
}

async function cleanup() {
  // Bounded kill and join for anything still alive. Directories are removed
  // only afterwards: a live child still writing into a profile must not have it
  // deleted underneath it.
  for (const child of [...live]) {
    child.kill();
    await child.join(CHILD_TIMEOUT_MS);
  }
  if (live.size > 0) {
    // Conservative and deliberate: not "the dirs belonging to that child", but
    // all of them. A process that would not close cannot be assumed to be
    // writing only where its label says, and deleting a tree underneath a live
    // process is worse than leaving one behind on an ephemeral runner.
    failures.push(
      `${live.size} child process(es) never closed; retaining all ${ownedDirs.length} owned directories rather than deleting under a live process`,
    );
    return;
  }
  for (const dir of ownedDirs) {
    if (!existsSync(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Reported, never swallowed: a directory this run created and could not
      // remove is a leftover, and claiming otherwise would be false.
      failures.push(`could not remove owned directory ${dir}: ${String(err)}`);
    }
  }
}

async function main() {
  // Control first: if this fails, neither remaining hypothesis survives.
  await cell("no-second-graceful", { forced: false, secondInstance: false });
  await cell("no-second-forced", { forced: true, secondInstance: false });
  await cell("second-graceful", { forced: false, secondInstance: true });
  await cell("second-forced", { forced: true, secondInstance: true });
}

main()
  .catch((err) => failures.push(`threw: ${String(err?.stack ?? err)}`))
  .finally(async () => {
    await cleanup();
    process.stdout.write(`RELAYIUM_DURABILITY_SUITE ${JSON.stringify({ failures, cells }, null, 2)}\n`);
    if (failures.length > 0) {
      process.stderr.write(`secret durability: ${failures.length} failed\n${failures.join("\n")}\n`);
      process.exit(1);
    }
    process.stdout.write("secret durability: all cells sealed and read back\n");
    process.exit(0);
  });
