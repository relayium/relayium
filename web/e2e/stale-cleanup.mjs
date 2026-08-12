/**
 * Kill the browsers a previous run left behind, and be finished doing it before
 * this run starts its own.
 *
 * The cleanup is `pkill -f remote-debugging-port=<port>`. That pattern matches
 * the leftovers — and it matches the Chrome this harness is about to spawn just
 * as well, because the same flag is on its command line. So the two must not
 * overlap. The previous shape did overlap: it spawned the pkill, never looked at
 * it again, and slept a fixed 800ms. A pkill that had not yet been scheduled, or
 * was still walking a big process table, could therefore deliver its signal
 * AFTER the new browser existed and kill it — a failure that reads as "Chrome
 * died on startup for no reason", with nothing in the log connecting it to the
 * cleanup that caused it. The 800ms was never measured against anything either;
 * it was a guess standing in for the answer the child itself already has.
 *
 * So: wait for the child, do not guess. Everything below is about what to do
 * when waiting for it does not end the way it should.
 *
 * Split out of harness.mjs for the same reason chrome-process.mjs was: the
 * interesting behaviour is all on the failure path, and pinning it against the
 * real `pkill` would mean depending on how fast this machine forks — and on
 * being able to make pkill missing, broken or wedged on demand, which is not
 * something a test can portably arrange.
 */
import { spawn } from "node:child_process";

/**
 * How long the cleanup gets, in wall-clock ms.
 *
 * pkill is one pass over the process table (procfs on Linux, a sysctl snapshot
 * on macOS) followed by a few signals — single-digit milliseconds of work. The
 * budget is not sized for that work, it is sized for the machine: a cold, loaded
 * CI runner can take most of a second just to fork and exec the binary. 5s is
 * far above any healthy run and far below the 45s CDP readiness budget, so a
 * wedged cleanup surfaces as its own diagnostic long before the launch it
 * precedes can be mistaken for a slow browser.
 */
export const CLEANUP_TIMEOUT_MS = 5_000;

/**
 * How long the SIGKILL sent to a wedged cleanup gets to take effect.
 *
 * Short on purpose: SIGKILL is not refusable, so anything that outlives it is
 * blocked in the kernel (an uninterruptible read of a process table that is
 * itself the reason we are here), and waiting longer would not change the
 * outcome — only the point at which the harness says so.
 */
export const CLEANUP_REAP_GRACE_MS = 1_000;

/** The real thing. Isolated so tests never have to run it. */
export const spawnPkill = (pattern) => spawn("pkill", ["-f", pattern], { stdio: "ignore" });

/** Resolve with `null` if `promise` has not settled within `ms`.
 *  The timer is cleared on the winning path: an un-cleared one keeps the event
 *  loop alive, which in a test process shows up as a suite that has printed its
 *  results and still will not exit. */
const within = (promise, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); });
  });

/** `exit code 2` / `signal SIGTERM` — whichever actually happened. */
const describeEnd = ({ code, signal }) => (signal ? `signal ${signal}` : `exit code ${code}`);

/** Not a failure, and not silence either.
 *
 * Every case that lands here has one thing in common: the cleanup child is
 * GONE, so it cannot signal the browser this run is about to start — the race
 * is closed and continuing is safe. What it did not do is remove the leftovers,
 * and leftovers are not harmless: their tabs still hold signalling sockets, and
 * the server's per-IP /ws limit turns enough of them into "the two peers cannot
 * see each other" — a symptom identical to a real regression. Printing this line
 * is what lets whoever reads that failure connect it back to here. */
const warnDegraded = (pattern, what) => {
  console.warn(
    `  stale-browser cleanup (pkill -f ${pattern}) ${what} — leftover browsers from an earlier run may still be holding signalling sockets`,
  );
};

/**
 * Run the cleanup to completion, or fail the launch.
 *
 * Resolves with the outcome once the cleanup child is known to be gone:
 *   - `"killed"`   — it matched and signalled something (pkill exit 0)
 *   - `"no-match"` — there was nothing to kill (pkill exit 1), the healthy case
 *   - `"degraded"` — it could not be started, exited with an unexpected status,
 *                    or was itself killed; warned, not fatal (see `warnDegraded`)
 *
 * Throws only for the one case where continuing is NOT safe: the child is still
 * running when the budget expires. It is killed and reaped first, but the launch
 * still fails, because a cleanup that could not finish a millisecond of work in
 * seconds says the host's process table is not answering — and that is the same
 * process table the Chrome we would spawn next has to live in. Starting it
 * anyway would trade a precise error here for an unreadable one later.
 */
export async function cleanupStaleBrowsers({
  debugPort,
  timeoutMs = CLEANUP_TIMEOUT_MS,
  reapGraceMs = CLEANUP_REAP_GRACE_MS,
  spawnCleanup = spawnPkill,
} = {}) {
  const pattern = `remote-debugging-port=${debugPort}`;

  let child;
  try {
    child = spawnCleanup(pattern);
  } catch (err) {
    // A synchronous throw means no child exists at all, so there is nothing to
    // wait for and nothing that could signal our browser.
    warnDegraded(pattern, `could not be started (${err?.code ?? err?.message ?? err})`);
    return "degraded";
  }

  // Both listeners attached in the same tick as the spawn, and before the first
  // await: an `error` event with no listener is not a swallowed diagnostic, it
  // is an uncaught exception that takes the whole run down.
  const ended = new Promise((resolve) => {
    child.on("error", (err) => resolve({ spawnError: err }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  const end = await within(ended, timeoutMs);

  if (end === null) {
    // SIGKILL rather than SIGTERM: we have already decided this launch fails, so
    // there is no graceful shutdown worth waiting for, and a cleanup wedged past
    // its budget is exactly the kind that ignores a catchable signal.
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    const reaped = (await within(ended, reapGraceMs)) !== null;
    throw new Error(
      `stale-browser cleanup (pkill -f ${pattern}) did not finish within ${timeoutMs}ms\n`
      + `    action    : sent SIGKILL to pid ${child.pid ?? "?"}; ${reaped ? "it was reaped" : `it did NOT exit within a further ${reapGraceMs}ms`}\n`
      + `    why fatal : that cleanup pattern matches this harness's OWN Chrome, so starting one now risks having it killed by the cleanup mid-launch\n`
      + `    what next : check for a wedged pkill or an unresponsive process table on this host`,
    );
  }

  if (end.spawnError) {
    // Almost always ENOENT: no pkill on this host (a minimal container, or
    // Windows). It never execed, so it can never match anything.
    warnDegraded(pattern, `could not be started (${end.spawnError.code ?? end.spawnError.message})`);
    return "degraded";
  }
  // pkill's documented statuses: 0 = something matched and was signalled,
  // 1 = nothing matched. 1 is what a healthy run reports every single time, so
  // treating any non-zero status as trouble would warn on every launch.
  if (end.signal === null && end.code === 0) return "killed";
  if (end.signal === null && end.code === 1) return "no-match";
  // Everything else — 2 (usage), 3 (fatal), a status some other pkill uses, or
  // the cleanup being killed itself. It is over, so it is not a hazard; it just
  // did not do its job.
  warnDegraded(pattern, `ended with ${describeEnd(end)}`);
  return "degraded";
}
