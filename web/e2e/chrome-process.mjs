/**
 * Everything the harness knows about the Chrome process it spawned — kept in one
 * place so a launch failure can say WHY instead of `TypeError: fetch failed`.
 *
 * Two hosted runs failed exactly that way: the only line in the log was the raw
 * fetch error from the CDP wait loop, which is what escapes when Chrome is
 * spawned with `stdio: "ignore"` and neither its `error` nor its `exit` event is
 * observed. The port never answered, and the log could not distinguish
 * "the binary is not there", "it died on startup", "the sandbox killed it" and
 * "it is up but slow" — four unrelated causes with one indistinguishable
 * symptom. This module observes all three signals (spawn error, exit/signal,
 * stderr) so the next occurrence names its own cause.
 *
 * It is diagnostic only. It never converts a failure into a success, never
 * retries, and never touches the flags Chrome is launched with — it only decides
 * what the eventual error says.
 *
 * Split out of harness.mjs because a failing launch is otherwise untestable:
 * asserting on it would mean breaking a real Chrome on purpose. Here a plain
 * `node -e` child stands in for the browser, so every branch is deterministic.
 */

/** Bounds on what a failure is allowed to print.
 *
 * Chrome can write megabytes to stderr (GPU/DBus/sandbox noise repeated per
 * frame). Dumping that into a CI log buries the one line that matters and makes
 * the failure harder to read than no output at all, so a tail is not a memory
 * optimisation — it is the readable form. */
export const TAIL_CHARS = 4_000;
export const TAIL_LINES = 40;
export const TAIL_LINE_CHARS = 400;

/**
 * One line of child output, made safe to print.
 *
 * Chrome's stderr is not a trusted, well-behaved stream: it carries ANSI escapes
 * and raw control bytes that would rewrite the surrounding CI log, and — once
 * the debug port is up — the DevTools browser URL, whose UUID is the token that
 * grants full control of that browser. The port is local and about to be killed,
 * but a capability token has no business being archived in a build log.
 */
