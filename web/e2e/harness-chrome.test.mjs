/**
 * @vitest-environment node
 *
 * Node, not jsdom: everything here spawns real child processes and talks to a
 * real loopback socket, which is what the e2e harness itself does. Running it
 * under jsdom would test jsdom's `fetch`/`WebSocket` shims instead of the ones
 * `launchBrowser` will actually use.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedTail, sanitizeOutputLine, watchChromeProcess } from "./chrome-process.mjs";
import { launchBrowser, resolveChrome, sleep } from "./harness.mjs";

const originalChromePath = process.env.CHROME_PATH;
const temporary = [];
const children = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "relayium-chrome-path-"));
  temporary.push(dir);
  return dir;
}

/** A stand-in for Chrome: a child whose exit code, signal and stderr we choose.
 *  Piped exactly like the real spawn, so the watcher is exercised as shipped.
 *
 *  `sh`, not `node -e`: this suite runs alongside ~200 other test files, and a
 *  handful of extra Node startups is enough CPU to time out a neighbour that was
 *  passing. A shell costs a fraction of that and says the same thing. */
function fakeChrome(script) {
  const child = spawn("/bin/sh", ["-c", script], { stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  return child;
}

const watchFake = (child, over = {}) =>
  watchChromeProcess(child, { executable: "/fake/chrome", debugPort: 9999, ...over });

/** Profile directories `launchBrowser` may have created, by name. The cleanup
 *  assertions compare before/after rather than guessing the mkdtemp suffix. */
const profileDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("relayium-e2e-"));

afterEach(async () => {
  if (originalChromePath === undefined) delete process.env.CHROME_PATH;
  else process.env.CHROME_PATH = originalChromePath;
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Held sockets first, then the server: an upgraded socket is detached from the
  // server, so `close()` alone would neither reach it nor ever complete.
  for (const { server, held } of silentServers.splice(0)) {
    for (const socket of held) socket.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  // The plain TCP listeners standing in for a not-yet-dead stale browser. A
  // leaked one would keep its port occupied for the whole file, so the NEXT test
  // that uses that port would fail for a reason that has nothing to do with it.
  for (const { shutdown } of heldPorts.splice(0)) await shutdown();
});

describe("Chrome path resolution", () => {
  it("honours an explicit executable file", () => {
    const path = join(tempDir(), "chrome");
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    process.env.CHROME_PATH = path;

    expect(resolveChrome()).toBe(path);
  });

  it("rejects a missing explicit path instead of silently falling back", () => {
    process.env.CHROME_PATH = join(tempDir(), "missing");
    expect(() => resolveChrome()).toThrow(/there is no such file/);
  });

  it("rejects a directory with an actionable error", () => {
    const path = join(tempDir(), "Chrome.app");
    mkdirSync(path);
    process.env.CHROME_PATH = path;
    expect(() => resolveChrome()).toThrow(/directory, not an executable/);
  });

  it("rejects a regular file without execute permission", () => {
    const path = join(tempDir(), "chrome");
    writeFileSync(path, "not executable\n");
    chmodSync(path, 0o644);
    process.env.CHROME_PATH = path;
    expect(() => resolveChrome()).toThrow(/not executable by this user/);
  });
});

// ── what a failed launch is allowed to print ────────────────────────────────

describe("child output sanitising", () => {
  it("strips ANSI colour and raw control bytes", () => {
    const line = sanitizeOutputLine("\u001B[1;31mFATAL\u001B[0m: \u0007gpu \u0000init\r");
    expect(line).toBe("FATAL: gpu init");
  });

  it("redacts the DevTools token, which grants control of that browser", () => {
    const line = sanitizeOutputLine(
      "DevTools listening on ws://127.0.0.1:9446/devtools/browser/3f2a1c9e-77bd-4f1a-9c02-5d6e0b1a2c34",
    );
    expect(line).toBe("DevTools listening on ws://127.0.0.1:9446/devtools/browser/<redacted>");
    expect(line).not.toMatch(/3f2a1c9e/);
  });

  it("caps a single pathological line", () => {
    const line = sanitizeOutputLine("x".repeat(5_000));
    expect(line.length).toBeLessThanOrEqual(401);
    expect(line.endsWith("…")).toBe(true);
  });

  it("keeps the last lines, drops the earlier ones, and says so", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const tail = boundedTail(text, { maxChars: 4_000, maxLines: 5 });
    expect(tail.lines).toEqual(["line 495", "line 496", "line 497", "line 498", "line 499"]);
    expect(tail.truncated).toBe(true);
  });

  it("reports short output verbatim and untruncated", () => {
    const tail = boundedTail("one\n\ntwo\n");
    expect(tail.lines).toEqual(["one", "two"]);
    expect(tail.truncated).toBe(false);
  });
});

describe("watching the Chrome process", () => {
  it("names a spawn failure instead of leaving it to a fetch error", async () => {
    // An unlistened `error` event would abort this test file outright — so the
    // test passing at all is itself the assertion that the listener is attached.
    const missing = join(tempDir(), "not-a-browser");
    const child = spawn(missing, [], { stdio: ["ignore", "ignore", "pipe"] });
    children.push(child);
    const watch = watchChromeProcess(child, { executable: missing, debugPort: 9451 });

    await watch.died;
    expect(watch.deadState().spawnError.code).toBe("ENOENT");

    const cause = new TypeError("fetch failed");
    const err = watch.failure({ attempts: 42, waitedMs: 10_250, cause });
    expect(err.message).toMatch(/Chrome could not be started \(ENOENT\)/);
    expect(err.message).toContain(missing);
    expect(err.message).toContain("9451");
    expect(err.message).toMatch(/chrome stderr : \(nothing was captured\)/);
    expect(err.cause).toBe(cause);
  });

  it("reports an early non-zero exit together with what Chrome printed", async () => {
    const watch = watchFake(fakeChrome(
      'echo "Failed to move to new namespace: PID namespaces supported" >&2;'
      + 'echo "Check failed: !sandbox" >&2;'
      + "exit 3",
    ));

    await watch.died;
    await watch.drain(2_000);
    expect(watch.deadState().exit).toEqual({ code: 3, signal: null });

    const err = watch.failure({ attempts: 2, waitedMs: 300, cause: new TypeError("fetch failed") });
    expect(err.message).toMatch(/Chrome exited before its debug port answered \(exit code 3\)/);
    expect(err.message).toContain("Failed to move to new namespace");
    expect(err.message).toContain("Check failed: !sandbox");
    expect(err.message).toMatch(/cdp probes\s+: 2 over ~0\.3s, none answered/);
    // The raw cause survives in the text too: the e2e scripts print `err.stack`,
    // which never includes `err.cause`.
    expect(err.message).toMatch(/caused by: TypeError: fetch failed/);
  });

  it("names the signal when Chrome is killed rather than exiting", async () => {
    // `exec` so the pid we hold IS the sleeping process: without it the signal
    // would land on the shell and the test would prove nothing about the child.
    const child = fakeChrome('echo alive >&2; exec sleep 60');
    const watch = watchFake(child);
    await sleep(100);
    child.kill("SIGKILL");

    await watch.died;
    expect(watch.deadState().exit.signal).toBe("SIGKILL");
    expect(watch.failure({}).message).toMatch(/Chrome exited before its debug port answered \(signal SIGKILL\)/);
  });

  it("bounds a torrent of stderr and keeps the newest lines", async () => {
    const watch = watchFake(fakeChrome(
      "echo FIRST-LINE >&2;"
      + `yes "noise ${"y".repeat(100)}" | head -n 2000 >&2;`
      + "echo LAST-LINE >&2;"
      + "exit 1",
    ));

    await watch.died;
    await watch.drain(2_000);
    const out = watch.output();
    expect(out.lines.length).toBeLessThanOrEqual(40);
    expect(out.lines.join("\n").length).toBeLessThanOrEqual(4_000);
    expect(out.truncated).toBe(true);
    expect(out.lines.at(-1)).toBe("LAST-LINE");
    expect(out.lines.join("\n")).not.toContain("FIRST-LINE");
  });

  it("wraps the fetch failure when Chrome is alive but the port never answers", async () => {
    const child = fakeChrome('echo "[0812/1030:ERROR:socket.cc(4)] bind failed" >&2; exec sleep 60');
    const watch = watchFake(child, { debugPort: 9452 });
    await sleep(150);
    await watch.drain(500);

    expect(watch.deadState()).toBeNull();
    const cause = new TypeError("fetch failed");
    const err = watch.failure({ attempts: 42, waitedMs: 10_250, cause });
    expect(err.message).toMatch(/Chrome is running but never answered on its debug port/);
    expect(err.message).toMatch(/process\s+: still running/);
    expect(err.message).toContain(String(child.pid));
    expect(err.message).toMatch(/cdp probes\s+: 42 over ~10\.3s, none answered/);
    expect(err.message).toContain("bind failed");
    expect(err.cause).toBe(cause);
  });

  it("prints no environment, no argv and no profile path of its own", async () => {
    const watch = watchFake(fakeChrome("exit 1"), { executable: "/fake/chrome" });
    await watch.died;
    const message = watch.failure({ attempts: 1, waitedMs: 0 }).message;
    expect(message).not.toMatch(/--user-data-dir|--headless|PATH=|HOME=/);
  });

  it("releases the stderr pipe on dispose without losing what it captured", async () => {
    const child = fakeChrome('echo kept >&2; exec sleep 60');
    const watch = watchFake(child);
    await sleep(150);

    watch.dispose();
    expect(child.stderr.destroyed).toBe(true);
    expect(watch.output().lines).toEqual(["kept"]);
    // Disposing twice, and draining a pipe that is already gone, must not hang.
    watch.dispose();
    await watch.drain(1_000);
  });
});

// ── the whole launch, driven by a stand-in browser ──────────────────────────
//
// These run `launchBrowser` for real, with CHROME_PATH pointing at a script
// that plays a browser. That is the only way to prove the parts that only exist
// on the failure path: that the diagnostic reaches the caller, that it arrives
// promptly instead of after the full ~10s of probes, and that the temporary
// profile is still cleaned up when the launch fails.
//
// POSIX only: the stand-in is a `#!/bin/sh` wrapper, and the Windows CI job runs
// a single named test file, not this one.
const posixOnly = process.platform === "win32" ? it.skip : it;

/** An executable `resolveChrome` will accept and `launchBrowser` will spawn. */
function browserBinary(script) {
  const bin = join(tempDir(), "chrome");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** The same, for the one stand-in that has to speak HTTP and WebSocket.
 *  `exec` matters: it keeps ONE pid, so `chrome.kill()` reaches the server
 *  instead of orphaning it behind a shell that dies alone. */
const nodeBrowserBinary = (body) => {
  const script = join(tempDir(), "fake-chrome.mjs");
  writeFileSync(script, body);
  return browserBinary(`exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"`);
};

/** A stand-in that answers /json/version and completes ONE WebSocket handshake —
 *  just enough of CDP for `launchBrowser` to consider the browser up.
 *
 *  `startDelayMs` makes it a SLOW browser rather than a broken one: until it
 *  listens, the port refuses connections instantly, which is exactly what hosted
 *  run 31554507246 saw — a live child, empty stderr, and 42 immediate refusals.
 *  A delayed listen reproduces that shape deterministically, without needing a
 *  real Chrome to be slow on demand. */
const cdpServerSource = ({ startDelayMs = 0 } = {}) => `
import { createServer } from "node:http";
import { createHash } from "node:crypto";

const port = Number(process.argv.find((a) => a.startsWith("--remote-debugging-port=")).split("=")[1]);
const wsUrl = \`ws://127.0.0.1:\${port}/devtools/browser/3f2a1c9e-77bd-4f1a-9c02-5d6e0b1a2c34\`;

const server = createServer((req, res) => {
  if (req.url !== "/json/version") { res.statusCode = 404; res.end(); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: wsUrl }));
});
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1")
    .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n" +
    \`Sec-WebSocket-Accept: \${accept}\\r\\n\\r\\n\`,
  );
});
const listen = () => server.listen(port, "127.0.0.1", () => process.stderr.write(\`DevTools listening on \${wsUrl}\\n\`));
${startDelayMs > 0 ? `setTimeout(listen, ${startDelayMs});` : "listen();"}
`;

const answers = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    await res.arrayBuffer();
    return true;
  } catch { return false; }
};

