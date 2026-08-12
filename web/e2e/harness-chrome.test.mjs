/**
 * @vitest-environment node
 *
 * Node, not jsdom: everything here spawns real child processes and talks to a
 * real loopback socket, which is what the e2e harness itself does. Running it
 * under jsdom would test jsdom's `fetch`/`WebSocket` shims instead of the ones
 * `launchBrowser` will actually use.
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
 *  just enough of CDP for `launchBrowser` to consider the browser up. */
const FAKE_CDP_SERVER = `
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
server.listen(port, "127.0.0.1", () => process.stderr.write(\`DevTools listening on \${wsUrl}\\n\`));
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
    process.env.CHROME_PATH = nodeBrowserBinary(FAKE_CDP_SERVER);
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
