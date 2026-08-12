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
 * Waiting for the child is not the whole story either. `pkill` exiting 0 means
 * it DELIVERED SIGTERM to something matching this port — not that the something
 * is gone. The target still has to run its shutdown and close its listening
 * socket, and pkill returns without waiting for any of that. The new Chrome
 * needs that exact port, so spawning it inside that window either loses the
 * bind, or leaves readiness talking to the LEFTOVER browser, which answers CDP
 * perfectly well and is not the browser this run started. The retired 800ms
 * sleep papered over that window by accident; what closes it is looking at the
 * port itself (see `awaitPortRelease`).
 *
 * Split out of harness.mjs for the same reason chrome-process.mjs was: the
 * interesting behaviour is all on the failure path, and pinning it against the
 * real `pkill` would mean depending on how fast this machine forks — and on
 * being able to make pkill missing, broken or wedged on demand, which is not
 * something a test can portably arrange.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

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

/**
 * How long a SIGTERM'd browser gets to stop accepting on the debug port, in
 * wall-clock ms.
 *
 * A process that has been signalled releases its listening socket when it dies,
 * and the kernel does that part unconditionally — so this budget is really "how
 * long may a Chrome take to finish shutting down". Observed shutdowns are tens
 * of milliseconds; 2s is well above that and well below the 5s cleanup budget it
 * follows, so a port that is genuinely stuck reports itself here rather than
 * turning into an unreadable bind failure or, worse, a silent success driving
 * the previous run's browser.
 */
export const PORT_RELEASE_TIMEOUT_MS = 2_000;

/**
 * How often the port is re-checked while it is still accepting.
 *
 * One connect to loopback is microseconds of work, so the cadence only decides
 * how much of the release is spent sleeping past it. 25ms keeps the common case
 * — a browser that is already gone by the time pkill returns — indistinguishable
 * from not waiting at all.
 */
export const PORT_PROBE_INTERVAL_MS = 25;

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
 * Reject a budget or cadence that could not bound anything, before the cleanup
 * runs.
 *
 * Same two opposite failures as the readiness deadline: `Infinity`/`NaN` never
 * expires, so a port that is never released hangs the job with no diagnostic at
 * all, while `0` or a negative gives up before the first probe can answer. A
 * string compares fine and then prints as `"300"ms`. Checked BEFORE anything is
 * signalled, because an unusable setting is a programming error and killing
 * browsers on the way to reporting one would make it destructive as well.
 */
function checkedMs(name, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    const shown = typeof value === "string" ? JSON.stringify(value) : String(value);
    throw new Error(`${name} must be a finite number of milliseconds greater than 0 — got ${shown}`);
  }
  return value;
}

/**
 * Is 127.0.0.1:port still accepting TCP connections?
 *
 * The narrowest question that answers "has the listener let go": connect, and
 * hang up. Nothing is written and nothing is read — deliberately not an HTTP
 * request and not a CDP call, because a dying browser can hold the port open
 * while it has already stopped answering either, and any richer probe would call
 * that released. Refused means released; connected means still held.
 *
 * The socket is destroyed on every path, including the one where the error
 * arrives after we already answered — a probe that leaked one socket per attempt
 * would, at this cadence, leak them faster than the wait it belongs to.
 *
 * 127.0.0.1 specifically, matching what readiness later fetches: a probe of
 * `localhost` could resolve to ::1 on some hosts and report a completely
 * different socket free.
 */
const portAccepts = (debugPort, connectTimeoutMs) =>
  new Promise((resolve) => {
    // A synchronous throw here is a bad port number rather than a busy one; it
    // rejects this promise, and there is no socket to clean up.
    const socket = connect({ host: "127.0.0.1", port: debugPort });
    const finish = (accepting) => {
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(accepting);
    };
    // A connect that neither completes nor is refused counts as STILL HELD: on
    // loopback the usual cause is a listener whose accept queue is full, which
    // is precisely a port someone else still owns. Failing closed here only ever
    // costs the caller its budget, and the alternative — calling an unanswered
    // connect "free" — is the outcome this whole wait exists to prevent.
    socket.setTimeout(Math.max(1, connectTimeoutMs), () => finish(true));
    socket.once("connect", () => finish(true));
    // `on`, not `once`: the listener has to outlive the answer. A socket errors
    // again after being destroyed on some paths, and an `error` event with no
    // listener left is not a swallowed diagnostic — it is an uncaught exception
    // that takes the whole run down. `finish` is idempotent, so a late one is
    // simply ignored.
    socket.on("error", () => finish(false));
  });