describe("launchBrowser", () => {
  posixOnly("fails with the exit code and Chrome's own words, not `fetch failed`", async () => {
    process.env.CHROME_PATH = browserBinary(
      'echo "[0812/103000.1:ERROR:zygote_host_impl_linux.cc(90)] Running as root without --no-sandbox" >&2\nexit 7',
    );
    const before = profileDirs();

    const started = Date.now();
    const err = await launchBrowser({ debugPort: 9461 }).then(
      (session) => { session.close(); throw new Error("a browser that exited 7 must not launch"); },
      (e) => e,
    );
    const elapsed = Date.now() - started;

    expect(err.message).toMatch(/Chrome exited before its debug port answered \(exit code 7\)/);
    expect(err.message).toContain("Running as root without --no-sandbox");
    // Promptly, and provably so: it gave up within a few probes of noticing the
    // exit, rather than spending all 42 on a process it already knew was gone.
    expect(Number(err.message.match(/cdp probes\s+: (\d+) over /)[1])).toBeLessThan(20);
    expect(elapsed).toBeLessThan(6_000);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 20_000);

  posixOnly("carries Chrome's stderr into the thrown error", async () => {
    process.env.CHROME_PATH = nodeBrowserBinary(
      'process.stderr.write("Failed to create a ProcessSingleton for your profile directory\\n");'
      + "process.exit(1);",
    );
    await expect(launchBrowser({ debugPort: 9462 })).rejects.toThrow(/Failed to create a ProcessSingleton/);
  }, 20_000);

  posixOnly("still connects, and still cleans up, when the browser is healthy", async () => {
    const port = 9463;
    process.env.CHROME_PATH = nodeBrowserBinary(cdpServerSource());
    const before = profileDirs();

    const session = await launchBrowser({ debugPort: port });
    expect(session.browser).toBeTruthy();
    expect(await answers(port)).toBe(true);

    await session.close();
    // The process is gone (nothing answers the port) and so is the profile:
    // piping stderr must not leave a live child or an orphaned directory.
    for (let i = 0; i < 20 && (await answers(port)); i++) await sleep(100);
    expect(await answers(port)).toBe(false);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 20_000);

  posixOnly("keeps the profile when asked to, and cleans it up otherwise", async () => {
    process.env.CHROME_PATH = nodeBrowserBinary("process.exit(2);");
    const before = profileDirs();

    await expect(launchBrowser({ debugPort: 9464, keep: true })).rejects.toThrow(/exit code 2/);
    const kept = profileDirs().filter((n) => !before.includes(n));
    expect(kept).toHaveLength(1);
    rmSync(join(tmpdir(), kept[0]), { recursive: true, force: true });
  }, 20_000);
});

// ── how long a launch is willing to wait ────────────────────────────────────
//
// Hosted run 31554507246 attempt 4 gave up after exactly 42 refused probes in
// ~10.3s — the old count-based ceiling, hit to the probe. That number answered
// the wrong question: it said how many times we asked, not how long we were
// prepared to wait, so the log could not tell "Chrome is slow" from "Chrome is
// stuck". These tests pin the replacement: ONE slow stand-in browser, two
// deadlines, opposite outcomes.

/** Long enough that a give-up at a sub-second deadline cannot race the listen,
 *  short enough that the run which waits it out stays about a second.
 *
 *  It used to be 3s, from when the deadline was only consulted between probes
 *  and a give-up could therefore overshoot its budget by a whole probe. Now that
 *  every phase is cut off at the deadline itself, the give-up lands within a few
 *  ms of it and the margin no longer has to absorb that overshoot. */
const SLOW_START_MS = 1_500;
const SLOW_CDP_SERVER = cdpServerSource({ startDelayMs: SLOW_START_MS });

/**
 * A server on the debug port that ACCEPTS the connection and then goes silent.
 *
 * This is the shape a deadline checked only BETWEEN phases cannot bound: the
 * connect succeeds, so there is no rejection to catch, and the harness sits
 * inside one phase with every check after it unreachable. The refused port of
 * the slow stand-in above never exercises that, because it fails fast.
 *
 * In-process, and already listening before the launch starts, on purpose:
 *
 *   - deterministic. A spawned Node stand-in needs ~0.1–0.8s to reach `listen`
 *     (a freshly written executable pays a cold first spawn), which is longer
 *     than the deadlines under test — the harness would give up on a refused
 *     port and prove nothing about a hang.
 *   - observable. "Did the harness let go of the connection it abandoned" is
 *     not a question the client side can answer about itself; the server end
 *     can see it directly.
 *
 * `deafUpgrade` chooses WHICH phase hangs. Without it, `/json/version` never
 * answers. With it, the probe answers normally and the WebSocket upgrade is
 * what never completes. Same symptom, different bug, and a harness that bounds
 * only the fetch passes the first and hangs on the second.
 */
const silentServers = [];
function silentServer(port, { deafUpgrade = false } = {}) {
  const wsUrl = `ws://127.0.0.1:${port}/devtools/browser/3f2a1c9e-77bd-4f1a-9c02-5d6e0b1a2c34`;
  /** The sockets whose phase is the one that hangs. */
  const held = [];
  const server = createServer((req, res) => {
    req.resume();
    if (!deafUpgrade) return; // no status line, no headers, no close — ever
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ Browser: "FakeChrome/1.0", webSocketDebuggerUrl: wsUrl }));
  });
  const hold = (socket) => { socket.on("error", () => {}); held.push(socket); };
  // Accept the upgrade and never write the 101 that would open it. `resume()`
  // so the peer's FIN is actually read — an upgraded socket is detached from the
  // HTTP server and nothing else would pull from it. The probe's own connection
  // is NOT held in this mode: undici keeps it alive in its pool after a
  // successful fetch, so it says nothing about what the harness abandoned.
  if (deafUpgrade) server.on("upgrade", (req, socket) => { socket.resume(); hold(socket); });
  else server.on("connection", hold);
  silentServers.push({ server, held });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ held })));
}