export function sanitizeOutputLine(line) {
  const flat = line
    // CSI escapes first (colour, cursor moves), then whatever control bytes are
    // left. Order matters: the second pass would otherwise strip the ESC and
    // leave a literal `[1;31m` behind as text.
    .replace(/\u001B\[[0-9;?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/(\/devtools\/(?:browser|page)\/)[0-9A-Za-z-]{8,}/g, "$1<redacted>")
    .trimEnd();
  return flat.length > TAIL_LINE_CHARS ? `${flat.slice(0, TAIL_LINE_CHARS)}\u2026` : flat;
}

/**
 * The last few non-empty lines of `text`, sanitized and bounded.
 *
 * Char bound first, then line bound: a single pathological line (a stack trace
 * printed without newlines) must not be able to defeat the line limit.
 */
export function boundedTail(text, { maxChars = TAIL_CHARS, maxLines = TAIL_LINES } = {}) {
  const clipped = text.length > maxChars ? text.slice(-maxChars) : text;
  const all = clipped.split("\n").map(sanitizeOutputLine).filter((l) => l !== "");
  const lines = all.length > maxLines ? all.slice(-maxLines) : all;
  return { lines, truncated: text.length > clipped.length || all.length > lines.length };
}

/** `exit code 1` / `signal SIGSEGV` / `exit code 0` — whichever actually happened. */
function describeExit(exit) {
  if (exit.signal) return `signal ${exit.signal}`;
  return `exit code ${exit.code}`;
}

/**
 * The failure text itself, as a pure function of observed state.
 *
 * Pure and exported so the wording is testable: this string IS the deliverable
 * of this checkpoint, and a diagnostic nobody asserts on is one refactor away
 * from silently going back to saying nothing.
 *
 * What it deliberately does NOT print: the environment, the profile directory's
 * contents, or Chrome's argv. The argv here holds no secrets, but it is long,
 * fixed, and readable in this file — printing it would only push the useful
 * lines off the screen.
 */
export function describeChromeFailure({
  executable, debugPort, pid, spawnError, exit, output, attempts, waitedMs, deadlineMs,
}) {
  const headline = spawnError
    ? `Chrome could not be started (${spawnError.code ?? "spawn failed"})`
    : exit
      ? `Chrome exited before its debug port answered (${describeExit(exit)})`
      : "Chrome is running but never answered on its debug port";

  const rows = [
    ["executable", executable],
    ["debug port", `${debugPort} (http://127.0.0.1:${debugPort}/json/version)`],
  ];
  if (pid != null) rows.push(["pid", String(pid)]);
  rows.push(["process", spawnError
    ? `never started — ${spawnError.message}`
    : exit ? `exited with ${describeExit(exit)}` : "still running"]);
  if (attempts != null) {
    const waited = waitedMs == null ? "" : ` over ~${(waitedMs / 1000).toFixed(1)}s`;
    rows.push(["cdp probes", `${attempts}${waited}, none answered`]);
  }
  // Only when the deadline is what ended the wait — a process that died has a
  // better answer already, and offering both would blur the two.
  //
  // It names the configured budget AND the time actually waited, because those
  // are different facts: the budget says what this run was willing to tolerate,
  // the wait says what it really spent. A probe count said neither, which is how
  // a hosted timeout could stop at exactly 42 refusals without anyone being able
  // to tell whether Chrome was slow or stuck.
  if (deadlineMs != null) {
    const waited = waitedMs == null ? "" : ` (waited ~${Math.round(waitedMs)}ms)`;
    rows.push(["gave up", `reached the configured ${deadlineMs}ms readiness deadline${waited}`]);
  }

  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = [headline, ...rows.map(([k, v]) => `    ${k.padEnd(width)} : ${v}`)];

  if (!output || output.lines.length === 0) {
    // Say which of the two silences this is. "Chrome printed nothing" is itself
    // evidence — a binary that never got as far as its own logging fails
    // differently from one that logged an error.
    lines.push(`    chrome stderr : (nothing was captured)`);
  } else {
    const n = output.lines.length;
    const how = output.truncated
      ? `last ${n} lines, earlier output dropped`
      : `${n} line${n === 1 ? "" : "s"}`;
    lines.push(`    chrome stderr (${how}):`);
    for (const l of output.lines) lines.push(`      | ${l}`);
  }
  return lines.join("\n");
}

/**
 * Watch a spawned Chrome: its spawn error, its exit, and a bounded tail of its
 * stderr.
 *
 * Attach this in the same tick as the spawn. `error` is the reason: an
 * unobserved `error` event on a ChildProcess is not a swallowed diagnostic, it
 * is an uncaught exception that takes the whole run down with a stack pointing
 * at Node internals rather than at the harness.
 */
export function watchChromeProcess(child, { executable, debugPort }) {
  let spawnError = null;
  let exit = null;
  let buffer = "";
  let capturedChars = 0;
  let settle;
  /** Resolves the first time the process is known to be unusable.
   *
   *  The launch loop does not await this — it polls `deadState()` on the probe
   *  cadence it already had, so the retry timing is untouched. It exists for the
   *  tests, which need to await the transition rather than sleep and hope.
   *  Never rejects: an unawaited rejection here would be an unhandled rejection. */
  const died = new Promise((resolve) => { settle = resolve; });

  child.on("error", (err) => {
    spawnError ??= err;
    settle();
  });
  child.on("exit", (code, signal) => {
    exit ??= { code, signal };
    settle();
  });

  const onData = (chunk) => {
    capturedChars += chunk.length;
    buffer += chunk;
    // Halve-when-doubled rather than slicing on every chunk: same bound, but it
    // does not turn a chatty Chrome into O(n²) string copying.
    if (buffer.length > TAIL_CHARS * 2) buffer = buffer.slice(-TAIL_CHARS);
  };
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", onData);
  }

  const output = () => {
    const tail = boundedTail(buffer);
    return { ...tail, truncated: tail.truncated || capturedChars > buffer.length };
  };

  return {
    died,
    /** null while the process is still a plausible browser. */
    deadState: () => (spawnError ? { spawnError } : exit ? { exit } : null),
    output,
    /**
     * Wait, briefly and boundedly, for stderr to finish arriving.
     *
     * `exit` can fire before the last stderr chunks have been delivered, so a
     * failure reported the instant the process dies can print "(nothing was
     * captured)" for a Chrome that did explain itself — exactly the diagnostic
     * hole this module exists to close. Only ever awaited on the failure path,
     * and capped: a process that is still alive never closes its stderr.
     */
    drain(ms) {
      const s = child.stderr;
      if (!s || s.destroyed || s.closed) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          s.off("close", done);
          s.off("end", done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        s.on("close", done);
        s.on("end", done);
      });
    },
    /**
     * The error to throw. `cause` is the raw fetch failure, kept both as
     * `err.cause` and in the text: the e2e scripts print `err.stack`, which does
     * not include a cause, so a cause that only lives on the property is a cause
     * nobody in CI will ever see.
     */
    failure({ attempts, waitedMs, cause, deadlineMs } = {}) {
      let text = describeChromeFailure({
        executable, debugPort, pid: child.pid, spawnError, exit, output: output(),
        attempts, waitedMs, deadlineMs,
      });
      if (cause) text += `\n    caused by: ${cause}`;
      return new Error(text, { cause });
    },
    /** Drop the stderr pipe once the launch is over. The `error` listener stays
     *  attached on purpose — removing it would re-arm the uncaught-exception
     *  path for a late error (e.g. from `kill()`) during teardown. */
    dispose() {
      child.stderr?.off("data", onData);
      child.stderr?.destroy();
    },
  };
}