/**
 * Block until the debug port stops accepting, or fail the launch.
 *
 * What this proves is narrow and worth stating exactly: the listener that pkill
 * signalled had let go of 127.0.0.1:<port> at the moment we last looked. It is
 * NOT a reservation. Nothing prevents another process from binding that port in
 * the microseconds between the final probe and Chrome's own bind, and no check
 * here could — a port cannot be held for someone else. The narrow claim is the
 * one that matters, because the process we just signalled is the one this race
 * is about.
 */
async function awaitPortRelease({ debugPort, pattern, timeoutMs, probeIntervalMs }) {
  // Monotonic: this is a duration, and a wall-clock step (NTP correcting a fresh
  // runner, a VM resuming) would otherwise silently shorten or extend it.
  const startedAt = performance.now();
  const remainingMs = () => timeoutMs - (performance.now() - startedAt);

  for (let probes = 1; ; probes++) {
    // Each connect is bounded by what is left of the budget, so a probe that
    // hangs cannot push the total past the number the caller chose.
    if (!(await portAccepts(debugPort, remainingMs()))) return;
    if (remainingMs() <= 0) {
      throw new Error(
        `stale-browser cleanup (pkill -f ${pattern}) signalled a browser, but 127.0.0.1:${debugPort} was still accepting connections ${timeoutMs}ms later\n`
        + `    action    : probed every ${probeIntervalMs}ms — ${probes} probe${probes === 1 ? "" : "s"}, all of them answered by something still listening\n`
        + `    why fatal : this run's Chrome has to bind that exact port; starting it now would either lose the bind or leave the harness driving the LEFTOVER browser, which answers CDP just as well\n`
        + `    what next : find what is holding it (lsof -iTCP:${debugPort} -sTCP:LISTEN) — a browser that outlived SIGTERM, or an unrelated process on the same port`,
      );
    }
    await sleep(Math.min(probeIntervalMs, Math.max(0, remainingMs())));
  }
}

/**
 * Run the cleanup to completion, or fail the launch.
 *
 * Resolves with the outcome once the cleanup child is known to be gone:
 *   - `"killed"`   — it matched and signalled something (pkill exit 0), AND the
 *                    debug port has since stopped accepting connections
 *   - `"no-match"` — there was nothing to kill (pkill exit 1), the healthy case
 *   - `"degraded"` — it could not be started, exited with an unexpected status,
 *                    or was itself killed; warned, not fatal (see `warnDegraded`)
 *
 * Throws for the two cases where continuing is NOT safe. One: the child is still
 * running when the budget expires. It is killed and reaped first, but the launch
 * still fails, because a cleanup that could not finish a millisecond of work in
 * seconds says the host's process table is not answering — and that is the same
 * process table the Chrome we would spawn next has to live in. Starting it
 * anyway would trade a precise error here for an unreadable one later. Two: it
 * signalled a browser that then would not let go of the debug port.
 */
export async function cleanupStaleBrowsers({
  debugPort,
  timeoutMs = CLEANUP_TIMEOUT_MS,
  reapGraceMs = CLEANUP_REAP_GRACE_MS,
  portReleaseTimeoutMs = PORT_RELEASE_TIMEOUT_MS,
  portProbeIntervalMs = PORT_PROBE_INTERVAL_MS,
  spawnCleanup = spawnPkill,
} = {}) {
  const pattern = `remote-debugging-port=${debugPort}`;
  // Before the spawn: see `checkedMs`.
  checkedMs("portReleaseTimeoutMs", portReleaseTimeoutMs);
  checkedMs("portProbeIntervalMs", portProbeIntervalMs);

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
  if (end.signal === null && end.code === 0) {
    // The only branch that waits on the port, and only because it is the only
    // one where we know a same-port listener was signalled and may still be
    // dying. `no-match` matched nothing, so anything on that port is not ours to
    // wait for — waiting anyway would turn an unrelated process that happens to
    // share the port into a failure at a budget nobody could see. The degraded
    // paths never delivered a signal either.
    await awaitPortRelease({
      debugPort,
      pattern,
      timeoutMs: portReleaseTimeoutMs,
      probeIntervalMs: portProbeIntervalMs,
    });
    return "killed";
  }
  if (end.signal === null && end.code === 1) return "no-match";
  // Everything else — 2 (usage), 3 (fatal), a status some other pkill uses, or
  // the cleanup being killed itself. It is over, so it is not a hazard; it just
  // did not do its job.
  warnDegraded(pattern, `ended with ${describeEnd(end)}`);
  return "degraded";
}