/** Did the client end release every socket we are holding? A harness that gave
 *  up on a phase without aborting it leaves them open indefinitely.
 *
 *  "Our end saw the peer go away", not `destroyed`: a socket detached by an HTTP
 *  upgrade stays half-open until the SERVER closes its own side too, so
 *  `destroyed` alone would be a fact about this stub rather than about the
 *  harness. */
const released = async (held) => {
  const gone = (s) => s.destroyed || !s.readable;
  for (let i = 0; i < 40 && held.some((s) => !gone(s)); i++) await sleep(50);
  return held.length > 0 && held.every(gone);
};

/** Is the pid the diagnostic named really gone? Signal 0 is the ask-don't-send
 *  probe; it throws ESRCH once the process no longer exists. */
const reaped = async (pid) => {
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { return true; }
    await sleep(50);
  }
  return false;
};

/** A stand-in that is alive, silent, and — unlike every other one here —
 *  deliberately does NOT open the debug port. Whatever the test put on that port
 *  is what readiness then talks to. */
const idleBrowser = () => browserBinary("exec sleep 60");

/** Capture the harness's own stdout for the duration of `run`. */
async function withCapturedLog(run) {
  const lines = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line) => { lines.push(String(line)); });
  try { return { value: await run(), lines }; } finally { spy.mockRestore(); }
}

