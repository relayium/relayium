/**
 * Stop the one browser process the harness spawned — and KNOW that it stopped.
 *
 * The previous close was `chrome.kill()` followed by a fixed 500ms sleep. That
 * sends one SIGTERM and never looks at the process again. On about:blank that is
 * enough; after a real session it is not: Chrome treats the first SIGTERM as a
 * request for a graceful shutdown, a live page can hold that shutdown open, and
 * the harness then deleted the profile out from under a browser that was still
 * running and returned. Node exits, the browser is reparented to PID 1, and it
 * keeps its debug port and its signalling WebSockets — measured on 2026-09-23
 * after a real native pairing round (Chrome main survived with PPID 1; one more
 * TERM by exact PID ended it). The next launch on the same port masked that by
 * pkilling it, which is why it read as harmless.
 *
 * So the shape is the one `startPreview` and the stale-browser cleanup already
 * use: SIGTERM, a bounded wait for the child's own `exit`, SIGKILL, a bounded
 * wait again. Nothing here matches by name, port or pattern: the only process
 * ever signalled is the ChildProcess handle the caller spawned. A personal
 * Chrome, another run's Chrome, or a stale one on another port is never touched.
 *
 * Deliberately NOT in scope (recorded, not solved here): Chrome's own helper
 * processes are Chrome's to reap once its main process is gone, and a
 * termination signal delivered to Node while `launchBrowser` is still waiting
 * for CDP, or a `withWatchdog` hard timeout that calls `process.exit`, still
 * bypasses this close. Fixing those needs a process-wide registry of owned
 * children, which is a different change.
 *
 * Split out of harness.mjs so the escalation can be tested against a real child
 * that refuses SIGTERM, without a real browser.
 */

/** How long Chrome gets to shut down gracefully after SIGTERM. A healthy
 *  headless Chrome exits in well under a second; a session that blocks the
 *  graceful path does not exit at all, so waiting longer buys nothing.
 *
 *  TERM + KILL grace stays under the ~5s the acceptance shell's
 *  `terminate_children` gives a browser half before SIGKILLing its Node — the
 *  close that Node runs from its SIGTERM handler must finish inside that. */
export const CLOSE_TERM_GRACE_MS = 2_000;

/** How long SIGKILL gets to take effect. It cannot be refused; a process that
 *  outlives this is stuck in the kernel and waiting longer would only delay
 *  saying so. */
export const CLOSE_KILL_GRACE_MS = 2_000;

/** Has this ChildProcess been observed to end? Node sets exactly one of these
 *  when it reaps the child, before it emits `exit`. */
const ended = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Stop `child` and report what was actually observed.
 *
 * Resolves (never rejects) to `{ exited, via }`:
 *   - `exited: true` only when the process is known not to be running: it was
 *     never spawned (no pid — ENOENT/EACCES), it had already exited, or its
 *     `exit` was observed after our signal;
 *   - `via`: "never-spawned" | "already-exited" | "SIGTERM" | "SIGKILL", or
 *     `null` when even SIGKILL was not observed to take effect.
 *
 * Never rejecting is load-bearing: this runs in `finally` blocks and on the
 * launch-failure path, where a throw would replace the error that explains the
 * run with one about teardown.
 *
 * Not idempotent by itself — calling it twice signals twice. The harness
 * memoises its close, so there is exactly one call per spawned child.
 */
export async function stopOwnedChild(child, { termGraceMs = CLOSE_TERM_GRACE_MS, killGraceMs = CLOSE_KILL_GRACE_MS } = {}) {
  // A failed spawn has no pid and never had a process. Its `error` event may
  // not have been delivered yet, so this is the only synchronous signal of it.
  if (child.pid === undefined) return { exited: true, via: "never-spawned" };
  if (ended(child)) return { exited: true, via: "already-exited" };

  // Attached synchronously after the check above, so an exit cannot slip in
  // between them: Node only reaps on a later event-loop turn.
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const observe = async (ms) => {
    let timer;
    await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
    return ended(child);
  };

  for (const [signal, graceMs] of [["SIGTERM", termGraceMs], ["SIGKILL", killGraceMs]]) {
    // `kill` reports an already-reaped or vanished child as `false`; it only
    // throws for an invalid signal. Neither outcome changes what we do next,
    // which is to look at the child rather than trust the return value.
    try { child.kill(signal); } catch { /* observed below */ }
    if (await observe(graceMs)) return { exited: true, via: signal };
  }
  return { exited: false, via: null };
}

/**
 * The harness's whole close after the CDP socket: stop the child, then — only
 * once it is known to be gone — run `removeProfile` (null when the caller asked
 * to keep it). A child that was not observed to exit keeps its profile and gets
 * one truthful warning instead of a throw, for the reason `stopOwnedChild`
 * never rejects. `dispose` releases the stderr pipe after the exit, so a chatty
 * shutdown can neither block on a full pipe nor die of EPIPE.
 */
export async function closeOwnedBrowser(child, { removeProfile, dispose, warn = console.warn, ...graces }) {
  const stopped = await stopOwnedChild(child, graces);
  dispose?.();
  if (!stopped.exited) {
    warn(`  chrome pid ${child.pid} was not observed to exit after SIGTERM and SIGKILL; its temporary profile was left in place`);
  } else {
    removeProfile?.();
  }
  return stopped;
}