/** The same for its warnings — the channel the cleanup step degrades onto.
 *  Captured rather than allowed through: a warning printed by a passing test
 *  reads, in a CI log, exactly like a warning from the code under test. */
async function withCapturedWarn(run) {
  const lines = [];
  const spy = vi.spyOn(console, "warn").mockImplementation((line) => { lines.push(String(line)); });
  try { return { value: await run(), lines }; } finally { spy.mockRestore(); }
}

describe("CDP readiness deadline", () => {
  posixOnly("gives up at the configured deadline and says that is what happened", async () => {
    process.env.CHROME_PATH = nodeBrowserBinary(SLOW_CDP_SERVER);
    const before = profileDirs();

    const err = await launchBrowser({ debugPort: 9465, cdpReadyTimeoutMs: 800 }).then(
      (session) => { session.close(); throw new Error("a browser that never answered must not launch"); },
      (e) => e,
    );

    // The child is alive and silent — the hosted shape. The diagnostic must
    // therefore name the budget it exhausted, because "42 probes" never told
    // anyone whether waiting longer would have worked.
    expect(err.message).toMatch(/Chrome is running but never answered on its debug port/);
    expect(err.message).toMatch(/reached the configured 800ms readiness deadline/);
    // The reported wait is the REAL one, not the budget echoed back: a deadline
    // report that just reprints its own setting proves nothing about the run.
    const waited = Number(err.message.match(/waited ~(\d+)ms/)[1]);
    expect(waited).toBeGreaterThanOrEqual(800);
    expect(waited).toBeLessThan(SLOW_START_MS);
    expect(err.cause).toBeInstanceOf(Error); // the raw fetch failure survives
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);

  posixOnly("lets the SAME slow browser through when the deadline is long enough", async () => {
    const port = 9466;
    process.env.CHROME_PATH = nodeBrowserBinary(SLOW_CDP_SERVER);
    const before = profileDirs();

    const { value: session, lines } = await withCapturedLog(() =>
      launchBrowser({ debugPort: port, cdpReadyTimeoutMs: 20_000 }));
    expect(session.browser).toBeTruthy();
    expect(await answers(port)).toBe(true);

    // One line, and it carries the two numbers a green hosted run has to
    // contribute to the distribution: how long readiness took, over how many
    // probes. Without them, the next timeout has nothing to be compared against.
    const ready = lines.filter((l) => /CDP ready/.test(l));
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatch(/ready in \d+ms after \d+ probes/);
    const elapsedMs = Number(ready[0].match(/ready in (\d+)ms/)[1]);
    const probes = Number(ready[0].match(/after (\d+) probe/)[1]);
    expect(elapsedMs).toBeGreaterThanOrEqual(SLOW_START_MS - 500);
    expect(probes).toBeGreaterThan(1); // it really did have to wait and retry
    // Nothing that identifies or grants control of the browser.
    expect(ready[0]).not.toMatch(/devtools|ws:\/\/|3f2a1c9e|user-data-dir|relayium-e2e-/);

    await session.close();
    for (let i = 0; i < 20 && (await answers(port)); i++) await sleep(100);
    expect(await answers(port)).toBe(false);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);

  posixOnly("bounds a probe that connects and then never answers", async () => {
    const port = 9469;
    const { held } = await silentServer(port);
    process.env.CHROME_PATH = idleBrowser();
    const before = profileDirs();

    const err = await launchBrowser({ debugPort: port, cdpReadyTimeoutMs: 500 }).then(
      (session) => { session.close(); throw new Error("a port that never answers must not launch"); },
      (e) => e,
    );

    expect(err.message).toMatch(/Chrome is running but never answered on its debug port/);
    expect(err.message).toMatch(/reached the configured 500ms readiness deadline/);
    // ONE probe, which spent the whole budget inside itself. Any count above 1
    // would mean the fetch returned — i.e. that nothing here actually hung.
    expect(Number(err.message.match(/cdp probes\s+: (\d+) over /)[1])).toBe(1);
    const waited = Number(err.message.match(/waited ~(\d+)ms/)[1]);
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(waited).toBeLessThan(1_500); // near the budget, not some fetch default
    // The cause names the phase that ran out, so `err.stack` — which is all the
    // e2e scripts print — still says WHICH half of readiness hung.
    expect(String(err.cause)).toMatch(/\/json\/version probe did not finish/);
    // Nothing survives the failure: not the abandoned request, not the child,
    // not the temporary profile.
    expect(await released(held)).toBe(true);
    expect(await reaped(Number(err.message.match(/pid\s+: (\d+)/)[1]))).toBe(true);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);

  posixOnly("bounds a websocket handshake that is accepted but never opens", async () => {
    const port = 9470;
    const { held } = await silentServer(port, { deafUpgrade: true });
    process.env.CHROME_PATH = idleBrowser();
    const before = profileDirs();

    const err = await launchBrowser({ debugPort: port, cdpReadyTimeoutMs: 500 }).then(
      (session) => { session.close(); throw new Error("a handshake that never opens must not launch"); },
      (e) => e,
    );

    expect(err.message).toMatch(/Chrome is running but never answered on its debug port/);
    expect(err.message).toMatch(/reached the configured 500ms readiness deadline/);
    expect(Number(err.message.match(/cdp probes\s+: (\d+) over /)[1])).toBe(1);
    const waited = Number(err.message.match(/waited ~(\d+)ms/)[1]);
    expect(waited).toBeGreaterThanOrEqual(500);
    expect(waited).toBeLessThan(1_500);
    // Names the LATER phase: the probe answered here, so blaming
    // `/json/version` would point the reader at the one part that worked.
    expect(String(err.cause)).toMatch(/CDP websocket handshake did not finish/);
    // The half-open CDP client is closed, not left holding a socket on a browser
    // nobody is going to use.
    expect(await released(held)).toBe(true);
    expect(await reaped(Number(err.message.match(/pid\s+: (\d+)/)[1]))).toBe(true);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);

  posixOnly("still fails a dead child promptly, nowhere near the 45s default", async () => {
    process.env.CHROME_PATH = nodeBrowserBinary("process.exit(9);");
    const before = profileDirs();

    const started = performance.now();
    const err = await launchBrowser({ debugPort: 9467 }).then(
      (session) => { session.close(); throw new Error("a browser that exited 9 must not launch"); },
      (e) => e,
    );
    const elapsed = performance.now() - started;

    expect(err.message).toMatch(/Chrome exited before its debug port answered \(exit code 9\)/);
    // No deadline talk: it never reached one, and saying otherwise would point
    // the reader at "too slow" when the answer is "already dead".
    expect(err.message).not.toMatch(/deadline/);
    expect(elapsed).toBeLessThan(10_000);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);

  posixOnly("refuses a deadline that would wait forever or not at all", async () => {
    const port = 9468;
    process.env.CHROME_PATH = nodeBrowserBinary(cdpServerSource());
    const before = profileDirs();

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "20000", null]) {
      await expect(launchBrowser({ debugPort: port, cdpReadyTimeoutMs: bad }))
        .rejects.toThrow(/cdpReadyTimeoutMs/);
    }
    // Rejected before anything was spawned — CHROME_PATH points at a browser
    // that WOULD have worked, and no temporary profile exists to prove it was
    // never started. (A before/after diff, not an absolute check: a leftover
    // from an earlier crashed run must not be read as this run's doing.)
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);
});

// ── killing the previous run's leftovers, before starting this one ──────────
//
// The cleanup step spawns `pkill -f remote-debugging-port=<port>` — a pattern
// that the Chrome spawned immediately afterwards ALSO matches, because that flag
// is on its command line too. So the two must never overlap: a cleanup that is
// still scanning the process table when the new Chrome appears can kill the
// browser this run just started, and the resulting failure looks like a browser
// that died on startup for no reason.
//
// The stand-in is injected rather than found on PATH: the real `pkill` would
// make these assertions depend on how fast this machine forks and scans /proc,
// and there is no portable way to make it slow, wedged or missing on demand.

/** A cleanup stand-in: a shell script the test chooses, plus a record of what
 *  `launchBrowser` asked it to match. */
function fakeCleanup(script) {
  const calls = [];
  const spawnCleanup = (pattern) => {
    const child = spawn("/bin/sh", ["-c", script], { stdio: "ignore" });
    children.push(child);
    calls.push({ pattern, child });
    return child;
  };
  return { spawnCleanup, calls };
}

/** A path nothing has written yet: a "did the browser run at all" marker. */
const markerPath = () => join(tempDir(), "marker.log");

/** The lines written to a marker, in the order they were appended. */
const markerLines = (path) =>
  (existsSync(path) ? readFileSync(path, "utf8") : "").split("\n").filter((l) => l !== "");

/** A browser stand-in that records that it ran, then fails in a way the
 *  readiness diagnostics name exactly — so "did Chrome start?" is answered by
 *  the thrown error as well as by the marker. */
const recordingBrowser = (marker) =>
  browserBinary(`echo chrome-start >> ${JSON.stringify(marker)}\nexit 5`);

const launchFailure = (options) =>
  launchBrowser(options).then(
    (session) => { session.close(); throw new Error("this launch was supposed to fail"); },
    (e) => e,
  );

describe("stale-browser cleanup", () => {
  posixOnly("does not spawn Chrome until the cleanup child has exited", async () => {
    const marker = markerPath();
    // The cleanup runs until this test says otherwise, so the ordering below is
    // decided by the harness rather than by a race between two sleeps.
    const gate = join(tempDir(), "release");
    const { spawnCleanup, calls } = fakeCleanup(`while [ ! -f ${JSON.stringify(gate)} ]; do sleep 0.05; done`);
    process.env.CHROME_PATH = recordingBrowser(marker);
    const before = profileDirs();

    const launch = launchFailure({ debugPort: 9471, cleanup: { spawnCleanup } });

    // Watched for well past the 800ms sleep this replaced, which is when the
    // fire-and-forget shape reached the spawn.
    //
    // The PROFILE is what is watched, not the marker: it is created
    // synchronously in the line before the spawn, whereas a marker only appears
    // once the stand-in binary has actually exec'd — and a freshly written one
    // can take most of a second to get there. "No marker yet" is therefore also
    // true of a Chrome that HAS already been started, which is precisely the
    // failure this test exists to catch.
    for (let i = 0; i < 30; i++) {
      expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
      await sleep(50);
    }
    expect(markerLines(marker)).toEqual([]);

    writeFileSync(gate, "");
    const err = await launch;

    expect(err.message).toMatch(/Chrome exited before its debug port answered \(exit code 5\)/);
    expect(markerLines(marker)).toEqual(["chrome-start"]); // it did launch, after
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
    // The pattern is still the one that matches only THIS run's port, so two
    // e2e scripts on different ports still cannot kill each other's browsers.
    expect(calls).toHaveLength(1);
    expect(calls[0].pattern).toBe("remote-debugging-port=9471");
  }, 30_000);

  posixOnly("treats \"no matching process\" as a successful cleanup", async () => {
    const marker = markerPath();
    // Exit 1 is what pkill reports on every healthy run: there was no leftover
    // browser to kill. Treating it as a failure would warn on every launch.
    const { spawnCleanup } = fakeCleanup("exit 1");
    process.env.CHROME_PATH = recordingBrowser(marker);

    const { value: err, lines } = await withCapturedWarn(() =>
      launchFailure({ debugPort: 9472, cleanup: { spawnCleanup } }));

    expect(err.message).toMatch(/exit code 5/);
    expect(markerLines(marker)).toEqual(["chrome-start"]);
    expect(lines).toEqual([]);
  }, 30_000);

  posixOnly("says so, and still launches, when the cleanup command is missing", async () => {
    const marker = markerPath();
    const missing = join(tempDir(), "no-pkill");
    const spawnCleanup = () => {
      const child = spawn(missing, [], { stdio: "ignore" });
      children.push(child);
      return child;
    };
    process.env.CHROME_PATH = recordingBrowser(marker);

    const { value: err, lines } = await withCapturedWarn(() =>
      launchFailure({ debugPort: 9473, cleanup: { spawnCleanup } }));

    // A cleanup that never execed cannot kill anything, this run's Chrome
    // included — so continuing is safe. It is not silent, because leftovers from
    // an earlier run now survive into this one.
    expect(err.message).toMatch(/exit code 5/);
    expect(markerLines(marker)).toEqual(["chrome-start"]);
    expect(lines.join("\n")).toMatch(/cleanup/);
    expect(lines.join("\n")).toMatch(/ENOENT/);
  }, 30_000);

  posixOnly("says so, and still launches, when cleanup exits unexpectedly", async () => {
    const marker = markerPath();
    const { spawnCleanup } = fakeCleanup("exit 2"); // pkill's usage error
    process.env.CHROME_PATH = recordingBrowser(marker);

    const { value: err, lines } = await withCapturedWarn(() =>
      launchFailure({ debugPort: 9474, cleanup: { spawnCleanup } }));

    expect(err.message).toMatch(/exit code 5/);
    expect(markerLines(marker)).toEqual(["chrome-start"]);
    expect(lines.join("\n")).toMatch(/exit code 2/);
  }, 30_000);

  posixOnly("says so, and still launches, when cleanup is killed by a signal", async () => {
    const marker = markerPath();
    const { spawnCleanup } = fakeCleanup("kill -TERM $$; sleep 5");
    process.env.CHROME_PATH = recordingBrowser(marker);

    const { value: err, lines } = await withCapturedWarn(() =>
      launchFailure({ debugPort: 9475, cleanup: { spawnCleanup } }));

    expect(err.message).toMatch(/exit code 5/);
    expect(markerLines(marker)).toEqual(["chrome-start"]);
    expect(lines.join("\n")).toMatch(/SIGTERM/);
  }, 30_000);

  posixOnly("kills a wedged cleanup, reaps it, and refuses to start Chrome", async () => {
    const marker = markerPath();
    // `exec` so the pid we hold IS the sleeping process: otherwise the kill
    // would land on the shell and leave the real sleeper behind, and `reaped`
    // below would be asking about the wrong process.
    const { spawnCleanup, calls } = fakeCleanup("exec sleep 60");
    process.env.CHROME_PATH = recordingBrowser(marker);
    const before = profileDirs();

    const err = await launchFailure({ debugPort: 9476, cleanup: { spawnCleanup, timeoutMs: 300 } });

    expect(err.message).toMatch(/cleanup/i);
    expect(err.message).toMatch(/300ms/);
    // Chrome must NOT have been started: a cleanup still scanning matches the
    // new browser's own command line, so starting it is the very race this
    // guards. No marker, and no temporary profile either.
    expect(markerLines(marker)).toEqual([]);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
    // And the cleanup child itself is gone, not left running against the port
    // the NEXT launch will use.
    expect(await reaped(calls[0].child.pid)).toBe(true);
  }, 30_000);
});

// ── and after the kill: waiting for the port itself to come free ────────────
//
// `pkill` exiting 0 means SIGTERM was DELIVERED to a stale same-port browser.
// Delivered is not dead: the target still has to run its shutdown and let go of
// the listening socket, and pkill returns without waiting for any of that. So
// waiting for the cleanup CHILD — which is what closed the self-kill race — says
// nothing about the leftover it signalled.
//
// The new Chrome needs that exact port. Spawning it inside that window either
// loses the bind, or leaves readiness talking to the LEFTOVER browser, which
// answers CDP perfectly well and is not the browser this run started — a green
// launch driving a browser from the previous run.
//
// The stand-in for the dying browser is a plain TCP listener, not a real Chrome:
// what the harness observes is only "does 127.0.0.1:<port> still accept a
// connection", and a socket the test opens and closes on demand makes exactly
// that observable, without depending on how fast any browser shuts down.

/** Listeners the tests are holding on a debug port, with the sockets each one
 *  accepted. `net.Server` has no `closeAllConnections()` — that is the HTTP
 *  server's — and `close()` alone waits for every accepted socket, so an
 *  un-destroyed probe connection would hang the release this test is timing. */
const heldPorts = [];

/** Occupy `port` on loopback until the test says otherwise. */
function holdPort(port) {
  const accepted = [];
  const server = createTcpServer((socket) => {
    socket.on("error", () => {});
    accepted.push(socket);
  });
  const shutdown = () => new Promise((done) => {
    for (const socket of accepted.splice(0)) socket.destroy();
    server.close(() => done());
  });
  heldPorts.push({ shutdown });
  // Resolves once the LISTENING socket is gone, which is the moment the port
  // starts refusing — i.e. the moment the harness is waiting for.
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ release: shutdown })));
}

describe("waiting for the killed browser to release the debug port", () => {
  posixOnly("does not start Chrome until the port stops accepting connections", async () => {
    const port = 9477;
    const marker = markerPath();
    const listener = await holdPort(port);
    const { spawnCleanup, calls } = fakeCleanup("exit 0"); // pkill: matched, and signalled
    process.env.CHROME_PATH = recordingBrowser(marker);
    const before = profileDirs();

    const launch = launchFailure({
      debugPort: port,
      cleanup: { spawnCleanup, portReleaseTimeoutMs: 10_000, portProbeIntervalMs: 25 },
    });

    // The PROFILE is what is watched, not the marker: it is created in the line
    // before the spawn, whereas a marker only appears once the stand-in binary
    // has exec'd — so "no marker yet" is also true of a Chrome that has already
    // been started, which is the failure this test exists to catch.
    for (let i = 0; i < 20; i++) {
      expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
      await sleep(50);
    }
    expect(markerLines(marker)).toEqual([]);

    await listener.release();
    const err = await launch;

    expect(err.message).toMatch(/Chrome exited before its debug port answered \(exit code 5\)/);
    expect(markerLines(marker)).toEqual(["chrome-start"]); // it did launch, after
    expect(calls).toHaveLength(1);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);

  posixOnly("fails closed, with nothing started, when the port stays occupied", async () => {
    const port = 9478;
    const marker = markerPath();
    await holdPort(port); // never released
    const { spawnCleanup } = fakeCleanup("exit 0");
    process.env.CHROME_PATH = recordingBrowser(marker);
    const before = profileDirs();

    const err = await launchFailure({
      debugPort: port,
      cleanup: { spawnCleanup, portReleaseTimeoutMs: 300, portProbeIntervalMs: 25 },
    });

    expect(err.message).toMatch(/still accepting connections/);
    expect(err.message).toContain(`127.0.0.1:${port}`);
    expect(err.message).toMatch(/300ms/);
    // No Chrome and no profile: the whole point is that this launch stops
    // BEFORE anything that would have to bind that port.
    expect(markerLines(marker)).toEqual([]);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);

  posixOnly("does not delay a launch whose port was already free", async () => {
    const marker = markerPath();
    const { spawnCleanup } = fakeCleanup("exit 0");
    process.env.CHROME_PATH = recordingBrowser(marker);

    const started = performance.now();
    const err = await launchFailure({
      debugPort: 9479,
      // Far longer than this test is allowed to take: a wait that is SPENT
      // rather than observed would blow the test's own timeout instead of
      // quietly passing.
      cleanup: { spawnCleanup, portReleaseTimeoutMs: 30_000, portProbeIntervalMs: 25 },
    });
    const elapsed = performance.now() - started;

    expect(err.message).toMatch(/exit code 5/);
    expect(markerLines(marker)).toEqual(["chrome-start"]);
    expect(elapsed).toBeLessThan(8_000);
  }, 25_000);

  posixOnly("does not probe the port at all when nothing was killed", async () => {
    const port = 9480;
    const marker = markerPath();
    // Occupied for the whole test, and irrelevant: pkill matched nothing, so
    // whatever is on that port was not signalled by us and is not ours to wait
    // for. Waiting anyway would turn every launch that shares a port with an
    // unrelated process into a failure at a budget nobody could see.
    await holdPort(port);
    const { spawnCleanup } = fakeCleanup("exit 1"); // pkill: no match
    process.env.CHROME_PATH = recordingBrowser(marker);

    const { value: err, lines } = await withCapturedWarn(() => launchFailure({
      debugPort: port,
      cleanup: { spawnCleanup, portReleaseTimeoutMs: 300, portProbeIntervalMs: 25 },
    }));

    expect(err.message).toMatch(/exit code 5/);
    expect(err.message).not.toMatch(/still accepting/);
    expect(markerLines(marker)).toEqual(["chrome-start"]);
    expect(lines).toEqual([]); // a healthy no-match warns about nothing
  }, 30_000);

  posixOnly("refuses a release budget or cadence that could not bound anything", async () => {
    const marker = markerPath();
    const { spawnCleanup, calls } = fakeCleanup("exit 0");
    process.env.CHROME_PATH = recordingBrowser(marker);
    const before = profileDirs();

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "300", null]) {
      await expect(launchBrowser({ debugPort: 9481, cleanup: { spawnCleanup, portReleaseTimeoutMs: bad } }))
        .rejects.toThrow(/portReleaseTimeoutMs/);
      await expect(launchBrowser({ debugPort: 9481, cleanup: { spawnCleanup, portProbeIntervalMs: bad } }))
        .rejects.toThrow(/portProbeIntervalMs/);
    }
    // Rejected before anything happened at all: no cleanup was spawned (so no
    // browser was signalled), no Chrome ran, no profile exists. An unusable
    // setting is a programming error, and killing processes on the way to
    // reporting one would make it destructive as well as wrong.
    expect(calls).toEqual([]);
    expect(markerLines(marker)).toEqual([]);
    expect(profileDirs().filter((n) => !before.includes(n))).toEqual([]);
  }, 30_000);
});
