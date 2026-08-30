/**
 * @vitest-environment node
 *
 * Node, not jsdom: everything here binds a real loopback socket, spawns a real
 * child process and touches a real temporary directory — the same primitives
 * `go-server.mjs` uses at runtime. Under jsdom these would exercise jsdom's
 * shims instead.
 *
 * What this file does NOT do is build Go or start a Relayium server. That takes
 * minutes and belongs to `test:device-inbox` and `test:e2e:mixed`. What it does
 * is exercise each guard that made the extraction worth doing, on the paths
 * where those guards are cheap: every refusal happens *before* any build, and
 * readiness/termination are ordinary process supervision that a plain `node -e`
 * child exercises exactly as well as a server would. The one runner this file
 * does execute is executed only far enough to reject its own arguments.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertPortFree, assertStaticBuild, assertValidPort, awaitHealthy, newestSource, portFromArgv, serverEnv,
  startGoServer, terminate, WEB_DIR,
} from "./go-server.mjs";

const read = (rel) => readFileSync(join(WEB_DIR, rel), "utf8");

const temporary = [];
const children = [];
const closers = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const close of closers.splice(0)) await close();
  for (const dir of temporary.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

/** Deliberately NOT prefixed `relayium-go-server-`: the leak test below counts
 *  directories the module itself would have created, and a fixture sharing that
 *  prefix would report its own scratch space as a leak. */
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "relayium-gs-fixture-"));
  temporary.push(dir);
  return dir;
}

/**
 * A child that outlives the call, and that has REACHED its own script.
 *
 * Waiting for the readiness line is not ceremony: `node -e` takes tens of
 * milliseconds to bootstrap, so a SIGTERM sent the instant `spawn` returns can
 * arrive before the script installs its handler — and the escalation test then
 * observes a child that died to SIGTERM for a reason that has nothing to do
 * with the code under test.
 */
async function spawnChild(script) {
  const child = spawn(process.execPath, ["-e", `${script}; console.log('ready')`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  children.push(child);
  await new Promise((res) => child.stdout.once("data", res));
  return child;
}

/**
 * A loopback listener, closed completely at the end of the test.
 *
 * Tracking and destroying the sockets matters: `assertPortFree` opens a probe
 * connection that a deliberately silent listener never answers, and
 * `server.close()` waits for exactly those connections — so without this the
 * teardown hangs rather than the assertion failing.
 */
function trackConnections(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  closers.push(() => new Promise((res) => {
    for (const socket of sockets) socket.destroy();
    server.close(res);
  }));
}

/** A loopback HTTP server answering `/healthz` with `body`. */
async function healthServer(body) {
  const server = createServer((_req, res) => res.end(body));
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  trackConnections(server);
  return `http://127.0.0.1:${server.address().port}`;
}

/** A loopback TCP listener that accepts and then says nothing at all. */
async function silentListener() {
  const server = createTcpServer();
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  trackConnections(server);
  return server.address().port;
}

/** A directory holding a built bundle whose mtime is `secondsAgo` old. */
function builtBundle(secondsAgo = 0) {
  const root = tempDir();
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "App.svelte"), "source");
  mkdirSync(join(root, "dist"), { recursive: true });
  const index = join(root, "dist", "index.html");
  writeFileSync(index, "<!doctype html>");
  const when = new Date(Date.now() - secondsAgo * 1_000);
  utimesSync(index, when, when);
  return { root, dist: join(root, "dist") };
}

describe("assertStaticBuild", () => {
  it("names the missing bundle and the command that produces it", () => {
    const root = tempDir();
    expect(() => assertStaticBuild(join(root, "dist"), { root }))
      .toThrow(/no built bundle at .*dist[\\/]index\.html — run `npm run build`/);
  });

  it("refuses a bundle older than its own sources, naming the newer file", () => {
    const { root, dist } = builtBundle(60);
    expect(() => assertStaticBuild(dist, { root }))
      .toThrow(/is older than web[\\/]src[\\/]App\.svelte — the bundle under test is stale/);
  });

  it("accepts a bundle newer than every source", () => {
    const { root, dist } = builtBundle(0);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, "src", "App.svelte"), old, old);
    expect(() => assertStaticBuild(dist, { root })).not.toThrow();
  });

  it("still requires the bundle to EXIST when freshness is waived", () => {
    // Otherwise `requireFresh: false` would quietly turn into "serve nothing".
    const root = tempDir();
    expect(() => assertStaticBuild(join(root, "dist"), { root, requireFresh: false })).toThrow(/no built bundle/);
    const { root: r2, dist } = builtBundle(60);
    expect(() => assertStaticBuild(dist, { root: r2, requireFresh: false })).not.toThrow();
  });

  it("never walks a node_modules tree while looking for the newest source", () => {
    const root = tempDir();
    mkdirSync(join(root, "src", "node_modules", "cache"), { recursive: true });
    writeFileSync(join(root, "src", "node_modules", "cache", "huge.js"), "cached");
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    writeFileSync(join(root, "src", "lib", "real.ts"), "source");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, "src", "lib", "real.ts"), old, old);
    // The cache file is the newest thing on disk; if it counted, this would be it.
    expect(newestSource(["src"], { root }).path).toBe(join("src", "lib", "real.ts"));
  });
});

/**
 * Everything a caller can put where a port belongs.
 *
 * `undefined` and `NaN` are both here, and Node treats them differently — which
 * is exactly why this list is checked by arithmetic rather than by a socket.
 * `listen(undefined)` binds an arbitrary free port, so `assertPortFree(undefined)`
 * answered "free" about a port nobody asked for, and a programmatic caller went
 * on to pay a Go build. `listen(NaN)` — what a runner's `Number()` made of a
 * `--port` with nothing after it — throws a `RangeError` instead: early, but
 * naming neither the flag nor the suite. One line quoting the value replaces both.
 */
const NOT_A_PORT = [
  ["undefined", undefined, /got undefined/],
  ["null", null, /got null/],
  ["NaN", NaN, /got NaN/],
  ["a fractional port", 8124.5, /got 8124\.5/],
  ["zero", 0, /got 0/],
  ["a negative port", -1, /got -1/],
  ["one past the top", 65536, /got 65536/],
  ["an empty string", "", /got ""/],
  ["whitespace", "   ", /got "   "/],
  ["the next switch", "--keep", /got "--keep"/],
  ["a number with a suffix", "8124x", /got "8124x"/],
  ["a boolean", true, /got true/],
];

describe("assertValidPort", () => {
  for (const [what, value, shown] of NOT_A_PORT) {
    it(`refuses ${what}, naming the value and the range`, () => {
      expect(() => assertValidPort(value)).toThrow(shown);
      expect(() => assertValidPort(value)).toThrow(/must be an integer in 1-65535/);
    });
  }

  it("accepts an integer, and an argv string, returning a number either way", () => {
    expect(assertValidPort(8124)).toBe(8124);
    // argv only ever carries strings, so refusing them would move the coercion
    // back out to every caller — which is where the NaN came from.
    expect(assertValidPort("8124")).toBe(8124);
    expect(assertValidPort(1)).toBe(1);
    expect(assertValidPort(65535)).toBe(65535);
  });

  it("names the flag when a runner supplies one", () => {
    expect(() => assertValidPort(undefined, { what: "--port" }))
      .toThrow(/^--port must be an integer in 1-65535 — got undefined$/m);
  });
});

describe("portFromArgv", () => {
  it("returns the default only when the flag is absent", () => {
    expect(portFromArgv([], { dflt: 8124 })).toBe(8124);
    expect(portFromArgv(["--keep", "--screenshots"], { dflt: 8124 })).toBe(8124);
  });

  it("reads the value that follows the flag, wherever the flag sits", () => {
    expect(portFromArgv(["--port", "8125"], { dflt: 8124 })).toBe(8125);
    expect(portFromArgv(["--keep", "--port", "9000"], { dflt: 8124 })).toBe(9000);
  });

  it("refuses `--port` with no value instead of falling back to the default", () => {
    // Falling back would be the worst outcome available: the run would look
    // deliberate and would be using a port the caller did not choose.
    expect(() => portFromArgv(["--keep", "--port"], { dflt: 8124 }))
      .toThrow(/--port must be an integer in 1-65535 — got undefined/);
  });

  it("refuses `--port` followed by the next switch rather than swallowing it", () => {
    expect(() => portFromArgv(["--port", "--keep"], { dflt: 8124 }))
      .toThrow(/--port must be an integer in 1-65535 — got "--keep"/);
  });

  it("refuses every other malformed value under the flag's own name", () => {
    for (const bad of ["0", "-1", "65536", "8124.5", "eight", ""]) {
      expect(() => portFromArgv(["--port", bad], { dflt: 8124 })).toThrow(/^--port must be an integer/);
    }
  });
});

describe("assertPortFree", () => {
  it("refuses an invalid port instead of binding an arbitrary free one", async () => {
    // The reported defect in its smallest form: `listen(undefined)` succeeds on
    // a port of the kernel's choosing, so the guard whose entire job is "is THIS
    // port free" answered yes about a port nobody asked about. `NaN` reached the
    // same socket and came back as a bare `RangeError` naming nothing; every
    // value in the list now stops here, under its own name.
    for (const [, value] of NOT_A_PORT) {
      await expect(assertPortFree(value)).rejects.toThrow(/must be an integer in 1-65535/);
    }
  });

  it("passes on a port nothing holds", async () => {
    const probe = createTcpServer();
    await new Promise((res) => probe.listen(0, "127.0.0.1", res));
    const { port } = probe.address();
    await new Promise((res) => probe.close(res));
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });

  it("refuses to adopt a listener it did not start, and says why that matters", async () => {
    const base = await healthServer("ok");
    const port = Number(new URL(base).port);
    await expect(assertPortFree(port)).rejects.toThrow(
      /already answering \/healthz there — this runner will not adopt a server it did not start/,
    );
    await expect(assertPortFree(port)).rejects.toThrow(/--url/);
  });

  it("refuses a non-HTTP listener too", async () => {
    // Deliberately never answers: a probe-only guard would call this port free.
    const port = await silentListener();
    await expect(assertPortFree(port)).rejects.toThrow(/is already bound \(EADDRINUSE\)/);
  });
});

describe("serverEnv", () => {
  const base = { port: 8124, root: "/tmp/run", staticDir: "/tmp/run/dist" };

  it("strips every inherited RELAYIUM_ variable, including ones it never names", () => {
    const env = serverEnv({
      ...base,
      parentEnv: {
        PATH: "/usr/bin",
        RELAYIUM_STRIPE_SECRET_KEY: "sk_live_real",
        RELAYIUM_TURN_SECRET: "turn-secret",
        RELAYIUM_NODE_TOKEN: "fleet-token",
        RELAYIUM_SMTP_PASS: "mail-password",
        RELAYIUM_ADMIN_TOTP_SECRET: "totp",
        // A variable this module has never heard of: the deny-by-default rule
        // is the whole reason a new provider credential cannot leak in.
        RELAYIUM_SOME_FUTURE_PROVIDER_KEY: "not-yet-invented",
      },
    });
    expect(env.PATH).toBe("/usr/bin");
    for (const leaked of Object.keys(env).filter((k) => k.startsWith("RELAYIUM_"))) {
      expect(env[leaked]).not.toMatch(/sk_live_real|turn-secret|fleet-token|mail-password|totp|not-yet-invented/);
    }
    expect(env.RELAYIUM_STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.RELAYIUM_SOME_FUTURE_PROVIDER_KEY).toBeUndefined();
  });

  it("points the server at this run's own database, blobs, bundle and address", () => {
    const env = serverEnv({ ...base, parentEnv: {} });
    expect(env.RELAYIUM_ADDR).toBe("127.0.0.1:8124");
    expect(env.RELAYIUM_BASE_URL).toBe("http://127.0.0.1:8124");
    expect(env.RELAYIUM_DB).toBe(join("/tmp/run", "relayium.db"));
    expect(env.RELAYIUM_BLOB_DIR).toBe(join("/tmp/run", "blobs"));
    expect(env.RELAYIUM_STATIC).toBe("/tmp/run/dist");
    expect(env.RELAYIUM_RELEASE_CHECK).toBe("0");
  });

  it("aims RELAYIUM_ENV_FILE at a path inside the run that does not exist", () => {
    // Unset is NOT equivalent: the server would fall back to its own lookup and
    // read the developer checkout's .env.
    const env = serverEnv({ ...base, parentEnv: { RELAYIUM_ENV_FILE: "/home/dev/relayium/.env" } });
    expect(env.RELAYIUM_ENV_FILE).toBe(join("/tmp/run", "no-such.env"));
  });

  it("applies caller overrides after the neutralized defaults", () => {
    const env = serverEnv({
      ...base,
      parentEnv: { RELAYIUM_MAIL_TRANSPORT: "smtp" },
      env: { RELAYIUM_MAIL_TRANSPORT: "dev-log-links" },
    });
    expect(env.RELAYIUM_MAIL_TRANSPORT).toBe("dev-log-links");
  });
});

describe("awaitHealthy", () => {
  it("returns once /healthz says ok", async () => {
    const base = await healthServer("ok");
    await expect(awaitHealthy({ base, timeoutMs: 5_000, pollMs: 20 })).resolves.toBeUndefined();
  });

  it("fails immediately on early child death and names the captured log", async () => {
    // The port answers nothing, so a timeout-only implementation would wait the
    // whole budget and then blame the wrong thing.
    const started = Date.now();
    await expect(awaitHealthy({
      base: "http://127.0.0.1:1",
      timeoutMs: 30_000,
      pollMs: 20,
      logPath: "/tmp/run/server.log",
      exited: () => "exited (code 1)",
    })).rejects.toThrow(/exited \(code 1\) before answering .*\/healthz — captured log: \/tmp\/run\/server\.log/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("gives up on a wall-clock deadline, also naming the captured log", async () => {
    const base = await healthServer("still booting");
    await expect(awaitHealthy({ base, timeoutMs: 150, pollMs: 20, logPath: "/tmp/run/server.log" }))
      .rejects.toThrow(/never answered .*\/healthz within 150ms — captured log: \/tmp\/run\/server\.log/);
  });
});

describe("terminate", () => {
  it("stops an ordinary child", async () => {
    const child = await spawnChild("setInterval(() => {}, 1000)");
    await terminate(child, { graceMs: 2_000 });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const child = await spawnChild("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    await terminate(child, { graceMs: 250 });
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("is idempotent and safe on an already-dead child", async () => {
    const child = await spawnChild("setInterval(() => {}, 1000)");
    await terminate(child, { graceMs: 2_000 });
    await expect(terminate(child, { graceMs: 2_000 })).resolves.toBeUndefined();
    await expect(terminate(null)).resolves.toBeUndefined();
  });
});

describe("startGoServer refuses before it builds anything", () => {
  // Each of these would otherwise cost a full `go build` and then fail somewhere
  // that does not name the cause. The assertion that matters is that they are
  // fast AND that they leave no temporary root behind.
  it("refuses an invalid port before it even looks for a bundle", async () => {
    // The ORDER is the fix, so the fixture is rigged against it: this staticDir
    // does not exist either. A run that reported the missing bundle would be a
    // run that had already walked the filesystem — and, one guard later, opened
    // a socket, made a temporary root and paid a Go build — to discover
    // something arithmetic decides for free.
    const root = tempDir();
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("relayium-go-server-")));
    for (const [, value] of NOT_A_PORT) {
      const started = Date.now();
      const err = await startGoServer({ port: value, staticDir: join(root, "dist") }).catch((e) => e);
      expect(err.message).toMatch(/the server port must be an integer in 1-65535/);
      expect(err.message).not.toMatch(/no built bundle/);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    // And none of them made the temporary root, which is where the build, the
    // database, the blob store and the spawned child would all have gone.
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("relayium-go-server-"));
    expect(after.filter((n) => !before.has(n))).toEqual([]);
  });

  it("refuses a missing bundle without spawning a build", async () => {
    const root = tempDir();
    const started = Date.now();
    await expect(startGoServer({ port: 8199, staticDir: join(root, "dist") }))
      .rejects.toThrow(/no built bundle/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("refuses an occupied port without spawning a build", async () => {
    const { root, dist } = builtBundle(0);
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(root, "src", "App.svelte"), old, old);
    const port = await silentListener();
    const started = Date.now();
    await expect(startGoServer({ port, staticDir: dist, requireFreshStatic: false }))
      .rejects.toThrow(/will not adopt a server it did not start/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("leaves no temporary root behind when it refuses", async () => {
    // The refusals happen before the root is made, so there is nothing to leak —
    // but the guard order is what makes that true, and reordering it would leak
    // a directory per failed run without any other symptom.
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("relayium-go-server-")));
    const root = tempDir();
    await expect(startGoServer({ port: 8199, staticDir: join(root, "dist") })).rejects.toThrow();
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("relayium-go-server-"));
    expect(after.filter((n) => !before.has(n))).toEqual([]);
  });
});

/**
 * Source contracts for the two runners this module exists to serve.
 *
 * Both are executed only by hosted jobs that cost a Go build and a headless
 * Chrome, so a parse error or a quietly disabled gate in either is expensive to
 * discover there and free to discover here.
 */
describe("the runners this lifecycle serves", () => {
  for (const runner of ["e2e/go-server.mjs", "e2e/mixed-link.mjs", "e2e/device-inbox.mjs"]) {
    it(`${runner} parses`, () => {
      const r = spawnSync(process.execPath, ["--check", join(WEB_DIR, runner)], { encoding: "utf8" });
      expect(`${r.status} ${r.stderr ?? ""}`.trim()).toBe("0");
    });
  }

  it("mixed-link starts its own server by default and keeps --url as the manual path", () => {
    const src = read("e2e/mixed-link.mjs");
    // The default must not be a URL string: that is what made this suite depend
    // on a human having started a server, which is why it never ran hosted.
    expect(src).toMatch(/const target = manualUrlFromArgv\(process\.argv\.slice\(2\)\);/);
    // …and the shape it replaced must not come back: `argFlag("--url", "")` is
    // `undefined` for a bare `--url` and `""` for an empty one, both falsy, so a
    // target the caller named silently became a self-started local server.
    expect(src).not.toMatch(/const MANUAL_URL/);
    // The target is decided before the self-start, not inside its else branch.
    expect(src.indexOf("manualUrlFromArgv(process.argv")).toBeLessThan(src.indexOf("await startGoServer("));
    expect(src).toMatch(/server = await startGoServer\(/);
    // …and --url must still reach the pre-existing check rather than silently
    // starting a second server beside the one the caller named.
    expect(src).toMatch(/await requireServer\(/);
    // The port goes through the shared parser. `Number(argFlag(...))` is the
    // exact expression that turned a missing value into `NaN`.
    expect(src).toMatch(/portFromArgv\(process\.argv\.slice\(2\), \{ dflt: DEFAULT_SELF_PORT \}\)/);
    expect(src).not.toMatch(/Number\(argFlag\("--port"/);
  });

  /**
   * The runner itself, really executed — but only as far as its own arguments.
   *
   * A malformed `--port` must be decided before the Go build and the browser, so
   * this whole check costs one Node bootstrap; if the ordering ever regressed,
   * this test would stop being cheap long before it stopped being red.
   */
  for (const [what, argv, shown] of [
    ["with no value at all", ["--port"], /got undefined/],
    ["followed by the next switch", ["--port", "--keep"], /got "--keep"/],
    ["out of range", ["--port", "70000"], /got "70000"/],
    ["not a number", ["--port", "eight"], /got "eight"/],
  ]) {
    it(`mixed-link refuses --port ${what} by name, before anything is built`, () => {
      const r = spawnSync(process.execPath, [join(WEB_DIR, "e2e", "mixed-link.mjs"), ...argv], {
        cwd: WEB_DIR, encoding: "utf8", timeout: 60_000,
      });
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status, output).toBe(1);
      expect(output).toMatch(/--port must be an integer in 1-65535/);
      expect(output).toMatch(shown);
      // Reported as this suite's own failure rather than as a bare Node stack:
      // the parse is inside `main()`'s try, not at module load.
      expect(output).toMatch(/Mixed link E2E/);
      // Nothing was built and no browser was launched to find this out.
      expect(output).not.toMatch(/built the server|server up on|go build/);
    });
  }

  /**
   * The target flag gets the same treatment, because its failure is the silent
   * one.
   *
   * A bad `--port` at least stopped the run. A bad `--url` did not: `argFlag`
   * returned `undefined` for a bare `--url` and `""` for an empty one, both
   * falsy, so the runner fell through to self-starting a local server — a green
   * run against a target the caller never named. `--url --keep` swallowed the
   * next switch and used it as an address instead.
   */
  for (const [what, argv, shown] of [
    ["with no value at all", ["--url"], /got undefined/],
    ["with an empty value", ["--url", ""], /got ""/],
    ["followed by the next switch", ["--url", "--keep"], /got "--keep"/],
    ["followed by a short switch", ["--url", "-k"], /got "-k"/],
  ]) {
    it(`mixed-link refuses --url ${what} rather than targeting something else`, () => {
      const r = spawnSync(process.execPath, [join(WEB_DIR, "e2e", "mixed-link.mjs"), ...argv], {
        cwd: WEB_DIR, encoding: "utf8", timeout: 60_000,
      });
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status, output).toBe(1);
      expect(output).toMatch(/Error: --url /);
      expect(output).toMatch(shown);
      // This suite's own name, from inside `main()`'s try.
      expect(output).toMatch(/Mixed link E2E/);
      // And none of what a fall-through would have produced: the self-start it
      // used to choose, a build, or a browser.
      expect(output).not.toMatch(/self-started|built the server|server up on|go build/);
    });
  }

  it("device-inbox uses the shared lifecycle instead of its own spawn", () => {
    const src = read("e2e/device-inbox.mjs");
    expect(src).toMatch(/startGoServer\(\{/);
    expect(src).not.toMatch(/spawn\(bin/);
    // The real CLI is still built from the same module and still drives the
    // scenario: this refactor moved the lifecycle, not the product path.
    expect(src).toMatch(/extraBinaries: \[\{ name: "relayium", pkg: "\.\/cmd\/relayium" \}\]/);
    expect(src).toMatch(/RELAYIUM_MAIL_TRANSPORT: "dev-log-links"/);
    // Same port parser as mixed-link, so a bad flag reads the same way in both
    // consumers of this lifecycle. The assignment it replaced must not come
    // back: it made `NaN`, and `BASE` `http://127.0.0.1:NaN`.
    expect(src).toMatch(/portFromArgv\(process\.argv\.slice\(2\), \{ dflt: DEFAULT_PORT \}\)/);
    expect(src).not.toMatch(/const PORT = Number\(/);
  });

  /**
   * The same real execution for the other consumer, and one extra assertion:
   * this runner makes a temporary tree, so "before the build" also has to mean
   * "before anything is written".
   */
  for (const [what, argv, shown] of [
    ["with no value at all", ["--port"], /got undefined/],
    ["followed by the next switch", ["--port", "--keep"], /got "--keep"/],
    ["out of range", ["--port", "70000"], /got "70000"/],
  ]) {
    it(`device-inbox refuses --port ${what} before its temporary root or build`, () => {
      const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("relayium-inbox-e2e-")));
      const r = spawnSync(process.execPath, [join(WEB_DIR, "e2e", "device-inbox.mjs"), ...argv], {
        cwd: WEB_DIR, encoding: "utf8", timeout: 60_000,
      });
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      expect(r.status, output).toBe(1);
      expect(output).toMatch(/--port must be an integer in 1-65535/);
      expect(output).toMatch(shown);
      // Named as this suite rather than printed as a bare Node stack, which is
      // what the module-level parse it replaced would have produced.
      expect(output).toMatch(/device-inbox e2e/);
      expect(output).not.toMatch(/go build|device inbox enabled/);
      // Nothing on disk: the parse runs before `mkdtempSync`.
      const leaked = readdirSync(tmpdir())
        .filter((n) => n.startsWith("relayium-inbox-e2e-") && !before.has(n));
      expect(leaked).toEqual([]);
    });
  }

  it("the hosted mixed-link job runs the suite unconditionally after a build", () => {
    // The C2 lesson, applied: a hosted gate that can be skipped is a gate whose
    // green means nothing. Guarding or deleting this job must fail HERE.
    const yml = readFileSync(join(WEB_DIR, "..", ".github", "workflows", "web.yml"), "utf8");
    const job = yml.split(/^  mixed-link-e2e:$/m)[1];
    expect(job, "web.yml has no mixed-link-e2e job").toBeDefined();
    const body = job.split(/^  \S/m)[0];
    expect(body).toContain("- run: npm ci");
    expect(body).toContain("- run: npm run build");
    expect(body).toContain("- run: npm run test:e2e:mixed");
    // A Go toolchain, because the runner builds and starts a real server.
    expect(body).toContain("actions/setup-go@");
    expect(body).toMatch(/node-version: 24/);
    // No escape hatches anywhere in the job.
    expect(body).not.toMatch(/\bif:/);
    expect(body).not.toMatch(/continue-on-error/);
    // The build must come BEFORE the suite: the runner refuses a missing bundle.
    expect(body.indexOf("npm run build")).toBeLessThan(body.indexOf("npm run test:e2e:mixed"));

    // The job's own comment states a FACT about the `test` job — how many
    // browser lanes it already carries — and that fact is the entire stated
    // reason this job is separate. It said "four" for as long as there have
    // been five, because a stale comment is invisible to every other check in
    // this file. So count the lanes and hold the sentence to the count.
    const testJob = yml.split(/^  test:$/m)[1].split(/^  \S/m)[0];
    const lanes = [
      "npm run test:a11y",
      "npm run test:e2e:page-shell",
      "npm run test:e2e:code-room",
      "npm run test:device-discovery",
      "npm run test:device-inbox-entry",
    ];
    for (const lane of lanes) {
      expect(testJob, `the test job no longer runs ${lane}`).toContain(`- run: ${lane}`);
    }
    // Written as a literal, not as `lanes.length`: an array and its own length
    // agree after somebody deletes an entry, which is the same vacuity the act
    // ledger below exists to forbid.
    expect(lanes).toHaveLength(5);
    const comment = yml.split(/^  mixed-link-e2e:$/m)[0];
    expect(comment, "the mixed-link job's stated reason names the wrong lane count")
      .toMatch(/most of a 15-minute budget on five browser/);
  });
});

/**
 * `mixed-link.mjs`'s own inventory: two scenarios, twenty acts and five acts.
 *
 * `page-shell-contract.test.mjs` guards its runner from silently dropping a
 * scenario, and the same failure exists here one level down and is worse. That
 * suite has four scenarios, so counting them is a real check. Here the twenty
 * acts of `mixedScenario` all run against one live link — so `2/2` would be
 * reported by a run that had been edited down to its first assertion, and by a
 * run whose 5 MiB resume act quietly stopped executing. The literals that
 * actually protect it are the two ACT counts, one per scenario.
 *
 * The counts are kept apart deliberately. A single flat list of twenty-five
 * would report the same failure for "the multi-page journey never started" as
 * for "act #21 was deleted", and those need different repairs.
 *
 * These are source-shape assertions, deliberately: the run they protect costs a
 * Go build, a real server and a headless Chrome, and is the one place in this
 * repository where a silently-skipped assertion is most expensive to notice.
 */
describe("mixed-link's scenario inventory and act ledger", () => {
  const src = read("e2e/mixed-link.mjs");

  /** The frozen act list, retyped rather than imported — on purpose. An
   *  assertion that reads the array it is checking agrees with itself. */
  const ACT_NAMES = [
    "advertised-link-1",
    "peer-card-one-action",
    "one-link-one-sas",
    "sctp-default-64k-boundary",
    "chooser-hidden",
    "workspace-header",
    "text-consent",
    "file-consent-40",
    "sticky-sas",
    "queued-batch",
    "declined-batch",
    "byte-identical-text",
    "mobile-no-picker-download",
    "picker-cancel-retry",
    "live-progressbar",
    "byte-resume",
    "narrow-locale-theme",
    "pending-consent-outlives-link",
    "fresh-link-new-sas",
    "explicit-disconnect",
  ];

  /** The second scenario's frozen list, retyped for the same reason. */
  const MULTIPAGE_ACT_NAMES = [
    "multipage-one-device",
    "multipage-focus-handover",
    "multipage-request-follows-focus",
    "multipage-fallback-on-close",
    "multipage-sibling-reachable",
  ];

  /** The third scenario's frozen list, retyped for the same reason. */
  const RELAY_ACT_NAMES = [
    "relay-pool-only-ice",
    "relay-probe-spent-its-budget",
    "relay-only-link-attempt",
    "relay-bounded-named-failure",
  ];

  /** The fourth scenario's frozen list, retyped for the same reason. */
  const UNSUPPORTED_ACT_NAMES = [
    "unsupported-caps-suppressed-on-the-wire",
    "unsupported-one-noninteractive-statement",
    "unsupported-no-control-no-affordance",
    "unsupported-drop-refused-with-that-sentence",
    "unsupported-quiet-suppressed-tab",
  ];

  for (const [name, expected] of [
    ["ACTS", ACT_NAMES], ["MULTIPAGE_ACTS", MULTIPAGE_ACT_NAMES], ["RELAY_ACTS", RELAY_ACT_NAMES],
    ["UNSUPPORTED_ACTS", UNSUPPORTED_ACT_NAMES],
  ]) {
    it(`declares exactly ${name}'s acts, in that order, as one frozen literal`, () => {
      const match = src.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\);`));
      expect(match, `${name} is no longer a frozen array literal`).not.toBeNull();
      const listed = match[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
      expect(listed).toEqual(expected);
    });
  }

  it("records every one of them from an act() call, exactly once", () => {
    for (const name of [...ACT_NAMES, ...MULTIPAGE_ACT_NAMES, ...RELAY_ACT_NAMES, ...UNSUPPORTED_ACT_NAMES]) {
      const calls = src.match(new RegExp(`\\bact\\("${name}"`, "g")) ?? [];
      expect(calls, `${name} is declared but never recorded by an act() call`).toHaveLength(1);
    }
    // And nothing records an act none of the four frozen lists names: `act()`
    // throws on an unknown name at runtime, but a run that never reaches it
    // would not find out, and this is free. Order matters across the
    // concatenation too — each scenario's acts must sit together and after the
    // previous scenario's, i.e. in their own body, not interleaved into another.
    const recorded = [...src.matchAll(/\bact\("([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(recorded).toEqual([...ACT_NAMES, ...MULTIPAGE_ACT_NAMES, ...RELAY_ACT_NAMES, ...UNSUPPORTED_ACT_NAMES]);
  });

  it("checks all five counts against fixed literals, not against array lengths", () => {
    expect(src).toMatch(/const EXPECTED_SCENARIO_COUNT = 4;/);
    expect(src).toMatch(/const EXPECTED_ACT_COUNT = 20;/);
    expect(src).toMatch(/const EXPECTED_MULTIPAGE_ACT_COUNT = 5;/);
    expect(src).toMatch(/const EXPECTED_RELAY_ACT_COUNT = 4;/);
    expect(src).toMatch(/const EXPECTED_UNSUPPORTED_ACT_COUNT = 5;/);
    expect(src).toMatch(/ran !== EXPECTED_SCENARIO_COUNT/);
    expect(src).toMatch(/ledger\.length !== scenario\.expectedActs/);
    // Each inventory entry must carry the LITERAL count, never the list's own
    // length. This is the same trap one indirection further along: an entry
    // written `expectedActs: ACTS.length` restores exactly the vacuous
    // comparison the literals exist to prevent.
    expect(src).toMatch(/expectedActs: EXPECTED_ACT_COUNT/);
    expect(src).toMatch(/expectedActs: EXPECTED_MULTIPAGE_ACT_COUNT/);
    expect(src).toMatch(/expectedActs: EXPECTED_RELAY_ACT_COUNT/);
    expect(src).toMatch(/expectedActs: EXPECTED_UNSUPPORTED_ACT_COUNT/);
    expect(src, "an inventory entry took its expected act count from a mutable array length")
      .not.toMatch(/expectedActs:\s*[A-Za-z_$][\w$.]*\.length/);
    // The comparisons this guard exists to forbid: an array and its own length
    // still agree after somebody deletes an entry from it, so any of these
    // would report a clean run over a shrunken inventory.
    expect(src, "the scenario check fell back to the mutable array length").not.toMatch(
      /ran !== SCENARIOS\.length/,
    );
    for (const list of ["ACTS", "MULTIPAGE_ACTS", "RELAY_ACTS", "UNSUPPORTED_ACTS", "scenario\\.acts", "expected"]) {
      expect(src, `the act check fell back to ${list.replace("\\", "")}'s mutable length`).not.toMatch(
        new RegExp(`ledger\\.length !== ${list}\\.length`),
      );
    }
  });

  it("counts scenarios with no catch between the call and the counter", () => {
    const start = src.indexOf("async function runScenarios(");
    expect(start, "runScenarios is no longer greppable").toBeGreaterThan(-1);
    const loopStart = src.indexOf("for (const scenario of SCENARIOS)", start);
    expect(loopStart, "the run-all loop is no longer a plain for-of").toBeGreaterThan(-1);
    const loopEnd = src.indexOf("\n  }", loopStart);
    expect(loopEnd).toBeGreaterThan(loopStart);
    // Statements only. The rule this checks is about what the loop DOES, and
    // the comment inside it legitimately names the very thing it forbids —
    // reading that comment as a violation is the same trap
    // `workspace-orchestration.test.ts`'s `code()` helper exists for.
    const loopBody = src.slice(loopStart, loopEnd)
      .split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    expect(loopBody, "the run-all loop swallows a scenario's error before ran++").not.toMatch(/catch/);
    expect(loopBody).toMatch(/ran\+\+/);
  });

  it("runs the inventory rather than calling any scenario directly", () => {
    // `await mixedScenario(...)` straight from main() — which is what this file
    // did before C3b-1 — bypasses every count, so the check is not "runScenarios
    // exists" but "nothing calls a scenario around it".
    expect(src).toMatch(/await runScenarios\(session\.browser, base\);/);
    // All four scenarios are listed, each beside the list and literal its
    // ledger is judged against. A scenario present in the file but absent from
    // here runs nowhere, and the scenario count would agree with its own absence.
    expect(src).toMatch(/run: mixedScenario,\s*acts: ACTS,\s*expectedActs: EXPECTED_ACT_COUNT/);
    expect(src).toMatch(/run: multiPageDeviceScenario,\s*\n\s*acts: MULTIPAGE_ACTS,\s*\n\s*expectedActs: EXPECTED_MULTIPAGE_ACT_COUNT/);
    expect(src).toMatch(/run: relayFailureScenario,\s*\n\s*acts: RELAY_ACTS,\s*\n\s*expectedActs: EXPECTED_RELAY_ACT_COUNT/);
    expect(src).toMatch(/run: unsupportedPeerScenario,\s*\n\s*acts: UNSUPPORTED_ACTS,\s*\n\s*expectedActs: EXPECTED_UNSUPPORTED_ACT_COUNT/);
    for (const fn of ["mixedScenario", "multiPageDeviceScenario", "relayFailureScenario", "unsupportedPeerScenario"]) {
      expect(src, `main() calls ${fn} directly, around the inventory`)
        .not.toMatch(new RegExp(`await ${fn}\\(`));
    }
    // Counting occurrences of the bare name is deliberately NOT done here: the
    // prose above it names the function several times, so that check would be
    // a comment-edit tripwire rather than a contract.
  });
});

/**
 * Hosted migration of lan-transfer unique #3: Chromium, rather than a mock,
 * must apply RFC 8841's 65,536-byte default when the remote SDP omits the
 * max-message-size attribute. These source guards freeze the expensive real-
 * browser proof's subjects, boundaries and order without pretending to prove
 * Chromium behavior themselves.
 */
describe("mixed-link negotiates and preserves the absent-advertisement SCTP default", () => {
  const src = read("e2e/mixed-link.mjs");

  it("strips a real nonzero advertisement on both tabs without conflating the text limit", () => {
    expect(src).toContain("const SCTP_DEFAULT_MAX_MESSAGE_BYTES = 65_536;");
    expect(src, "the transport contract drifted onto the plaintext product limit")
      .not.toContain("TEXT_MAX_BYTES");
    expect(src).toContain("RTCPeerConnection.prototype.setRemoteDescription = function (description)");
    const normalizedEscapes = src.replaceAll("\\\\", "\\");
    expect(normalizedEscapes).toContain("/^a=max-message-size:([1-9]\\d*)\\r?\\n/gm");
    expect(src).toContain("window.__e2eMaxMessageSizeRemovals++");
    const installed = src.match(/newTab\([^\n]+OMIT_REMOTE_MAX_MESSAGE_SIZE\)/g) ?? [];
    expect(installed, "the absent-advertisement seam is not installed on exactly both product tabs")
      .toHaveLength(2);
  });

  it("uses a real channel to accept 65536 and reject 65537 after proven SDP removals", () => {
    expect(src).toContain("negotiated: left.sctp?.maxMessageSize ?? null");
    expect(src).toContain("const fitted = attempt(${SCTP_DEFAULT_MAX_MESSAGE_BYTES});");
    expect(src).toContain("const oversized = attempt(${SCTP_DEFAULT_MAX_MESSAGE_BYTES + 1});");
    expect(src).toContain("sctpProbe.removals < 1");
    expect(src).toContain('sctpProbe.fitted !== "sent"');
    expect(src).toContain('sctpProbe.afterFitted !== "open"');
    expect(src).toContain("sctpProbe.fittedReceived !== SCTP_DEFAULT_MAX_MESSAGE_BYTES");
    expect(src).toContain("reject(new Error('65,536-byte probe was not delivered')), 3_000");
    expect(src).toContain('(sctpProbe.oversized === "sent" && sctpProbe.afterOversized === "open")');
  });

  it("resets the probe before the product link and proves both initial product PCs", () => {
    const probe = src.indexOf("const sctpProbe =");
    const reset = src.indexOf("window.__e2ePeerConnections.length = 0", probe);
    const open = src.indexOf("document.querySelector('${OPEN_WORKSPACE}').click()", reset);
    const initial = src.indexOf("const initialProductCaps =", open);
    const capAct = src.indexOf('act("sctp-default-64k-boundary"', initial);
    for (const [name, at] of [["real probe", probe], ["tracker reset", reset],
      ["product link open", open], ["initial product caps", initial], ["cap act", capAct]]) {
      expect(at, `${name} anchor is missing; the order check would be vacuous`).toBeGreaterThan(-1);
    }
    expect(reset).toBeGreaterThan(probe);
    expect(open).toBeGreaterThan(reset);
    expect(initial).toBeGreaterThan(open);
    expect(capAct).toBeGreaterThan(initial);
    expect(src).toContain("window.__e2eMaxMessageSizeRemovals = 0");
    expect(src).toContain("trackerBeforeProductLink.a.pcs !== 0");
    expect(src).toContain("trackerBeforeProductLink.b.pcs !== 2");
    expect(src).toContain('for (const [who, tab] of [["a", a], ["b", b]])');
    expect(src).toContain("initialProductCaps[who].sizes.length !== 1");
    expect(src).toContain("initialProductCaps[who].sizes[0] !== SCTP_DEFAULT_MAX_MESSAGE_BYTES");
  });

  it("checks every tracked initial and replacement PC without filtering nulls", () => {
    const canonicalCapMap = "window.__e2ePeerConnections.map((pc) => pc.sctp?.maxMessageSize ?? null)";
    const escapedCapMap = canonicalCapMap.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const chainedFilter = new RegExp(`${escapedCapMap}\\s*\\.filter\\s*\\(`);
    const unfiltered = src.split(canonicalCapMap).length - 1;
    expect(unfiltered, "initial, receiver-resume and sender-resume cap arrays are not all present")
      .toBe(3);
    expect(src).toContain("resumed.messageSizes.length !== resumed.peerConnections");
    expect(src).toContain("!resumed.messageSizes.every((size) => size === SCTP_DEFAULT_MAX_MESSAGE_BYTES)");
    expect(src).toContain("senderCapState.messageSizes.length !== senderCapState.peerConnections");
    expect(src).toContain("!senderCapState.messageSizes.every((size) => size === SCTP_DEFAULT_MAX_MESSAGE_BYTES)");
    expect(src, "a null or closed PC is being hidden from an initial or resumed SCTP cap proof")
      .not.toMatch(chainedFilter);
    const representativeMutation = src.replace(
      `sizes: ${canonicalCapMap}`,
      `sizes: ${canonicalCapMap}.filter((size) => size !== null)`,
    );
    expect(representativeMutation, "the chained-filter guard does not recognize the initial-cap mutation")
      .not.toBe(src);
    expect(representativeMutation).toMatch(chainedFilter);
    expect(src).toMatch(/resumed\.bytes !== RESUME_BYTES/);
    expect(src).toMatch(/resumed\.mismatch !== -1/);
    expect(src).toMatch(/senderPcs <= pcCounts\.a \|\| resumed\.peerConnections <= pcCounts\.b/);
  });
});

/**
 * The live-progressbar act, and the one thing about it that cannot be checked
 * from its own output: WHERE it runs.
 *
 * Stranded unique #6 is "live `role=\"progressbar\"` accessibility during an
 * in-flight transfer". There is exactly one window in this scenario in which
 * that state exists — after the receiver has taken two durable chunks of the
 * 5 MiB file and before the forced transport gap closes both PeerConnections.
 * Moved after the close, every assertion in it still passes on a terminal card
 * that has no progress bar at all, because a scoped `axe.run` over a context
 * matching nothing reports zero violations. That is a green run asserting
 * nothing, which is the exact failure the whole §1a migration exists to avoid.
 */
describe("mixed-link scans the progressbar while it is live", () => {
  const src = read("e2e/mixed-link.mjs");

  it("proves the subject exists before scanning it", () => {
    const proof = src.indexOf("no in-flight progress bar in the ${dir} card");
    const scan = src.indexOf('await scanLiveState(tab, `${who}: live ${dir} progressbar mid-transfer`');
    expect(proof, "the in-flight progress bar existence proof is gone").toBeGreaterThan(-1);
    expect(scan, "the live progressbar scan is gone").toBeGreaterThan(-1);
    expect(scan, "the scan no longer follows the existence proof").toBeGreaterThan(proof);
    // Scoped to the card. A document-wide scan here would keep passing on the
    // strength of the rest of the workspace after the bar lost its name.
    expect(src).toMatch(/\{ context: XFER\.card \}/);
  });

  it("runs it inside the transfer gap, before the forced PeerConnection close", () => {
    const accepted = src.indexOf("at least two durable chunks before the forced transport gap");
    const scan = src.indexOf('await scanLiveState(tab, `${who}: live ${dir} progressbar mid-transfer`');
    const close = src.indexOf("window.__e2ePeerConnections.at(-1); pc.close()");
    expect(accepted).toBeGreaterThan(-1);
    expect(close, "the forced transport gap is gone").toBeGreaterThan(-1);
    expect(scan, "the live scan runs before the transfer has started moving bytes")
      .toBeGreaterThan(accepted);
    expect(scan, "the live scan drifted past the forced close — its subject is terminal by then")
      .toBeLessThan(close);
  });

  it("holds the transfer open long enough for two axe passes to fit in that gap", () => {
    // The window is ~25 remaining 192 KiB writes × this delay. At the 20ms the
    // rest of this scene runs at it is ~500ms — enough for the forced close,
    // which is one CDP round trip, and not remotely enough to inject and run axe
    // on two tabs. The transfer would finish first and the act would fail
    // reporting a terminal card instead of an accessibility result.
    const match = src.match(/const SCAN_WRITE_DELAY_MS = (\d+);/);
    expect(match, "the scan-window throttle is no longer a named constant").not.toBeNull();
    expect(
      Number(match[1]),
      "the scan throttle was lowered; the live-progressbar act becomes timing-dependent below ~500ms",
    ).toBeGreaterThanOrEqual(500);
    // And it is what the stub is actually set to — a constant nothing reads
    // would leave the window at the sink's own default of 0.
    expect(src).toMatch(/window\.__e2e\.writeDelayMs = \$\{SCAN_WRITE_DELAY_MS\};/);
  });

  it("drops the throttle back before the pc counts and the forced close", () => {
    // The scan throttle is paid per remaining 192 KiB write, so leaving it on
    // for the ~25 writes after the scan costs ~20s of pure wall clock and buys
    // nothing: the forced close is one CDP round trip, and the resume scene was
    // already proven at 20ms before this act existed. That regression — a
    // scenario going from ~10s to ~31s — is invisible in a green run, which is
    // why the ORDER is pinned here rather than left to a comment.
    const resume = src.match(/const RESUME_WRITE_DELAY_MS = (\d+);/);
    expect(resume, "the post-scan throttle is no longer a named constant").not.toBeNull();
    expect(
      Number(resume[1]),
      "the post-scan throttle is not the value the resume scene was proven at",
    ).toBe(20);

    const scan = src.indexOf('await scanLiveState(tab, `${who}: live ${dir} progressbar mid-transfer`');
    const reset = src.indexOf("window.__e2e.writeDelayMs = ${RESUME_WRITE_DELAY_MS};");
    const counts = src.indexOf("const pcCounts = {");
    const close = src.indexOf("window.__e2ePeerConnections.at(-1); pc.close()");
    // Anchor first. Every ordering assertion below compares against `scan`, and
    // a missing anchor is -1, which every `toBeGreaterThan` would then pass
    // against vacuously — the same shape of green-proving-nothing this whole
    // describe block exists to forbid.
    expect(scan, "the live progressbar scan is gone; every order check below is vacuous")
      .toBeGreaterThan(-1);
    expect(reset, "nothing restores the throttle after the scan").toBeGreaterThan(-1);
    expect(counts, "the PeerConnection count read is gone").toBeGreaterThan(-1);
    expect(reset, "the throttle is restored before the scan it exists for").toBeGreaterThan(scan);
    expect(reset, "the pc counts are read while the scan throttle is still on").toBeLessThan(counts);
    expect(reset, "the forced close happens while the scan throttle is still on").toBeLessThan(close);
    // Restoring it is not allowed to become a no-op on a transfer that already
    // finished: that would silently turn the resume scene into a plain
    // uninterrupted transfer, and every wait after it would blame something else.
    expect(src).toContain("finished during the live progressbar scans");
  });

  it("keeps the byte-exact resume and replacement-PeerConnection assertions behind it", () => {
    // The act was inserted into this scene, not in place of any of it.
    expect(src).toMatch(/const RESUME_BYTES = 5 \* 1024 \* 1024 \+ 73;/);
    expect(src).toMatch(/resumed\.bytes !== RESUME_BYTES/);
    expect(src).toMatch(/resumed\.mismatch !== -1/);
    expect(src).toMatch(/senderPcs <= pcCounts\.a \|\| resumed\.peerConnections <= pcCounts\.b/);
    expect(src).toContain("no replacement PeerConnection was built");
  });
});

/**
 * Hosted migration of lan-transfer unique #2: a real built ReceiveActions card
 * must survive an AbortError and require a second explicit user gesture. The
 * expensive browser run proves behavior; these source checks make deletion and
 * reordering fail in the ordinary Vitest lane instead of waiting for Chrome.
 */
describe("mixed-link retries a cancelled desktop save picker on the same consent", () => {
  const src = read("e2e/mixed-link.mjs");

  it("injects a browser-native AbortError on exactly the first picker call", () => {
    expect(src).toMatch(/window\.__e2e\.pickerCalls\+\+;/);
    expect(src).toMatch(/window\.__e2e\.pickerCalls === 1/);
    expect(src).toContain("throw new DOMException('e2e: user cancelled Save As', 'AbortError')");
    expect(src).toContain("return saveAfterFirstAttempt(...args)");
  });

  it("consumes exactly one classified cancellation only inside the marked act window", () => {
    const mark = src.indexOf("const pickerErrorWindow = { a: a.errors.length, b: b.errors.length }");
    const firstClick = src.indexOf("the same consent card to become retryable after the cancelled picker");
    const consume = src.indexOf("const pickerWindowErrors =");
    const secondClick = src.indexOf("This second click is the only event allowed to reopen the picker");
    for (const [name, at] of [["error-window mark", mark], ["first picker attempt", firstClick],
      ["exact consumption", consume], ["second picker attempt", secondClick]]) {
      expect(at, `${name} anchor is missing; the cancellation exception could be swallowed globally`)
        .toBeGreaterThan(-1);
    }
    expect(firstClick).toBeGreaterThan(mark);
    expect(consume).toBeGreaterThan(firstClick);
    expect(secondClick).toBeGreaterThan(consume);
    expect(src).toContain(
      '"relayium mixed file picker error SaveCancelledError: save picker cancelled by the user (showSaveFilePicker)"',
    );
    expect(src).toContain("pickerWindowErrors.a.length !== 0");
    expect(src).toContain("pickerWindowErrors.b.length !== 1");
    expect(src).toContain('pickerWindowErrors.b[0]?.split("\\n") ?? []');
    expect(src).toContain("pickerErrorLines.length !== 3");
    expect(src).toContain("pickerErrorLines[0] !== EXPECTED_PICKER_CANCEL_ERROR");
    expect(src).toContain("pickerErrorLines.slice(1).every((line) => builtAssetFrame.test(line))");
    expect(src).toContain("const escapedBase = base.replace");
    const normalizedEscapes = src.replaceAll("\\\\", "\\");
    expect(normalizedEscapes).toContain("/assets/index-[A-Za-z0-9_-]+\\.js:\\d+:\\d+");
    expect(src).toContain("b.errors.splice(pickerErrorWindow.b, 1)");
    expect(src, "the final sweep was weakened instead of consuming one exact windowed entry")
      .toContain('const errs = [...a.errors, ...b.errors].filter((e) => !/401|Failed to load resource/.test(e));');
  });

  it("proves the retry subject before the second explicit click", () => {
    const firstClick = src.indexOf("the same consent card to become retryable after the cancelled picker");
    const proof = src.indexOf("const afterPickerCancel =");
    const secondClick = src.indexOf("This second click is the only event allowed to reopen the picker");
    const durable = src.indexOf("at least two durable chunks before the forced transport gap");
    for (const [name, at] of [["first cancelled click", firstClick], ["retry proof", proof],
      ["second explicit click", secondClick], ["durable bytes", durable]]) {
      expect(at, `${name} anchor is missing; order checks would be vacuous`).toBeGreaterThan(-1);
    }
    expect(proof).toBeGreaterThan(firstClick);
    expect(secondClick).toBeGreaterThan(proof);
    expect(durable).toBeGreaterThan(secondClick);
    expect(src).toContain("afterPickerCancel.pickerCalls !== 1");
    expect(src).toContain("afterPickerCancel.opens !== 0");
    expect(src).toContain("afterPickerCancel.bytes !== 0");
    expect(src).toContain("afterPickerCancel.requests !== 1");
    expect(src).toContain("afterPickerCancel.retryHints !== 1");
    expect(src).toContain('afterPickerCancel.retryRole !== "status"');
    expect(src).toContain("afterPickerCancel.head !== consentBeforeCancel.head");
    expect(src).toContain("afterPickerCancel.badTransfers !== consentBeforeCancel.badTransfers");
    expect(src).toContain("senderAfterCancel.badTransfers !== senderBeforeCancel.badTransfers");
    expect(src).toContain("senderAfterCancel.composers !== 1");
    expect(src).toContain('oneSas(tab, who, "after cancelling the save picker")');
  });

  it("requires exactly two picker calls and preserves the exact resume evidence", () => {
    const retryAct = src.indexOf('act("picker-cancel-retry"');
    const progressAct = src.indexOf('act("live-progressbar"');
    const resumeAct = src.indexOf('act("byte-resume"');
    expect(retryAct, "the picker retry act is missing").toBeGreaterThan(-1);
    expect(progressAct).toBeGreaterThan(retryAct);
    expect(resumeAct).toBeGreaterThan(progressAct);
    expect(src).toContain("retriedPicker.pickerCalls !== 2");
    expect(src).toContain("retriedPicker.opens !== 1");
    expect(src).toContain('retriedPicker.name !== "resume-on-the-same-link.bin"');
    expect(src).toContain("resumed.pickerCalls !== 2");
    expect(src).toContain('resumed.name !== "resume-on-the-same-link.bin"');
    expect(src).toMatch(/resumed\.bytes !== RESUME_BYTES/);
    expect(src).toMatch(/resumed\.mismatch !== -1/);
    expect(src).toMatch(/senderPcs <= pcCounts\.a \|\| resumed\.peerConnections <= pcCounts\.b/);
  });
});

/**
 * Hosted migration of lan-transfer unique #1: on a phone the product opens **no**
 * save picker at all, and says so before the user commits.
 *
 * The expensive browser run is what proves the behaviour. What cannot be read
 * off its output, and is therefore frozen here, is the shape that makes the
 * green meaningful:
 *
 *   - the pickers installed for it must be USABLE. "Zero picker calls" over a
 *     picker that throws is a statement about the stub, not about the product;
 *     over one that would have succeeded and swallowed the bytes it is the only
 *     evidence that the product decided in advance not to open it;
 *   - the two picker branches must be counted apart, with the handle's own byte
 *     counter beside them;
 *   - the phone UA must land before the batch is sent, because `ReceiveActions`
 *     resolves the save hint once, at mount;
 *   - and every boundary must be restored — by identity, not by shape — before
 *     the desktop cancellation act, which wraps those same function objects.
 *
 * This is a spoofed Android UA on desktop Chromium with browser-boundary stubs.
 * It is not a real Android system picker or download manager, and neither this
 * file nor the runner may describe it as one.
 */
describe("mixed-link proves the phone opens no save picker at all", () => {
  const src = read("e2e/mixed-link.mjs");

  it("installs pickers that would have worked, counted apart, with a handle byte counter", () => {
    expect(src).toContain("window.showSaveFilePicker = async () => { state.saveCalls++; return fileHandle; };");
    expect(src).toContain("window.showDirectoryPicker = async () => { state.dirCalls++; return dirHandle; };");
    // The handle really accepts bytes. A stub that threw would make the whole
    // act a statement about the stub.
    expect(src).toContain("state.handleBytes += chunk.byteLength ?? chunk.size ?? 0;");
    expect(src).toContain("const fileHandle = { createWritable: async () => writable };");
    expect(src, "the directory branch lost its usable handle")
      .toContain("getFileHandle: async () => fileHandle,");
    // And that usability is PROVEN at runtime, then cleared — a function nobody
    // calls has an unobservable body, so this is the one property of the act
    // that a source contract alone cannot make real.
    expect(src).toContain("const pickersWork = await b.evaluate(");
    expect(src).toContain("pickersWork.saveCalls !== 1 || pickersWork.dirCalls !== 1 || pickersWork.handleBytes !== 8");
    expect(src, "the usability proof does not reset the counters it spends")
      .toMatch(/state\.saveCalls = 0;\n\s*state\.dirCalls = 0;\n\s*state\.handleBytes = 0;/);
    // Both counters and the handle's bytes are asserted to be exactly zero
    // AFTER the accept click, not merely before it.
    expect(src).toContain("mobile.saveCalls !== 0 || mobile.dirCalls !== 0 || mobile.handleBytes !== 0");
    expect(src, "the two picker branches were merged into one counter")
      .toContain("mobileConsent.saveCalls !== 0 || mobileConsent.dirCalls !== 0");
  });

  it("captures the download at the product's own two boundaries and swallows it", () => {
    expect(src).toContain("URL.createObjectURL = function (object) {");
    expect(src).toContain("urls.set(url, object);");
    expect(src).toContain("HTMLAnchorElement.prototype.click = function () {");
    expect(src).toContain("if (!this.download) return realAnchorClick.call(this);");
    expect(src).toContain("state.downloads.push({ name: this.download, blob: urls.get(this.href) ?? null });");
    // Exactly one download, with the exact name, the declared length and the
    // exact byte pattern — read off the Blob, never fetched through `blob:`.
    expect(src).toContain("mobile.downloads !== 1 || mobile.name !== MOBILE_NAME || !mobile.hasBlob");
    expect(src).toContain("mobile.declaredBytes !== MOBILE_BYTES || mobile.readBytes !== MOBILE_BYTES");
    expect(src).toContain("mobile.mismatch !== -1");
    expect(src, "the 96 KiB payload size drifted").toContain("const MOBILE_BYTES = 96 * 1024;");
    // One formula, interpolated into the sending page and the verifying page.
    // Two copies would make "byte-exact" mean "this file agrees with itself".
    expect(src).toContain('const MOBILE_BYTE_AT_I = "(i * 37 + 11) % 251";');
    expect(src.match(/\$\{MOBILE_BYTE_AT_I\}/g), "the payload formula is no longer written once")
      .toHaveLength(2);
    expect(src, "the byte pattern was retyped instead of interpolated")
      .not.toMatch(/!==\s*\(i \* 37 \+ 11\) % 251/);
  });

  it("applies the phone UA before the batch, since the hint resolves once at mount", () => {
    const override = src.indexOf('await b.send("Emulation.setUserAgentOverride", {');
    const uaLanded = src.indexOf("tab B to report a phone user agent and platform");
    const trap = src.indexOf("await b.evaluate(MOBILE_PICKER_AND_DOWNLOAD_TRAP);");
    const usable = src.indexOf("const pickersWork = await b.evaluate(");
    const send = src.indexOf("dt.items.add(new File([body], ${JSON.stringify(MOBILE_NAME)}));");
    const consent = src.indexOf("const mobileConsent = await b.evaluate(");
    for (const [name, at] of [["UA override", override], ["UA readiness wait", uaLanded],
      ["boundary install", trap], ["picker usability proof", usable],
      ["mobile batch send", send], ["pre-click consent read", consent]]) {
      expect(at, `${name} anchor is missing; every order check here would be vacuous`).toBeGreaterThan(-1);
    }
    expect(uaLanded).toBeGreaterThan(override);
    expect(trap).toBeGreaterThan(uaLanded);
    // Spent and cleared before the product batch exists, so the proof can never
    // be counted as the product opening a picker.
    expect(usable).toBeGreaterThan(trap);
    expect(send).toBeGreaterThan(usable);
    expect(consent).toBeGreaterThan(send);
    expect(src).toContain('const ANDROID_PLATFORM = "Linux armv8l";');
    expect(src).toContain("Android 14; Pixel 8");
  });

  it("requires a truthful Downloads promise, and no warning, before the accept click", () => {
    const consent = src.indexOf("const mobileConsent = await b.evaluate(");
    const click = src.indexOf("the memory warning inverted the phone consent row");
    const download = src.indexOf('"window.__e2eMobile.downloads.length === 1 || ');
    expect(click, "the phone's guarded accept click is gone").toBeGreaterThan(-1);
    expect(download, "the phone's save-boundary wait is gone").toBeGreaterThan(-1);
    expect(consent, "the pre-click consent read no longer precedes the click").toBeLessThan(click);
    expect(download).toBeGreaterThan(click);
    // The hint is read through the shared selector, is the only one on the card,
    // is not the retry variant, and is checked in both directions: it must
    // promise Downloads and must NOT be the picker sentence the desktop branch
    // renders — a hint asserted only by absence would pass on empty text.
    expect(src).toContain("const PROMISES_DOWNLOADS = /downloads|下载/i;");
    expect(src).toContain("const PROMISES_A_PICKER = /where to save|选择保存位置/i;");
    expect(src).toContain("!PROMISES_DOWNLOADS.test(mobileConsent.hint) || PROMISES_A_PICKER.test(mobileConsent.hint)");
    expect(src).toContain("mobileConsent.hints !== 1 || !mobileConsent.hint");
    expect(src).toContain("mobileConsent.retryHints !== 0 || mobileConsent.warnings !== 0");
    expect(src, "the phone UA is not re-proved at the moment the card is on screen")
      .toContain("mobileUa: /Android/.test(navigator.userAgent),");
  });

  /**
   * The act must be readable when it FAILS, which is the only time anyone reads
   * it. Bypassing `pickersAllowed()` in the runtime and rebuilding did make it
   * go red — correctly — but only after 60 seconds, and the red said "timed out
   * waiting for the phone's browser download". That is a symptom two steps
   * downstream of the cause: the download never came because a picker opened
   * instead, and the run never said so.
   *
   * So the wait after the accept click polls BOTH outcomes, and the counters are
   * judged before anything slower runs. Frozen here because none of it is
   * observable from a green run: a wait on the download alone, or a picker
   * verdict pushed behind the 40-second terminal wait, passes every existing
   * check in this file and silently restores the 60-second blind timeout.
   */
  it("waits for the first decisive save boundary, so a lifted gate fails fast and named", () => {
    const click = src.indexOf("the memory warning inverted the phone consent row");
    const wait = src.indexOf('"window.__e2eMobile.downloads.length === 1 || window.__e2eMobile.saveCalls > 0 || window.__e2eMobile.dirCalls > 0",');
    const decision = src.indexOf("const decision = await b.evaluate(");
    const verdict = src.indexOf("if (decision.saveCalls !== 0 || decision.dirCalls !== 0) {");
    const terminal = src.indexOf("namedTransferSucceeded(MOBILE_NAME),");
    const exact = src.indexOf("const mobile = await b.evaluate(");
    for (const [name, at] of [["accept click", click], ["combined boundary wait", wait],
      ["counter read", decision], ["picker verdict", verdict],
      ["terminal card wait", terminal], ["byte-exact read", exact]]) {
      expect(at, `${name} anchor is missing; every order check here would be vacuous`).toBeGreaterThan(-1);
    }
    // Immediately after the click, and both outcomes in one expression. The
    // download disjunct alone is the 60-second blind timeout; the picker
    // disjuncts are decisive the instant the product calls one.
    expect(wait, "the save-boundary wait no longer follows the accept click").toBeGreaterThan(click);
    expect(decision, "the counters are no longer read as soon as the wait resolves").toBeGreaterThan(wait);
    expect(verdict, "the picker verdict no longer follows the counter read").toBeGreaterThan(decision);
    // The verdict comes FIRST. Behind it the terminal wait costs another 40
    // seconds and the byte assertions describe a download that never existed.
    expect(terminal, "the terminal card wait now runs before the picker verdict").toBeGreaterThan(verdict);
    expect(exact, "the byte-exact assertions now run before the picker verdict").toBeGreaterThan(terminal);
    // The named failure carries both picker branches and the handle's own byte
    // counter, so the red says which picker opened and whether the file went
    // into it — not merely that something did not arrive.
    expect(src, "the fast picker diagnostic lost its name").toContain(
      "the phone opened a save picker instead of downloading, so the mobile no-picker gate is gone: ${JSON.stringify(decision)}",
    );
    const read = src.slice(decision, verdict);
    for (const field of ["saveCalls: state.saveCalls,", "dirCalls: state.dirCalls,",
      "handleBytes: state.handleBytes,", "downloads: state.downloads.length,"]) {
      expect(read, `the fast diagnostic no longer reports ${field}`).toContain(field);
    }
  });

  it("scopes the terminal card to this file and forbids a cancellation status", () => {
    expect(src).toContain('act("mobile-no-picker-download"');
    expect(src).toContain("mobile.namedCards !== 1 || !mobile.ok || mobile.bad");
    expect(src).toContain("mobile.bars !== 0 || !mobile.status || CANCEL_WORDS.test(mobile.status)");
    // Scoped to the two maintained runtime languages, like the hint patterns
    // above it. The archived locales under `src/lib/i18n/archive/` are not
    // rendered by the product, so their cancellation words would be asserting
    // against copy that no longer ships.
    expect(src).toContain("const CANCEL_WORDS = /cancel|取消/i;");
    // The link, the SAS, the conversation and the file lane all outlive it.
    expect(src).toContain("mobile.heads !== 1 || mobile.composers !== 1 || mobile.attachments !== 1");
    expect(src).toContain("mobile.requests !== 0");
    expect(src).toContain('oneSas(tab, who, "after a phone received a file with no picker")');
    // A missing counter throws instead of filtering the card away — otherwise a
    // renamed counter silently reduces every name-scoped check to `length === 0`.
    expect(src).toContain("a transfer card carries no file counter");
  });

  it("replaces the generic resume terminal wait so the mobile success cannot satisfy it", () => {
    expect(src).toContain('namedTransferSucceeded("resume-on-the-same-link.bin")');
    expect(
      src,
      "the resume completion wait is generic again; the earlier mobile success now satisfies it",
    ).not.toMatch(/!!document\.querySelector\('\$\{XFER\.ok\}'\) && !document\.querySelector\('\$\{XFER\.progressBar\}'\)/);
    // Still the same resume evidence behind it.
    expect(src).toMatch(/resumed\.bytes !== RESUME_BYTES/);
    expect(src).toContain('resumed.name !== "resume-on-the-same-link.bin"');
  });

  it("restores every boundary by identity in a finally, and proves it afterwards", () => {
    const finallyAt = src.indexOf('restored = await b.evaluate("(window.__e2eMobile ? window.__e2eMobile.restore() : null)");');
    const proof = src.indexOf("const desktopAgain = await b.evaluate(");
    const actAt = src.indexOf('act("mobile-no-picker-download"');
    const desktopAct = src.indexOf('act("picker-cancel-retry"');
    for (const [name, at] of [["restore call", finallyAt], ["restoration proof", proof],
      ["the mobile act", actAt], ["the desktop act", desktopAct]]) {
      expect(at, `${name} anchor is missing; the restoration checks would be vacuous`).toBeGreaterThan(-1);
    }
    expect(src, "the restoration is no longer in a finally").toMatch(/\}\s*finally\s*\{\n\s*\/\/ Finally, and in this order/);
    expect(proof, "the restoration is proved before it happens").toBeGreaterThan(finallyAt);
    expect(actAt, "the act is recorded before the restoration is proved").toBeGreaterThan(proof);
    expect(desktopAct, "the desktop picker act no longer follows the mobile one").toBeGreaterThan(actAt);
    // Identity of the exact function objects, because the desktop act wraps them
    // and calls through: "a picker is installed" is not the property.
    expect(src).toContain("save: window.showSaveFilePicker === realSave,");
    expect(src).toContain("dir: window.showDirectoryPicker === realDir,");
    expect(src).toContain("createObjectURL: URL.createObjectURL === realCreateObjectURL,");
    expect(src).toContain("anchorClick: HTMLAnchorElement.prototype.click === realAnchorClick,");
    expect(src).toContain("!restored.save || !restored.dir || !restored.createObjectURL || !restored.anchorClick");
    // The counters survive restoration, so a restore that also reset them (and
    // with it the whole zero-picker claim) fails here.
    expect(src).toContain("restored.saveCalls !== 0 || restored.dirCalls !== 0 || restored.handleBytes !== 0");
    expect(src).toContain("restored.downloads !== 1");
    // And the UA really went back — the desktop acts after it are only about a
    // desktop because this says so.
    expect(src).toContain("desktopAgain.userAgent !== desktopAgent.userAgent");
    expect(src).toContain("desktopAgain.platform !== desktopAgent.platform || desktopAgain.looksMobile");
    expect(src).toContain("looksMobile: /Android|Mobile/i.test(navigator.userAgent),");
  });

  it("cannot let its own cleanup mask the failure that triggered it, or skip half of itself", () => {
    // A `finally` that throws REPLACES the exception that sent it there. If the
    // act fails during setup — before the boundary exists — an unguarded
    // `window.__e2eMobile.restore()` reports a missing global and the setup
    // failure is never printed. And the first fault would skip the UA
    // restoration behind it, handing the desktop acts a phone.
    expect(src, "the restore call is unconditional again; a setup failure would be reported as a missing global")
      .toContain("(window.__e2eMobile ? window.__e2eMobile.restore() : null)");
    expect(src, "a cleanup fault is no longer captured instead of thrown from the finally")
      .toMatch(/\} catch \(err\) \{\n\s*cleanupFault = err;\n\s*\}/);
    expect(src, "the UA restoration is no longer independent of the boundary restoration")
      .toMatch(/\} catch \(err\) \{\n\s*cleanupFault \?\?= err;\n\s*\}/);
    // Re-raised only after the finally, i.e. only when the act itself succeeded.
    const raise = src.indexOf("if (cleanupFault) throw cleanupFault;");
    const finallyAt = src.indexOf('restored = await b.evaluate("(window.__e2eMobile ? window.__e2eMobile.restore() : null)");');
    expect(raise, "a cleanup fault is now swallowed entirely").toBeGreaterThan(finallyAt);
    // And "restored nothing" is its own named failure rather than a TypeError on
    // the next line down.
    expect(src).toContain("the phone boundary vanished before it could be restored");

    // The state itself goes with the restoration: seven acts run after this
    // one on the same page, and a global that still looks installed is how a
    // later edit reads a boundary that is not there and gets a stale zero.
    expect(src).toContain("urls.clear();");
    expect(src).toContain("state.downloads.length = 0;");
    expect(src).toContain("delete window.__e2eMobile;");
    // Read into plain numbers BEFORE the state is dropped, or the restoration
    // proof below it would assert against an emptied array.
    const summary = src.indexOf("const summary = {");
    const drop = src.indexOf("delete window.__e2eMobile;");
    expect(summary, "the restoration summary is no longer captured before the drop").toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(summary);
  });

  it("says what this is: a spoofed UA on desktop Chromium, not a real phone", () => {
    expect(src).toContain("a spoofed Android UA");
    expect(src).toContain("not a real Android device, not a real system picker and not a real");
    expect(src, "the runner started claiming real Android system coverage")
      .not.toMatch(/on a real (Android )?(phone|device)/i);
  });
});

/**
 * The selectors this runner shares with the ordinary Vitest lane.
 *
 * `dom-contracts.mjs` exists because a selector written twice is not a contract
 * (see its own header, and `QueuedBatches.test.ts`). A private copy reappearing
 * in this runner is how that lesson gets unlearned — silently, and discovered
 * only the next time somebody spends a Go build and a real Chrome on it.
 */
describe("mixed-link owns no private copy of a shared selector", () => {
  const src = read("e2e/mixed-link.mjs");

  it("imports all three contracts rather than retyping them", () => {
    expect(src).toMatch(/import \{ QUEUED, RECEIVE, XFER \} from "\.\/dom-contracts\.mjs";/);
  });

  for (const [what, pattern] of [
    ["the consent card", /['"]\.request/],
    ["the retry hint", /['"]\.savehint\.retry/],
    ["the transfer card", /['"]\.xfer/],
    ["the progress bar", /progress-bar/],
  ]) {
    it(`carries no literal for ${what}`, () => {
      expect(src, `${what} is written as a literal here instead of read from dom-contracts.mjs`)
        .not.toMatch(pattern);
    });
  }

  it("the shared module still names the nodes both lanes query", () => {
    const contracts = read("e2e/dom-contracts.mjs");
    for (const name of ["QUEUED", "RECEIVE", "XFER"]) {
      expect(contracts).toMatch(new RegExp(`export const ${name} = \\{`));
    }
    // The receive pair whose meaning INVERTS under the memory warning. Both
    // branches are asserted against real rendered markup in
    // `src/lib/ReceiveActions.test.ts`; what is pinned here is that the runner
    // is told about the inversion at all.
    expect(contracts).toContain("warning:");
    expect(contracts, "the primary/ghost inversion is no longer documented")
      .toMatch(/swapped|swap|invert/);
    // Named for presentation, never for semantics. `accept`/`decline` are the
    // retired names, and they are retired because under the warning branch each
    // one states the opposite of what the button does — a shared identifier that
    // lies to every reader deciding whether a click is safe.
    expect(contracts, "the consent buttons are named by presentation role")
      .toMatch(/primary: "\.btn-primary"/);
    expect(contracts).toMatch(/ghost: "\.btn-ghost"/);
    expect(contracts).toMatch(/retryHint: "\.savehint\.retry"/);
    expect(contracts, "a consent selector reclaimed a semantic name that inverts")
      .not.toMatch(/^\s*(accept|decline):/m);
    // And that the runner guards on the warning before BOTH consent clicks it
    // makes — the ghost click in the rejected-batch act, and the primary click
    // that starts the 5 MiB resume. Either one silently doing the opposite would
    // leave every assertion after it describing a transfer that never happened.
    //
    // The GUARD EXPRESSION, not the bare name: the prose beside each guard
    // names `RECEIVE.warning` too, so counting the identifier would make this a
    // comment-edit tripwire instead of a contract.
    const guards = src.match(/querySelector\('\$\{RECEIVE\.card\} \$\{RECEIVE\.warning\}'\)/g);
    expect(guards, "a consent click is no longer guarded by the warning check").toHaveLength(4);
    // One guard per click, and no unguarded click left over.
    const clicks = src.match(/querySelector\('\$\{RECEIVE\.card\} \$\{RECEIVE\.(primary|ghost)\}'\)/g);
    expect(clicks, "the guarded consent clicks changed count").toHaveLength(4);
  });
});

/**
 * Migration of `lan-transfer.mjs` unique #7: two pages of one browser are one
 * device, and a request lands on the page the user is looking at.
 *
 * These are source-shape guards over an expensive real-browser proof, and they
 * are written against the failure modes that would leave the journey **green
 * while proving nothing**: seeds that make the two pages separate devices, a
 * one-way focus check, a background latch that was never armed, an `includes`
 * where an exact comparison is the whole point, and — the one this migration
 * exists to prevent — quietly reverting to the retired per-card control or to
 * reading raw signalling frames instead of rendered product UI.
 *
 * They do not claim to prove any of the browser behaviour themselves. What they
 * freeze is the shape of the proof, so a later edit cannot narrow it silently.
 */
describe("mixed-link proves two pages of one browser are one device", () => {
  const src = read("e2e/mixed-link.mjs");
  const from = src.indexOf("async function multiPageDeviceScenario(");
  const to = src.indexOf("\n}\n", from);
  const body = src.slice(from, to === -1 ? undefined : to);

  it("has a greppable scenario body for every check below to be scoped to", () => {
    // Without this the slice above could silently become "" and every
    // `not.toContain` beneath it would pass over an empty string.
    expect(from, "multiPageDeviceScenario is no longer greppable").toBeGreaterThan(-1);
    expect(to, "its body has no closing brace at column 0").toBeGreaterThan(from);
    expect(body.length, "the scenario body sliced out empty").toBeGreaterThan(2_000);
  });

  it("gives the two pages one explicit shared seed and the third device another", () => {
    // The single load-bearing fact of the whole scenario. `newTab` defaults to a
    // fresh seed per tab, so two pages that did not explicitly share one are two
    // independent devices — and then "B sees one entry" is trivially true, "no
    // sibling in the roster" is trivially true, and the entire journey is green
    // and vacuous. B's distinct seed is required to be explicit for the mirror
    // reason: a B that accidentally shared the installation would be grouped in
    // with A and could never be the independent observer.
    expect(body).toMatch(/const installation = distinctLanSeed\(\);/);
    expect(body).toMatch(/const otherDevice = distinctLanSeed\(\);/);
    const seeded = [...body.matchAll(/newTab\(browser, base \+ "\/", boot, \{ lanSeed: (\w+) \}\)/g)]
      .map((m) => m[1]);
    expect(seeded, "the three pages are not all explicitly seeded").toEqual([
      "installation", "installation", "otherDevice",
    ]);
    // A `newTab` here that takes the default seed is the exact regression above.
    expect(body, "a page in this scenario was opened without an explicit seed")
      .not.toMatch(/newTab\(browser, base \+ "\/", boot\)/);
    expect(body).toMatch(/installation === otherDevice/);
    // Three connections must also be three distinct peer ids, or every roster
    // comparison below is comparing a name against itself.
    expect(body).toMatch(/new Set\(Object\.values\(ids\)\)\.size !== 3/);
  });

  it("boots the roster observer before the app, with verification off", () => {
    // Init script, not an after-the-fact evaluate: a `welcome` frame observed
    // after the app has already joined is a `welcome` that was missed, and a
    // missed one reads exactly like a page that never joined.
    expect(body).toMatch(/const boot = VERIFY_DEFAULT \+ OBSERVE_ROSTER;/);
    expect(src).toMatch(/const OBSERVE_ROSTER = `/);
    for (const frame of ["welcome", "peers", "left"]) {
      expect(src, `the roster observer stopped reading the ${frame} frame`)
        .toContain(`e.type === "${frame}"`);
    }
    // Verification OFF is what makes an arrival assertion an assertion about
    // routing rather than about a human clicking Accept. VERIFY_ON here would
    // hang every composer wait on a consent gate.
    expect(body, "this scenario opted into the verification gate it cannot answer")
      .not.toContain("VERIFY_ON");
  });

  it("asserts exact rosters on both sides, never mere membership", () => {
    // `includes(b)` would also pass for a page that listed its own sibling
    // alongside B, which is the other half of the reported defect.
    expect(body).toMatch(/const rosterIs = \(id\) => `JSON\.stringify\(window\.__roster\) ===/);
    expect(body).toMatch(/rosterIs\(ids\.b\)/);
    expect(body).toMatch(/bSees\.length !== 1 \|\| \(bSees\[0\] !== ids\.a1 && bSees\[0\] !== ids\.a2\)/);
    expect(body, "a roster check softened into a membership test")
      .not.toMatch(/window\.__roster\.includes\(/);
  });

  it("activates A2 and then A1, and requires the reverse direction to land", () => {
    // A one-way check passes on "whichever page joined last represents the
    // device", which is not the rule. The second activation is the one that
    // fails on that implementation, so its presence AND its ordering are pinned.
    const toA2 = body.indexOf("await activateTab(browser, a2);");
    const seesA2 = body.indexOf("rosterIs(ids.a2)", toA2);
    const toA1 = body.indexOf("await activateTab(browser, a1);", seesA2);
    const seesA1 = body.indexOf("rosterIs(ids.a1)", toA1);
    for (const [what, at] of [["activate A2", toA2], ["B sees A2", seesA2],
      ["the reverse activation back to A1", toA1], ["B sees A1 again", seesA1]]) {
      expect(at, `${what} is missing; the handover check would be one-way`).toBeGreaterThan(-1);
    }
    expect(seesA2).toBeGreaterThan(toA2);
    expect(toA1).toBeGreaterThan(seesA2);
    expect(seesA1).toBeGreaterThan(toA1);
    // A real activation, not a stubbed visibility flag — `activateTab` drives
    // Chrome's own target activation, which is what the app's current-page logic
    // actually reads.
    expect(body, "focus was simulated instead of actually moved")
      .not.toMatch(/visibilityState\s*=|dispatchEvent\(new Event\('visibilitychange'/);
  });

  it("requires the handover to move nobody, before and after", () => {
    // A product that re-represented the device by dropping the old page and
    // rejoining would satisfy every roster assertion above, and would drop live
    // links every time the user switched tabs. Read on both sides, so a `left`
    // that was already there cannot absorb one the handover caused.
    expect(body).toMatch(/const leftBeforeHandover = await departuresOfOurs\(\);/);
    expect(body).toMatch(/leftBeforeHandover\.length !== 0/);
    expect(body).toMatch(/const leftAfterHandover = await departuresOfOurs\(\);/);
    expect(body).toMatch(/leftAfterHandover\.length !== 0/);
    // The departure ledger is narrowed to this scenario's own three pages, and
    // to nothing else. It has to be — the previous scenario closes its tabs
    // immediately before this one opens its own, so an unrestricted ledger
    // carries stragglers. Narrowing it to a SET OF IDS keeps every assertion
    // exact; narrowing it any other way (a count, a slice, "the last one") would
    // quietly turn the exact comparisons below into membership tests.
    expect(body).toMatch(/const owned = JSON\.stringify\(\[ids\.a1, ids\.a2, ids\.b\]\);/);
    expect(body).toMatch(
      /const departuresOfOurs = \(\) => b\.evaluate\(`window\.__leftPeers\.filter\(\(id\) => \$\{owned\}\.includes\(id\)\)`\);/,
    );
    const before = body.indexOf("const leftBeforeHandover");
    const after = body.indexOf("const leftAfterHandover");
    expect(before).toBeLessThan(body.indexOf("await activateTab(browser, a2);"));
    expect(after).toBeGreaterThan(body.indexOf("await activateTab(browser, a1);"));
  });

  it("arms the background latch before the request and demands it saw a live DOM", () => {
    const armed = body.indexOf("await a2.evaluate(ARM_BACKGROUND_LATCH);");
    const clicked = body.indexOf("OPEN_WORKSPACE}').click()", armed);
    expect(armed, "the background latch is never armed").toBeGreaterThan(-1);
    expect(clicked, "no request is opened after the latch is armed").toBeGreaterThan(armed);

    // Latched, not sampled: a card that appeared and vanished is the same defect
    // as one that stayed, and a single read afterwards misses exactly that case.
    expect(src).toMatch(/const ARM_BACKGROUND_LATCH = `\(\(\) => \{/);
    expect(src).toContain("new MutationObserver(look).observe(document.body, { childList: true, subtree: true })");

    // The anti-vacuity half. Every other counter is asserted to be zero, and
    // zero is also what an unarmed latch, or one whose selectors match nothing,
    // reports. `chooser` counts a control the background page certainly has.
    expect(body).toMatch(/!\(background\.ticks > 0\) \|\| !\(background\.chooser > 0\)/);
    expect(body).toMatch(
      /background\.panel !== 0 \|\| background\.composer !== 0 \|\| background\.request !== 0 \|\| background\.head !== 0/,
    );
    // A final timing-independent sample, rather than trusting that a mutation
    // happened to fire last.
    expect(body).toContain("window.__e2eBackgroundLook(); return window.__e2eBackground;");
  });

  it("proves arrival from rendered product UI, not from signalling frames", () => {
    // The shortcut this migration must not take. "B sent a request frame" is not
    // "the focused page received it"; the whole reported defect is a request
    // that was signalled correctly and rendered on the wrong page.
    expect(body).toMatch(
      /await a1\.waitFor\("!!document\.querySelector\('\.msgpanel textarea'\)", "the FOCUSED page \(A1\)/,
    );
    expect(body).toMatch(/await b\.waitFor\("!!document\.querySelector\('\.msgpanel textarea'\)"/);
    for (const raw of ["__signalFrames", "__advertisedCaps", "RTCPeerConnection"]) {
      expect(body, `${raw} is being read as a stand-in for a rendered arrival`)
        .not.toContain(raw);
    }
    // And the observer itself must not grow a frame recorder that a later edit
    // could assert against instead of the DOM.
    expect(src.slice(src.indexOf("const OBSERVE_ROSTER = `"), src.indexOf("const ARM_BACKGROUND_LATCH")))
      .not.toContain("__signalFrames");
  });

  it("drives the current link/1 surface and never the retired per-card control", () => {
    // The migration rule for the whole stranded tail: do not restore the deleted
    // controls, and do not assert against a surface no user can reach. The
    // legacy scenario clicked `.peer-actions button`; the current product offers
    // exactly one action, `.open-workspace`.
    const opens = body.match(/document\.querySelector\('\$\{OPEN_WORKSPACE\}'\)\.click\(\)/g) ?? [];
    expect(opens, "the two workspaces are no longer opened through the product's own control")
      .toHaveLength(2);
    for (const legacy of [".peer-actions button", ".file-pick-input", "MSG_OPEN_BTN", "STRIP_LINK_CAP"]) {
      expect(body, `${legacy} is a retired control this scenario must not reach for`)
        .not.toContain(legacy);
    }
  });

  it("names exactly the closed page as gone, and exactly the sibling as the fallback", () => {
    // `includes(a1)` alone also passes when the SURVIVING page was reported gone
    // too, which is how "the device fell back" and "the device vanished and
    // something else appeared" get confused. The exact comparison is what a
    // fabricated or over-broad departure fails.
    expect(body).toMatch(/window\.__leftPeers\.includes\(\$\{JSON\.stringify\(ids\.a1\)\}\)/);
    expect(body).toMatch(
      /JSON\.stringify\(departed\) !== JSON\.stringify\(\[ids\.a1\]\)/,
    );
    // The fallback is read back exactly AFTER its wait: the wait proves the
    // roster arrived, the read proves it is the whole roster and not one live
    // entry sitting beside a stale dead id.
    const waited = body.indexOf("rosterIs(ids.a2), \"the device to fall back");
    const readBack = body.indexOf("const afterClose = await b.evaluate(\"window.__roster\")");
    expect(waited, "the fallback wait is gone").toBeGreaterThan(-1);
    expect(readBack, "the fallback is never read back exactly").toBeGreaterThan(waited);
    expect(body).toMatch(/JSON\.stringify\(afterClose\) !== JSON\.stringify\(\[ids\.a2\]\)/);
    // And the close itself is a real target close, not a simulated one.
    expect(body).toMatch(/Target\.closeTarget", \{ targetId: a1\.targetId \}/);
  });

  // The chooser-recovery helper, from its shared constants through the end of
  // the function. The constants are part of the contract — `HEAD_CONTROLS` is
  // what makes "answer whatever the product is offering" enumerable instead of
  // hand-written — so the slice starts at them rather than at the `async
  // function` line.
  const helperFrom = src.indexOf("const CHOOSER_ONLY =");
  const helperFn = src.indexOf("async function returnToChooser(");
  const helper = src.slice(helperFrom, from);

  it("answers whichever single control the header offers, and never nothing", () => {
    // A page-close leaves B holding a workspace whose peer is gone, and which of
    // the two headers it renders depends on how far the link has settled:
    // `.wh-disconnect` while `mixed-session.svelte.ts` still holds it
    // `interrupted`, `.wh-restart` once it is terminal. Both are legitimate
    // starting points, so the helper answers whichever is on screen — and must
    // never "succeed" by finding neither and doing nothing.
    expect(helperFrom, "the helper's shared constants are gone").toBeGreaterThan(-1);
    expect(helperFn, "returnToChooser is gone").toBeGreaterThan(helperFrom);
    expect(src).toMatch(/async function returnToChooser\(tab, who\)/);

    // Both controls, and reached through ONE frozen roster rather than two
    // hand-written branches: a third control appearing in `WorkspaceHeader`
    // then has one place to be taught, instead of being silently walked past.
    expect(helper).toMatch(/const HEAD_CONTROLS = Object\.freeze\(\[/);
    expect(helper).toMatch(/action: "restart", selector: `\$\{HEAD\} \.wh-restart`/);
    expect(helper).toMatch(/action: "disconnect", selector: `\$\{HEAD\} \.wh-disconnect`/);

    // "The chooser came back" is head-gone AND exactly one action, not merely a
    // chooser button existing somewhere beside a workspace that still holds the
    // screen.
    expect(helper).toMatch(/!document\.querySelector\('\$\{HEAD\}'\) && document\.querySelectorAll\('\$\{OPEN_WORKSPACE\}'\)\.length === 1/);

    // Both refusals, explicit: nothing answerable on screen, and an action the
    // frozen roster does not contain.
    expect(helper).toMatch(/if \(took === "nothing"\)/);
    expect(helper).toContain("showed neither the chooser nor an answerable workspace head");
    expect(helper).toMatch(/if \(!HEAD_CONTROLS\.some\(\(c\) => c\.action === took\)\)/);
    expect(helper).toContain("answered an unknown workspace control");

    expect(body).toMatch(/const answered = await returnToChooser\(b, "B"\);/);
  });

  it("stays one answer, not a retry loop built for a transition nobody observed", () => {
    // The correction this revision carries. An earlier version of this helper
    // clicked repeatedly, on the theory that Disconnect was asynchronously
    // followed by a terminal `.wh-restart` card. A third acceptance run with a
    // diagnostic disproved it: after Disconnect the head is simply GONE, and
    // what was missing was the chooser's action, because B had pruned the
    // surviving page's capability hello. Recovery machinery for a transition
    // that does not happen is a second place for this journey to hang, so its
    // absence is pinned rather than left to be re-added by the next timeout.
    expect(helper, "the recovery grew an unbounded answering loop again")
      .not.toMatch(/for \(;;\)|while \(true\)/);
    expect(helper, "the helper is accumulating an ordered trace of clicks again")
      .not.toMatch(/taken\.push\(/);
    // One click, taken once, from one evaluate.
    const clicks = helper.match(/el\.click\(\)/g) ?? [];
    expect(clicks, "the helper clicks a workspace control more than once").toHaveLength(1);
  });

  it("bounds it with one deadline, reports the failing state, and never sleeps", () => {
    // ONE deadline shared by both waits — finding the control, then the chooser
    // coming back — rather than a literal on each. Two literals is how a
    // "bounded" helper quietly becomes 2 × 30s.
    expect(helper).toMatch(/const CHOOSER_RECOVERY_BUDGET_MS = /);
    expect(helper).toMatch(/const deadline = Date\.now\(\) \+ CHOOSER_RECOVERY_BUDGET_MS;/);
    expect(helper).toMatch(/const left = \(\) => Math\.max\(1, deadline - Date\.now\(\)\);/);
    // BOTH waits spend it — the search for a control, and the chooser coming
    // back after one is answered. A literal on either is the bound doubling.
    const waits = helper.match(/await tab\.waitFor\(/g) ?? [];
    expect(waits.length, "the helper's wait count changed; re-check both spend the budget").toBe(2);
    const budgeted = helper.match(/\bleft\(\)[,)]/g) ?? [];
    expect(budgeted.length, "a wait in the helper is not spending the shared budget").toBe(2);
    expect(helper, "a wait inside the recovery was given its own literal timeout")
      .not.toMatch(/waitFor\([\s\S]*?\d_?\d*_000/);

    // Every refusal says what was on screen, from a read taken while the tab is
    // still alive. This is what turned two identical-looking timeouts into an
    // actual diagnosis, so `unsupported` — the counter that named the real
    // defect — is part of the contract, not incidental detail.
    expect(helper).toMatch(/const HEAD_STATE = `\(\(\) => \{/);
    expect(helper).toMatch(/unsupported: document\.querySelectorAll\('\.pa-unsupported'\)\.length/);
    expect(helper).toMatch(/const onScreen = async \(\) => \{/);
    const reported = helper.match(/on screen: \$\{await onScreen\(\)\}/g) ?? [];
    expect(reported.length, "a refusal path that does not report what was on screen")
      .toBeGreaterThanOrEqual(3);

    // And no arbitrary sleep anywhere in it. A pause "to let it settle" passes
    // on a build where the chooser never returns, which is the whole failure
    // this helper exists to catch.
    for (const stall of ["setTimeout", "sleep(", "delay(", "new Promise"]) {
      expect(helper, `${stall} is an arbitrary wait, not a product condition`)
        .not.toContain(stall);
    }
  });

  it("ends by proving the surviving page is genuinely usable, on both sides", () => {
    // "The roster fell back" is not "the device still works". The second
    // workspace has to reach the sibling AND open the opener's own composer, or
    // the fallback is cosmetic.
    const second = body.indexOf("const answered = await returnToChooser");
    const regained = body.indexOf(
      "B to be offered exactly one enabled action for the surviving page", second,
    );
    const a2Composer = body.indexOf("the surviving page to receive the next request", regained);
    const bComposer = body.indexOf("B's composer on the second workspace", a2Composer);
    // Regaining the action is asserted at the CALL SITE, after the recovery and
    // before the click. It is the product-visible form of the defect this
    // revision fixes — a B still missing the survivor's capability hello reaches
    // this point with zero actions and a `.pa-unsupported` line — so it must not
    // be left implicit inside `returnToChooser`, where a later edit could soften
    // it without this act noticing.
    expect(regained, "the act no longer requires B to regain exactly one enabled action")
      .toBeGreaterThan(second);
    expect(body).toMatch(
      /`\(\$\{CHOOSER_ONLY\}\) && !document\.querySelector\('\$\{OPEN_WORKSPACE\}'\)\.disabled`/,
    );
    expect(a2Composer, "the second link never has to reach the sibling").toBeGreaterThan(regained);
    expect(bComposer, "the opener's own composer is not proved on the second link").toBeGreaterThan(a2Composer);
    // A timeout here looks like a dozen unrelated faults, so the diagnosis is
    // captured while the pages are still alive — including the counter that
    // named the real defect the first two runs failed on.
    expect(body).toContain("diagnostics=");
    expect(body).toMatch(/unsupported: document\.querySelectorAll\('\.pa-unsupported'\)\.length/);
    expect(body).toMatch(/const errs = \[\.\.\.a2\.errors, \.\.\.b\.errors\]/);
  });

  it("makes the surviving page current before requiring it to be reachable", () => {
    // Not a cosmetic focus step. B pruned A2's capability hello while A1
    // represented the installation, and A2's own roster never changed — so the
    // ONLY thing that re-states it is A2 becoming the current page
    // (`refreshPresent`, sent beside `sendActivate`). Move this activation after
    // the recovery, or drop it, and act 5 goes back to failing the way two real
    // runs did.
    const closed = body.indexOf("Target.closeTarget\", { targetId: a1.targetId }");
    const activated = body.indexOf("await activateTab(browser, a2);", closed);
    const recovered = body.indexOf("const answered = await returnToChooser", activated);
    expect(closed, "the represented page is never closed").toBeGreaterThan(-1);
    expect(activated, "the surviving page is never made current after the close")
      .toBeGreaterThan(closed);
    expect(recovered, "the recovery no longer follows that activation").toBeGreaterThan(activated);
  });

  it("performs its five acts in the frozen order, each after its own assertions", () => {
    // Membership and count are pinned by the inventory suite; what is pinned
    // here is that the calls sit in the scenario in that order, so an act moved
    // above the assertions it reports cannot pass.
    const order = [
      "multipage-one-device",
      "multipage-focus-handover",
      "multipage-request-follows-focus",
      "multipage-fallback-on-close",
      "multipage-sibling-reachable",
    ];
    const at = order.map((name) => body.indexOf(`act("${name}"`));
    at.forEach((i, n) => expect(i, `${order[n]} is not recorded inside this scenario`).toBeGreaterThan(-1));
    expect([...at].sort((x, y) => x - y), "the multi-page acts were reordered").toEqual(at);
    // Anchored to the work each one reports: the handover act must come after
    // both activations, and the fallback act after the close.
    expect(at[1]).toBeGreaterThan(body.indexOf("await activateTab(browser, a1);"));
    expect(at[3]).toBeGreaterThan(body.indexOf("Target.closeTarget\", { targetId: a1.targetId }"));
    // And the ledger is returned, or the runner has nothing to compare.
    expect(body).toMatch(/return ledger;/);
    expect(body).toMatch(/const \{ ledger, act \} = newLedger\(MULTIPAGE_ACTS\);/);
  });

  it("keeps the twenty-act journey intact beside it", () => {
    // This slice adds a scenario; it does not edit the one that was already
    // hosted. Both ledgers are built by the same factory, so the duplicate and
    // unknown-name guards cannot exist in one and be forgotten in the other.
    expect(src).toMatch(/const \{ ledger, act \} = newLedger\(ACTS\);/);
    expect(src).toMatch(/function newLedger\(acts\)/);
    expect(src).toMatch(/is not one of this scenario's frozen acts/);
    expect(src).toMatch(/was recorded twice/);
  });
});

/**
 * Migration of `lan-transfer.mjs` unique #8: a relay pool nobody can measure is
 * still used, and the connection it cannot complete ends inside a bound.
 *
 * Source-shape guards over an expensive real-browser proof, written against the
 * ways this particular journey could stay **green while proving nothing**: a
 * probe that never ran (so "no relay was selected" is true for the wrong
 * reason), a configuration read off a probe connection rather than off the
 * product's link attempt, a relay assertion that checks a URL and forgets the
 * transport policy or the credentials, a terminal assertion whose subject was
 * never on screen, a wait with no bound, and — the standing rule for this whole
 * stranded tail — reverting to the retired per-card controls or asserting
 * success from raw signalling instead of rendered product UI.
 *
 * They prove none of the browser behaviour themselves. What they freeze is the
 * shape of the proof, so a later edit cannot narrow it silently.
 */
describe("mixed-link proves an unmeasurable relay pool is still used, and still ends", () => {
  const src = read("e2e/mixed-link.mjs");
  const from = src.indexOf("async function relayFailureScenario(");
  const to = src.indexOf("\n}\n", from);
  const body = src.slice(from, to === -1 ? undefined : to);
  /** Statements only. Several rules below name the very thing they forbid in the
   *  prose beside them, and reading a comment as a violation is the trap
   *  `workspace-orchestration.test.ts`'s `code()` helper exists for. */
  const code = body.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");

  it("has a greppable scenario body for every check below to be scoped to", () => {
    // Without this the slice could silently become "" and every `not.toContain`
    // beneath it would pass over an empty string.
    expect(from, "relayFailureScenario is no longer greppable").toBeGreaterThan(-1);
    expect(to, "its body has no closing brace at column 0").toBeGreaterThan(from);
    expect(body.length, "the scenario body sliced out empty").toBeGreaterThan(2_000);
  });

  it("serves a pool-only answer whose single relay is a documentation black hole", () => {
    // The setup is the scenario. A relay that answers would make the probe
    // succeed and select it, and every assertion here would then describe the
    // measured path rather than the unmeasured one.
    expect(src).toMatch(/const BLACK_HOLE_TURN = "turn:192\.0\.2\.\d+:\d+";/);
    expect(src).toMatch(/const POOL_STUN = "stun:192\.0\.2\.\d+:\d+";/);
    expect(src, "the pool answer grew a legacy top-level relay, which would mask the whole defect")
      .not.toMatch(/const POOL_STUN = "turns?:/);
    // The runner refuses to run on an answer that carries one, rather than
    // trusting the constant above to stay a `stun:` URL.
    expect(code).toMatch(/const topLevelRelays = \[POOL_STUN\]\.filter/);
    expect(code).toMatch(/topLevelRelays\.length !== 0/);
    // Pool-shaped: the credentials live inside `relays`, which is the
    // deployment the defect was reported on.
    expect(src).toMatch(/const POOL_ONLY_ICE = `/);
    expect(src).toMatch(/relays: \[\{/);
    expect(src).toMatch(/url\.startsWith\("\/api\/ice"\)/);
    // Only that one endpoint is answered; the page still loads the real product
    // from the real server.
    expect(src).toMatch(/return realFetch\.call\(window, input, init\);/);
  });

  it("keeps the issued credentials out of the TURN REST expiry shape", () => {
    // `relayDeadline` reads `<unix-expiry>:<token>` out of a TURN username and
    // arms a client-side terminal bound on it. A REST-shaped username here would
    // let the link end on a CREDENTIAL CLOCK while this scenario reported that
    // it had proved a bounded end to an impossible TRANSPORT — a different
    // product rule, silently standing in for the one under test.
    expect(src).toMatch(/const POOL_TURN_USERNAME = "(?!\d+:)[^"]+";/);
    expect(src).toMatch(/const POOL_TURN_CREDENTIAL = "[^"]+";/);
  });

  it("captures configurations without breaking the constructor it wraps", () => {
    // A `Proxy` construct trap, like `TRACK_PEER_CONNECTIONS`. A plain function
    // replacement breaks `instanceof` and the static members, and the product is
    // entitled to both.
    expect(src).toMatch(/const CAPTURE_RTC_CONFIGS = `/);
    expect(src).toMatch(/window\.RTCPeerConnection = new Proxy\(window\.RTCPeerConnection, \{/);
    expect(src).toMatch(/construct\(Target, args, NewTarget\) \{/);
    expect(src).toMatch(/Reflect\.construct\(Target, args, NewTarget\)/);
    // Config and connection pushed together, after a successful construction, or
    // the two arrays drift apart the first time a constructor throws.
    const capture = src.slice(src.indexOf("const CAPTURE_RTC_CONFIGS = `"), src.indexOf("const iceUrlsIn"));
    const pushedConfig = capture.indexOf("window.__rtcConfigs.push(");
    const pushedPc = capture.indexOf("window.__rtcPeerConnections.push(");
    const constructed = capture.indexOf("const pc = Reflect.construct(");
    expect(constructed, "the connection is no longer constructed before it is recorded").toBeGreaterThan(-1);
    expect(pushedConfig).toBeGreaterThan(constructed);
    expect(pushedPc).toBeGreaterThan(pushedConfig);
    expect(src, "the scenario boots without the capture it reads every assertion from")
      .toMatch(/const boot = VERIFY_DEFAULT \+ POOL_ONLY_ICE \+ CAPTURE_RTC_CONFIGS;/);
    // Verification OFF: the property is the transport, and a consent gate would
    // put a human decision in front of every state this measures.
    expect(code, "this scenario opted into a verification gate it cannot answer").not.toContain("VERIFY_ON");
  });

  it("requires the probe to have really run and really finished", () => {
    // "No relay was selected" is trivially true on a page that never probed, and
    // then every downstream assertion describes a page that was never in the
    // state the defect needs.
    expect(code).toMatch(/window\.__rtcPeerConnections\.length > 0 &&/);
    expect(code).toMatch(/pc\.signalingState === 'closed'/);
    expect(code).toMatch(/probes\.length === 0/);
    expect(code).toContain("the relay probe never ran");
    // Waited on an observable product fact, never slept through: a pause of the
    // same length passes just as happily on a build that never probed.
    for (const stall of ["setTimeout", "sleep(", "delay("]) {
      expect(code, `${stall} is an arbitrary wait, not a product condition`).not.toContain(stall);
    }
    // Each probe is checked to BE a probe of this pool — relay-only, that one
    // relay, those credentials — rather than merely counted.
    expect(code).toMatch(/JSON\.stringify\(urls\) !== JSON\.stringify\(\[BLACK_HOLE_TURN\]\)/);
    expect(code).toMatch(/cfg\.iceTransportPolicy !== "relay"/);
  });

  it("clears the probe captures, reads the clearing back, and only then clicks", () => {
    // The whole "this configuration belongs to the product attempt" claim rests
    // on the array being empty at the moment of the click. A clear that silently
    // did nothing would leave a probe capture sitting in index 0.
    const cleared = code.indexOf("window.__rtcConfigs.length = 0;");
    const readBack = code.indexOf("cleared.configs !== 0 || cleared.pcs !== 0");
    const clicked = code.indexOf("${OPEN_WORKSPACE}').click()");
    expect(cleared, "the probe captures are never cleared").toBeGreaterThan(-1);
    expect(readBack, "the clearing is never read back").toBeGreaterThan(cleared);
    expect(clicked, "the workspace is never opened after the clear").toBeGreaterThan(readBack);
    // And the attempt is read from index 0 of an array that was proven empty,
    // rather than from a `find`/`filter` that could quietly pick a probe.
    expect(code).toMatch(/const attempt = await a\.evaluate\("window\.__rtcConfigs\[0\]"\);/);
  });

  it("asserts the relay, its credentials AND the relay-only policy", () => {
    // The reported failure in three parts, each of which passes alone while the
    // product is still broken: a configuration with no relay at all; a relay URL
    // whose credentials were dropped, which allocates nothing; and a relay that
    // is present under policy "all", which spends ~20s on candidates that cannot
    // work before falling back to it.
    expect(code).toMatch(/relayed\.length === 0/);
    expect(code).toContain("pool relay credentials were issued and then discarded");
    expect(code).toMatch(/urls\.includes\(BLACK_HOLE_TURN\)/);
    expect(code).toMatch(/s\.username === POOL_TURN_USERNAME && s\.credential === POOL_TURN_CREDENTIAL/);
    expect(code).toMatch(/attempt\.iceTransportPolicy !== "relay"/);
    // The marker that makes the capture provably the PRODUCT's: the no-selection
    // fallback merges the top-level list with the pool, so the top-level STUN is
    // in the product configuration and in no probe configuration. Dropping this
    // check is how a leaked probe capture, or a genuinely selected relay, would
    // satisfy every line above.
    expect(code).toMatch(/urls\.includes\(POOL_STUN\)/);
    expect(code).toContain("that is the shape of a ");
  });

  it("proves a live rendered subject before requiring a terminal one", () => {
    // A workspace that never appeared and a workspace that failed both render
    // zero `.wh-disconnect`. Without the live wait first, the terminal assertion
    // has no subject and its "failure" is indistinguishable from a click that
    // did nothing at all.
    const live = code.indexOf(".wh-disconnect') && !document.querySelector('${HEAD} .wh-restart')");
    const liveState = code.indexOf("const liveState = await a.evaluate(");
    const terminal = code.indexOf("!!document.querySelector('${HEAD} .wh-restart')", live + 1);
    expect(live, "the live workspace header is never proved").toBeGreaterThan(-1);
    expect(liveState, "the connecting sentence is never read").toBeGreaterThan(live);
    expect(terminal, "the terminal card is never waited for, or not after the live one")
      .toBeGreaterThan(liveState);
    // The terminal read-back, in product terms: the header is still THERE (a
    // terminal state nobody can read is the other half of this defect), it
    // offers exactly the one control a terminal card should, it no longer claims
    // a path, and — the locale-independent part — its sentence has actually
    // CHANGED from the connecting one. "It says something" is satisfied by a
    // header still saying "connecting", which is the reported symptom.
    expect(code).toMatch(/!ended\.head \|\| ended\.restart !== 1 \|\| ended\.disconnect !== 0 \|\| ended\.paths !== 0 \|\|/);
    // The same claim from the other side: a workspace that unmounted itself
    // would hand the device chooser back with the failure reported nowhere.
    expect(code).toMatch(/ended\.chooser !== 0/);
    expect(code).toMatch(/!ended\.state \|\| ended\.state === liveState/);
  });

  it("bounds the whole attempt with one shared deadline and no literal waits", () => {
    // One deadline from the click onwards, spent by every wait after it. A
    // literal on each is how a "bounded" failure quietly becomes 3 × 120s — and
    // the budget is deliberately LARGER than the product's own worst-case
    // terminal bound, or a red run cannot tell "the product never terminated"
    // from "the runner ran out of patience".
    expect(src).toMatch(/const RELAY_FAILURE_BUDGET_MS = \d[\d_]*;/);
    expect(code).toMatch(/const deadline = Date\.now\(\) \+ RELAY_FAILURE_BUDGET_MS;/);
    expect(code).toMatch(/const left = \(\) => Math\.max\(1, deadline - Date\.now\(\)\);/);
    // Every wait in the scenario is bounded by a NAMED budget: the setup one
    // before the click, the shared deadline after it. None may fall back to
    // `waitFor`'s implicit default or carry a literal of its own.
    const waits = code.match(/await \w+\.waitFor\(/g) ?? [];
    const budgeted = code.match(/(RELAY_SETUP_BUDGET_MS|left\(\)),?\s*\)/g) ?? [];
    expect(waits.length, "the scenario's wait count changed; re-check every one still spends a named budget")
      .toBe(budgeted.length);
    expect(waits.length).toBeGreaterThanOrEqual(6);
    // Scoped to one statement (`[^;]`), so this reads each wait's own argument
    // list rather than sweeping from the first `waitFor(` to a digit anywhere
    // below it.
    expect(code, "a wait in this scenario was given its own literal timeout")
      .not.toMatch(/waitFor\([^;]*?,\s*\d[\d_]*\s*\)/);
    // The click starts the clock, and the elapsed time is reported, so a run
    // that passed at 119s is visibly different from one that passed at 35s.
    expect(code).toMatch(/const startedAt = Date\.now\(\);/);
    expect(code).toMatch(/const endedAfterMs = Date\.now\(\) - startedAt;/);
  });

  it("drives the current link/1 surface, never the retired controls or raw signalling", () => {
    // The migration rule for this whole tail. The legacy scenario picked up
    // `.file-pick-input` — deleted by `d175f863` — and read the transfer card's
    // status glyph. The current product offers exactly one action and reports a
    // link's end in its workspace header.
    expect(code).toMatch(/document\.querySelector\('\$\{OPEN_WORKSPACE\}'\)\.click\(\)/);
    for (const legacy of [".file-pick-input", ".pa-files", "peer-actions button", "STRIP_LINK_CAP", "MSG_OPEN_BTN"]) {
      expect(code, `${legacy} is a retired control this scenario must not reach for`)
        .not.toContain(legacy);
    }
    // No signalling-frame shortcut. "The offer went out" is not "the link ended
    // in a card the user can read", and the raw-frame observer belongs to the
    // multi-page scenario, which needs it to tell two same-named pages apart.
    for (const raw of ["OBSERVE_ROSTER", "__roster", "__selfId", "__leftPeers", "__signalFrames"]) {
      expect(code, `${raw} is being read as a stand-in for a rendered outcome`).not.toContain(raw);
    }
  });

  it("performs its four acts in the frozen order, each after its own assertions", () => {
    const order = [
      "relay-pool-only-ice",
      "relay-probe-spent-its-budget",
      "relay-only-link-attempt",
      "relay-bounded-named-failure",
    ];
    const at = order.map((name) => code.indexOf(`act("${name}"`));
    at.forEach((i, n) => expect(i, `${order[n]} is not recorded inside this scenario`).toBeGreaterThan(-1));
    expect([...at].sort((x, y) => x - y), "the relay acts were reordered").toEqual(at);
    // Anchored to the work each one reports: the attempt act after the click,
    // the failure act after the terminal wait.
    expect(at[2]).toBeGreaterThan(code.indexOf("${OPEN_WORKSPACE}').click()"));
    expect(at[3]).toBeGreaterThan(code.indexOf("const endedAfterMs ="));
    // Nothing in the body may swallow a failure and still record an act: a
    // caught error that let the run continue is exactly the vacuity the ledger
    // exists to make impossible, one level below `runScenarios`' own no-catch
    // loop.
    expect(code, "the relay scenario swallows an error around its acts").not.toMatch(/\bcatch\b/);
    expect(body).toMatch(/return ledger;/);
    expect(body).toMatch(/const \{ ledger, act \} = newLedger\(RELAY_ACTS\);/);
  });

  it("keeps both earlier scenarios intact beside it", () => {
    // This slice adds a third scenario; it edits neither of the two already
    // hosted. All three ledgers come from the same factory, so the duplicate and
    // unknown-name guards cannot exist in two of them and be forgotten in one.
    expect(src).toMatch(/const \{ ledger, act \} = newLedger\(ACTS\);/);
    expect(src).toMatch(/const \{ ledger, act \} = newLedger\(MULTIPAGE_ACTS\);/);
    expect(src).toMatch(/const EXPECTED_ACT_COUNT = 20;/);
    expect(src).toMatch(/const EXPECTED_MULTIPAGE_ACT_COUNT = 5;/);
  });
});


/**
 * Migration of the last shape stranded in `lan-transfer.mjs`: what a peer this
 * build cannot reach is TOLD, and what it is not offered.
 *
 * The retired `capsSuppressedScenario` checked one thing — no message control
 * for a peer that never announced — and that is no longer the product rule.
 * There is no per-peer message control to withhold, and withholding is only half
 * of what this product does: a peer that does not announce exactly `link/1` gets
 * an explicit, non-interactive `<p class="pa-unsupported">` saying so.
 *
 * These are source-shape guards over an expensive real-browser proof. They do
 * not claim to prove any of the rendering themselves; what they freeze is the
 * shape of the proof, written against the failure modes that would leave the
 * journey **green while proving nothing**: a suppression that suppressed
 * nothing, an absence measured by waiting rather than against a live positive
 * control, a "no controls" result with no statement beside it (which is the
 * silence the statement replaced), a subject that had already unmounted, a
 * swallowed scenario, and the two shortcuts this whole tail exists to prevent —
 * reaching for a retired control or reading raw signalling frames instead of
 * rendered product UI.
 */
describe("mixed-link proves an unannounced peer is told so, and offered nothing", () => {
  const src = read("e2e/mixed-link.mjs");
  /** Everything this slice added: its constants, its probes and its scenario.
   *  Wider than the function body on purpose — the wire filter, the drag/drop
   *  probes and the pointer helpers are where a legacy selector or an arbitrary
   *  wait would hide if the checks below only looked inside the body. */
  const regionFrom = src.indexOf("const MAINTAINED_LANGS = Object.freeze(");
  const from = src.indexOf("async function unsupportedPeerScenario(");
  const to = src.indexOf("\n}\n", from);
  const region = src.slice(regionFrom, to === -1 ? undefined : to);
  const body = src.slice(from, to === -1 ? undefined : to);
  /** Statements only, for both slices. Several rules below name the very thing
   *  they forbid in the prose beside them, and reading a comment as a violation
   *  is the trap `workspace-orchestration.test.ts`'s `code()` helper exists
   *  for. */
  const strip = (text) => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  const code = strip(body);
  const regionCode = strip(region);

  it("has a greppable scenario body for every check below to be scoped to", () => {
    // Without this the slices could silently become "" and every `not.toContain`
    // beneath them would pass over an empty string.
    expect(regionFrom, "the scenario's constants are no longer greppable").toBeGreaterThan(-1);
    expect(from, "unsupportedPeerScenario is no longer greppable").toBeGreaterThan(regionFrom);
    expect(to, "its body has no closing brace at column 0").toBeGreaterThan(from);
    expect(body.length, "the scenario body sliced out empty").toBeGreaterThan(2_000);
    expect(region.length).toBeGreaterThan(body.length);
  });

  it("suppresses a REAL announcement, and refuses to run if it suppressed nothing", () => {
    // The three ways this scenario could be vacuous, each closed by its own
    // counter rather than by trusting the filter's predicate to keep matching.
    expect(src).toMatch(/const SUPPRESS_CAPS_HELLO = `/);
    expect(src).toMatch(/window\.__unsupportedPeer = \{ capsFrames: 0, sawLink: 0, suppressed: 0, otherCapsFrames: 0 \};/);
    // Only the ROSTER hello is dropped — `data` carrying nothing but `caps`,
    // the same shape `OBSERVE_CAPS` recognises as this build's announcement.
    expect(src).toMatch(/Object\.keys\(frame\.data\)\.length === 1/);
    expect(src).toMatch(/seen\.suppressed\+\+;/);
    // 1. the build really announced link/1 before the filter removed it. Without
    //    this, a product that stopped advertising the capability would leave
    //    every "no control was offered" below passing for the wrong reason.
    expect(code).toMatch(/!\(wire\.sawLink > 0\)/);
    expect(code).toContain("this build never announced link/1 before the filter");
    // 2. the filter actually fired.
    expect(code).toMatch(/!\(wire\.suppressed > 0\)/);
    expect(code).toContain("the caps hello was never actually suppressed");
    // 3. nothing else carried a capability list onto the wire behind it.
    expect(code).toMatch(/wire\.otherCapsFrames !== 0 \|\| wire\.capsFrames !== wire\.suppressed/);
    // And exactly ONE tab is the old peer. A filter installed run-wide would
    // make "neither tab offers a control" a statement about the harness.
    expect(code).toMatch(/const freshFilter = await fresh\.evaluate\("typeof window\.__unsupportedPeer"\);/);
    expect(code).toMatch(/freshFilter !== "undefined"/);
    // The filter is a test-side wire rewrite, never a product switch: a runtime
    // flag inside the product would ship a way to downgrade the protocol.
    expect(regionCode, "the scenario reached for a product-side downgrade switch")
      .not.toMatch(/localStorage\.setItem|__e2eDowngrade|LINK_BUILD_SUPPORT/);
  });

  it("keeps both peers on each other's radar, and proves the live control beside the absence", () => {
    // Mutual visibility is what separates this scenario from a much less
    // interesting one: a peer that vanished from the roster also has no control
    // and no card, and would satisfy every absence here while proving nothing
    // about capability at all.
    expect(code).toMatch(/const oneCard = `document\.querySelectorAll\('\$\{PEER_CARD\}'\)\.length === 1`/);
    expect(code).toMatch(/document\.querySelectorAll\('\.pname'\)\.length === 1/);
    expect(code).toMatch(/\["the suppressed tab", suppressed\], \["the fresh tab", fresh\]/);
    // The positive control: the suppressed tab still RECEIVES normally, so the
    // fresh tab is an ordinary reachable peer to it, with the ordinary single
    // enabled action. Every absence below is measured against this.
    expect(code).toMatch(/document\.querySelectorAll\('\$\{OPEN_WORKSPACE\}'\)\.length === 1`/);
    expect(code).toMatch(/const reachable = await suppressed\.evaluate\(CARD_SHAPE\);/);
    expect(code).toMatch(/reachable\.unreachable \|\| reachable\.statements !== 0 \|\| reachable\.pageStatements !== 0/);
  });

  it("reads the statement and the controls from ONE pass, so neither can stand alone", () => {
    // The failure this exists for: a card with no controls AND no statement is
    // the silence the statement replaced, and it satisfies "zero controls"
    // perfectly. The two facts are read from the same rendered frame rather than
    // two round trips apart, where each could be true of a different one.
    const shape = src.slice(src.indexOf("const CARD_SHAPE = `"), src.indexOf("const IDLE_SHAPE = `"));
    expect(shape.length, "CARD_SHAPE is no longer greppable").toBeGreaterThan(500);
    expect(shape).toMatch(/statements: card \? card\.querySelectorAll\('\$\{UNSUPPORTED_STATEMENT\}'\)\.length : 0,/);
    expect(shape).toMatch(/pageStatements: document\.querySelectorAll\('\$\{UNSUPPORTED_STATEMENT\}'\)\.length,/);
    expect(shape).toMatch(/controls: card/);
    expect(shape).toMatch(/refusing: card \? card\.querySelectorAll\('\[disabled\], \[aria-disabled\]'\)\.length : 0,/);
    // Exactly one, on the card AND on the page: two cards saying it would
    // satisfy the first while the page said the same thing twice.
    expect(code).toMatch(/shape\.statements !== 1 \|\| shape\.pageStatements !== 1/);
    // Non-interactive in the three ways that matter to assistive technology.
    // `aria-disabled` is the near-miss: it says "a control, currently not
    // available", i.e. "not now", when the truth is "not this device".
    expect(code).toMatch(/shape\.tag !== "P" \|\| shape\.role !== null \|\| shape\.tabindex !== null \|\| shape\.ariaDisabled !== null/);
    expect(code).toMatch(/shape\.statementCursor === "pointer"/);
    // And the controls check names the statement's own act as its predecessor,
    // so a run cannot reach "no controls" without having proved the sentence.
    const stated = code.indexOf('act("unsupported-one-noninteractive-statement"');
    const controlled = code.indexOf('act("unsupported-no-control-no-affordance"');
    expect(stated, "the statement act is missing").toBeGreaterThan(-1);
    expect(controlled, "the no-control act is not recorded after the statement act").toBeGreaterThan(stated);
    expect(code).toMatch(/rest\.controls !== 0 \|\| rest\.refusing !== 0 \|\| rest\.openWorkspace !== 0/);
  });

  it("asserts across the maintained languages only, and never against locale copy", () => {
    // `i18n/types.ts` maintains exactly these two. The frozen locales are
    // archived translations, and the supported-language policy forbids treating
    // their copy as an ordinary acceptance requirement — asserting on one would
    // make this go red for a locale nobody is keeping current.
    expect(src).toMatch(/const MAINTAINED_LANGS = Object\.freeze\(\["en", "zh"\]\);/);
    expect(code).toMatch(/for \(const code of MAINTAINED_LANGS\) \{/);
    expect(code).toMatch(/await setLocale\(fresh, code\);/);
    for (const frozen of ["ja", "ko", "de", "fr", "ar", "es", "pt"]) {
      expect(regionCode, `${frozen} is an archived locale this scenario must not assert on`)
        .not.toMatch(new RegExp(`["']${frozen}["']`));
    }
    // Structural and comparative, never literal copy: a copy edit in `en.ts` or
    // `zh.ts` must not turn this red, and a build that hard-coded one language
    // must not turn it green. So the sentence is never compared to a string.
    for (const read of ["shape\\.text", "refusal\\.notice", "refusal\\.statement"]) {
      expect(regionCode, `the statement is compared against a locale literal via ${read.replace("\\", "")}`)
        .not.toMatch(new RegExp(`${read}\\s*(===|!==|\\.includes\\()\\s*["']`));
    }
    // What replaces the literal: it is present in both, and it CHANGES between
    // them. Two maintained languages rendering the same bytes is the one shape
    // that satisfies every structural check while the product has stopped
    // translating this sentence at all.
    expect(code).toMatch(/new Set\(spoken\)\.size !== spoken\.length/);
    expect(code).toMatch(/shape\.text\.length < 12/);
    expect(code).toMatch(/!shape\.name \|\| shape\.text === shape\.name/);
    expect(code).toMatch(/shape\.lang !== code/);
  });

  it("measures every absence against a live positive control, never against elapsed time", () => {
    // The retired scenario sampled for 8 seconds and concluded absence from
    // silence. A sampled window proves only that the runner was patient: it
    // passes identically on a page that failed to render, on a roster that lost
    // the peer, and on a probe whose selectors stopped matching. Every absence
    // here is paired with something that IS there, on the same build.
    for (const stall of ["setTimeout", "sleep(", "delay(", "Date.now()"]) {
      expect(code, `${stall} is an arbitrary wait, not a product condition`).not.toContain(stall);
    }
    // 1. the click really landed, counted by the browser rather than inferred.
    expect(src).toMatch(/const COUNT_CLICKS = `/);
    expect(src).toMatch(/window\.addEventListener\('click', \(e\) => \{/);
    expect(src).toContain("e.target.closest('${PEER_CARD}')");
    expect(code).toMatch(/clicks\.total !== 1 \|\| clicks\.onCard !== 1/);
    // 2. it landed on the CARD, not on an overlay in front of it.
    expect(src).toMatch(/const hit = document\.elementFromPoint\(x, y\);/);
    expect(src).toMatch(/inside: !!\(hit && el\.contains\(hit\)\)/);
    expect(src).toContain("lands outside that card");
    // 3. a real pointer, so hit testing and `:hover` are the browser's own.
    expect(src).toMatch(/tab\.send\("Input\.dispatchMouseEvent", \{ type: "mouseMoved"/);
    expect(src).toMatch(/type: "mousePressed", x, y, button: "left"/);
    expect(regionCode, "a synthesised click would measure a dispatch, not a product")
      .not.toMatch(/\.click\(\)/);
    expect(code).toMatch(/matches\(':hover'\)`,/);
    // 4. the drag probe is proven able to move a card's class BEFORE the
    //    unreachable card is dragged at all. All four positions are pinned, not
    //    just the two assertions: a runner that dispatches both drags up front
    //    and only judges them in this order still takes the negative measurement
    //    with a probe nothing has yet shown to work, and a probe whose selector
    //    quietly stopped matching is, at that moment, indistinguishable from a
    //    product that refuses. The order these four have to be in is
    //    dispatch positive → validate positive → dispatch negative → judge it.
    const positiveDispatch = code.indexOf("const reachableDrag = await suppressed.evaluate(dragOver(PEER_CARD));");
    const positiveCheck = code.indexOf("!reachableDrag.during || reachableDrag.after");
    const negativeDispatch = code.indexOf("const freshDrag = await fresh.evaluate(dragOver(PEER_CARD));");
    const negativeCheck = code.indexOf("freshDrag.before || freshDrag.during || freshDrag.after");
    expect(positiveDispatch, "the drag probe has no positive control").toBeGreaterThan(-1);
    expect(positiveCheck, "the positive control is dispatched but never validated")
      .toBeGreaterThan(positiveDispatch);
    expect(negativeDispatch, "the unreachable card is dragged before the positive control is validated")
      .toBeGreaterThan(positiveCheck);
    expect(negativeCheck, "the unreachable card's refusal is not judged after its own drag")
      .toBeGreaterThan(negativeDispatch);
    // A real file drag: `hasFiles` gates every window-level handler on `types`
    // containing "Files", so an event without one is refused for a reason that
    // has nothing to do with the peer.
    expect(src).toMatch(/dt\.items\.add\(new File\(\['x'\], 'refused\.txt'/);
    expect(src).toMatch(/new DragEvent\('dragover', \{ bubbles: true, cancelable: true, dataTransfer: dt \}\)/);
    // 5. the quiet suppressed tab is watched by the same latch whose `chooser`
    //    field is its own anti-vacuity half.
    expect(code).toMatch(/await suppressed\.evaluate\(ARM_BACKGROUND_LATCH\);/);
    //    Sampled once more at the end, in the SAME round trip as the read, so
    //    the final counts cannot be the ones a mutation happened to fire last.
    expect(code).toMatch(/window\.__e2eBackgroundLook\(\); return window\.__e2eBackground;/);
    expect(code).toMatch(/!\(watched\.ticks > 0\) \|\| !\(watched\.chooser > 0\)/);
    expect(code).toMatch(/watched\.panel \|\| watched\.composer \|\| watched\.request \|\| watched\.head/);
  });

  it("keeps a live rendered subject under every claim it makes", () => {
    // "Nothing happened" is worth nothing if the page it is read from lost the
    // peer, the card or the statement first — that page reports every zero this
    // scenario wants, for the one reason it must never accept.
    expect(src).toMatch(/const IDLE_SHAPE = `/);
    expect(src).toMatch(/peers: document\.querySelectorAll\('\$\{PEER_CARD\}'\)\.length,/);
    expect(src).toMatch(/statements: document\.querySelectorAll\('\$\{UNSUPPORTED_STATEMENT\}'\)\.length,/);
    expect(code).toMatch(/afterClick\.peers !== 1 \|\| afterClick\.statements !== 1/);
    expect(code).toMatch(/afterDrop\.peers !== 1 \|\| afterDrop\.statements !== 1/);
    expect(code).toMatch(/quiet\.peers !== 1 \|\| quiet\.statements !== 0/);
    // Read twice, either side of the drag and drop work, so a click or drop that
    // DID start something asynchronous has had every round trip since to render
    // it. One read alone could have been taken before the product got there.
    const first = code.indexOf("const afterClick = await fresh.evaluate(IDLE_SHAPE);");
    const second = code.indexOf("const afterDrop = await fresh.evaluate(IDLE_SHAPE);");
    expect(first, "the idle sweep never runs").toBeGreaterThan(-1);
    expect(second, "the idle sweep is taken only once").toBeGreaterThan(first);
    // The shared contracts, not private literals, for the three cards
    // `dom-contracts.mjs` owns — so a card that moves takes this sweep with it
    // instead of silently reducing it to a count of nodes that no longer exist.
    expect(src).toMatch(/consent: document\.querySelectorAll\('\$\{RECEIVE\.card\}'\)\.length,/);
    expect(src).toMatch(/xfer: document\.querySelectorAll\('\$\{XFER\.card\}'\)\.length,/);
    expect(src).toMatch(/queued: document\.querySelectorAll\('\$\{QUEUED\.card\}'\)\.length,/);
  });

  it("proves the statement is TRUE, not merely rendered", () => {
    // Everything else proves the sentence is present and inert. This is the only
    // check that the sentence is a fact: the product refuses a drop aimed at
    // this peer with the same message key it renders on the card, so a drop that
    // lands anyway makes the claim and the enforcement one thing — established
    // without a single locale string being written into the runner.
    expect(code).toMatch(/const drop = await fresh\.evaluate\(dropOn\(PEER_CARD\)\);/);
    expect(code).toMatch(/refusal\.notice !== refusal\.statement/);
    // `refused` is `dispatchEvent` returning false, i.e. the page called
    // `preventDefault`. A drop the page ignores is left to the browser; a drop
    // the page CONSUMES and does nothing with is the file vanishing silently.
    expect(src).toMatch(/const delivered = el\.dispatchEvent\(new DragEvent\('drop'/);
    expect(src).toMatch(/return \{ refused: !delivered/);
    expect(code).toMatch(/!drop\.refused/);
    expect(code).toMatch(/drop\.files !== 1/);
    // Provoked LAST among the fresh tab's interactions: the notice is a fixed
    // overlay, and one raised earlier could sit between a pointer and the card.
    expect(code.indexOf("dropOn(PEER_CARD)")).toBeGreaterThan(code.indexOf("await clickAt(fresh"));
    expect(code.indexOf("dropOn(PEER_CARD)")).toBeGreaterThan(code.indexOf("dragOver(PEER_CARD)"));
    // And the wait for it is deliberately shorter than the notice's own 3.5s
    // self-clear, or a run could "time out" on a notice that had already come
    // and gone and report that the product said nothing.
    expect(src).toMatch(/const UNSUPPORTED_REFUSAL_BUDGET_MS = 3_000;/);
  });

  it("withholds every affordance a card can carry with no control on it", () => {
    // Four ways a card is still misleading with zero controls: a click handler
    // with nothing behind it, a drag highlight for a drop that will be refused,
    // the accent fill that means "you are about to act on this", and a pointer
    // cursor promising a press. The first two are checked above; these are the
    // paint, and both are differential against the reachable card one tab away.
    expect(code).toMatch(/rest\.background === reachable\.background \|\| rest\.border === reachable\.border/);
    expect(code).toMatch(/rest\.cursor === "pointer" \|\| reachable\.cursor !== "pointer"/);
    // Both cards must be in the SOLO roster for that comparison to mean what it
    // says: the accent fill is the solo rule, and comparing a solo card against
    // a non-solo one would find a difference that has nothing to do with reach.
    expect(code).toMatch(/!rest\.solo \|\| !reachable\.solo/);
    // Hover changes nothing on it either, sampled only once the browser agrees
    // the pointer is over the card.
    expect(code).toMatch(/hovered\.background !== rest\.background \|\| hovered\.borderColor !== rest\.borderColor/);
  });

  it("reads the missing click handler off the product, not only off the browser", () => {
    // The one claim in this scenario the live journey cannot make on its own.
    // The browser proves a real click on the unreachable card CHANGES NOTHING;
    // it cannot distinguish that from a handler that ran and returned early. The
    // act beside it says there is no handler, and `App.svelte`'s own comment
    // says the absence is deliberate — "a handler here would be a listener whose
    // whole body is a guard that returns — and the card would still be, to every
    // pointer and every inspector, a thing that handles clicks". So the shape is
    // read off the product source: the attribute itself is the conditional, and
    // its else-branch is `undefined`, which is Svelte for "attach nothing".
    const app = read("src/App.svelte");
    const card = app.indexOf('class="pcard"');
    expect(card, "the .pcard element is no longer greppable in App.svelte").toBeGreaterThan(-1);
    const handler = app.indexOf("onclick=", card);
    expect(handler, "the .pcard element carries no onclick binding at all").toBeGreaterThan(card);
    // Conditional at the BINDING. A handler attached unconditionally and guarded
    // inside its body would satisfy the journey's no-effect proof exactly.
    expect(app.slice(handler, handler + 40), "the .pcard onclick is not gated on unifiedPeer")
      .toMatch(/^onclick=\{unifiedPeer \? /);
    const otherwise = app.indexOf("} : undefined}", handler);
    expect(otherwise, "the .pcard onclick has no undefined branch for a peer this build cannot reach")
      .toBeGreaterThan(handler);
    // ...and that branch belongs to THIS element. Without this, an `undefined`
    // ternary on some later element would satisfy the check above.
    expect(app.slice(handler, otherwise), "the undefined branch read here belongs to a later element")
      .not.toMatch(/<\/?\w/);
    // The visual half of the same decision, in the same file: the card that
    // answers nothing also stops looking pressable.
    expect(app, "the unreachable card no longer withdraws the pointer cursor")
      .toMatch(/\.peer\.unreachable \.pcard \{[^}]*cursor: default;/);
    // Retained, not replaced. The source shape says no listener is attached; the
    // journey still proves a real click lands on that card and opens nothing, so
    // a product that reattaches the handler behind a different name is caught by
    // the browser even while this contract is being edited to match it.
    expect(code).toMatch(/clicks\.total !== 1 \|\| clicks\.onCard !== 1/);
    expect(code).toMatch(/afterClick\.head \|\| afterClick\.panel/);
  });

  it("drives the current link/1 surface, never the retired controls or raw signalling", () => {
    // The migration rule for this whole tail. The retired scenario drove
    // `MSG_OPEN_BTN` on the peer card; `d175f863` deleted that control along
    // with `.pa-files` and `.file-pick-input`, and the current product answers
    // an unreachable peer with a sentence and nothing else.
    for (const legacy of [".file-pick-input", ".pa-files", "peer-actions button", "STRIP_LINK_CAP", "MSG_OPEN_BTN", ".attach-file"]) {
      expect(regionCode, `${legacy} is a retired control this scenario must not reach for`)
        .not.toContain(legacy);
    }
    // No signalling-frame shortcut. "The hello was suppressed" is a statement
    // about the wire and it is made from the wire; every statement about what
    // the user SEES is made from rendered product UI, and the raw roster
    // observer belongs to the multi-page scenario, which needs it to tell two
    // same-named pages apart.
    for (const raw of ["OBSERVE_ROSTER", "OBSERVE_CAPS", "__roster", "__selfId", "__leftPeers"]) {
      expect(regionCode, `${raw} is being read as a stand-in for a rendered outcome`).not.toContain(raw);
    }
  });

  it("bounds every wait with a named budget, and none with a literal", () => {
    expect(src).toMatch(/const UNSUPPORTED_SETUP_BUDGET_MS = \d[\d_]*;/);
    expect(src).toMatch(/const UNSUPPORTED_POINTER_BUDGET_MS = \d[\d_]*;/);
    const waits = code.match(/await \w+\.waitFor\(/g) ?? [];
    const budgeted = code.match(/(UNSUPPORTED_SETUP_BUDGET_MS|UNSUPPORTED_POINTER_BUDGET_MS|UNSUPPORTED_REFUSAL_BUDGET_MS),?\s*\)/g) ?? [];
    expect(waits.length, "the scenario's wait count changed; re-check every one still spends a named budget")
      .toBe(budgeted.length);
    expect(waits.length).toBeGreaterThanOrEqual(4);
    // Scoped to one statement (`[^;]`), so this reads each wait's own argument
    // list rather than sweeping from the first `waitFor(` to a digit anywhere
    // below it.
    expect(code, "a wait in this scenario was given its own literal timeout")
      .not.toMatch(/waitFor\([^;]*?,\s*\d[\d_]*\s*\)/);
  });

  it("performs its five acts in the frozen order, each after its own assertions", () => {
    const order = [
      "unsupported-caps-suppressed-on-the-wire",
      "unsupported-one-noninteractive-statement",
      "unsupported-no-control-no-affordance",
      "unsupported-drop-refused-with-that-sentence",
      "unsupported-quiet-suppressed-tab",
    ];
    const at = order.map((name) => code.indexOf(`act("${name}"`));
    at.forEach((i, n) => expect(i, `${order[n]} is not recorded inside this scenario`).toBeGreaterThan(-1));
    expect([...at].sort((x, y) => x - y), "the unsupported-peer acts were reordered").toEqual(at);
    // Anchored to the work each one reports.
    expect(at[0]).toBeGreaterThan(code.indexOf("const wire = await suppressed.evaluate("));
    expect(at[1]).toBeGreaterThan(code.indexOf("new Set(spoken).size"));
    expect(at[2]).toBeGreaterThan(code.indexOf("freshDrag.before ||"));
    expect(at[3]).toBeGreaterThan(code.indexOf("refusal.notice !== refusal.statement"));
    expect(at[4]).toBeGreaterThan(code.indexOf("const errs = ["));
    // Nothing in the body may swallow a failure and still record an act: a
    // caught error that let the run continue is exactly the vacuity the ledger
    // exists to make impossible, one level below `runScenarios`' own no-catch
    // loop.
    expect(code, "the unsupported-peer scenario swallows an error around its acts").not.toMatch(/\bcatch\b/);
    expect(body).toMatch(/return ledger;/);
    expect(body).toMatch(/const \{ ledger, act \} = newLedger\(UNSUPPORTED_ACTS\);/);
    // Verification OFF, and explicitly rather than by omission: the profile is
    // shared, and the first journey in this run turns the preference ON.
    expect(code).toMatch(/VERIFY_DEFAULT \+ SUPPRESS_CAPS_HELLO/);
    expect(code, "this scenario opted into a verification gate nothing here answers").not.toContain("VERIFY_ON");
    // Both tabs are swept for console errors — the half of the retired scenario
    // that was about the OLD peer's own screen.
    expect(code).toMatch(/\[\.\.\.suppressed\.errors, \.\.\.fresh\.errors\]/);
  });

  it("keeps all three earlier scenarios intact beside it", () => {
    // This slice adds a fourth scenario; it edits none of the three already
    // hosted. All four ledgers come from the same factory, so the duplicate and
    // unknown-name guards cannot exist in three of them and be forgotten in one.
    expect(src).toMatch(/const \{ ledger, act \} = newLedger\(ACTS\);/);
    expect(src).toMatch(/const \{ ledger, act \} = newLedger\(MULTIPAGE_ACTS\);/);
    expect(src).toMatch(/const \{ ledger, act \} = newLedger\(RELAY_ACTS\);/);
    expect(src).toMatch(/const EXPECTED_ACT_COUNT = 20;/);
    expect(src).toMatch(/const EXPECTED_MULTIPAGE_ACT_COUNT = 5;/);
    expect(src).toMatch(/const EXPECTED_RELAY_ACT_COUNT = 4;/);
  });
});

/**
 * The product fix that journey is the acceptance case for: a page that becomes
 * the current one re-states what it speaks.
 *
 * ## The defect, confirmed rather than guessed
 *
 * Two real acceptance runs of the multi-page journey failed at act 5, and the
 * first diagnosis — an asynchronous `.wh-disconnect` → `.wh-restart` header
 * transition the helper had not modelled — was **wrong**. A third run carrying a
 * temporary diagnostic settled it: after A1 closes and B answers Disconnect, B's
 * raw roster is exactly `[A2]`, the workspace head is absent, the open-workspace
 * count is **zero**, and one `.pa-unsupported` card says A2 is too old to talk
 * to.
 *
 * The cause is one-sided pruning. `retainPeers` drops a peer's announcement when
 * that peer leaves the roster, and two pages of one browser are ONE roster
 * entry — so while A1 represented the installation, B pruned A2's hello. A2's
 * own roster never changed through any of it, so `CapsAnnouncer` still counts B
 * greeted and its roster path can never send again. Neither side is waiting for
 * anything, and the device is unreachable for the life of the page.
 *
 * ## Why the contract is here
 *
 * `caps-vectors.test.ts` pins the announcer's behaviour, and `mixed-link.mjs`
 * proves the journey in a real browser at the cost of a Go build and a headless
 * Chrome. What neither covers cheaply is the WIRING: that the one product
 * transition which re-states the hello still does so, alongside the activation
 * it travels with, and still does not do any of the things that would turn a
 * repair into a broadcast storm or a ping-pong.
 */
describe("becoming the current page re-states this build's capabilities", () => {
  const app = read("src/App.svelte");
  const caps = read("src/lib/peer-caps.svelte.ts");
  const currentPage = read("src/lib/current-page.ts");

  it("does both things on a current-page transition, from one callback", () => {
    // `sendActivate` makes this page the one a peer is OFFERED; the hello is
    // what lets the peer act on the offer. Splitting them, or keeping only the
    // first, is exactly the state the diagnostic found: B is pointed at A2 and
    // has no announcement to render an action from.
    const m = app.match(/onMount\(\(\) => watchCurrentPage\(\(\) => \{([\s\S]*?)\n  \}\)\);/);
    expect(m, "the current-page watch is no longer a single greppable callback").not.toBeNull();
    const cb = m[1];
    expect(cb).toMatch(/signaling\.sendActivate\(\);/);
    expect(cb).toMatch(/capsAnnouncer\.refreshPresent\(otherPeerIds\(\)\);/);
    // One socket guard for both, so a page cannot activate without announcing.
    expect(cb).toMatch(/if \(!signaling\) return;/);
  });

  it("announces to the roster minus self, through the same expression the roster path uses", () => {
    // Two hand-written filters are two chances to disagree about who "everyone
    // else" is — and announcing to `selfId` is a frame the server bounces and a
    // hello this page would record about itself.
    expect(app).toMatch(
      /const otherPeerIds = \(\) => peers\.filter\(\(p\) => p\.id !== selfId\)\.map\(\(p\) => p\.id\);/,
    );
    expect(app).toMatch(/capsAnnouncer\.rosterChanged\(otherPeerIds\(\)\);/);
    const uses = app.match(/otherPeerIds\(\)/g) ?? [];
    expect(uses.length, "the two announcement paths no longer share one roster expression")
      .toBe(2);
  });

  it("fires on a genuine transition only, and never on initial mount", () => {
    // The edge lives in `current-page.ts` and is what keeps this from being a
    // second join-time broadcast: the join frame already carries the state, and
    // focus/visibility events arrive in bursts.
    expect(currentPage).toMatch(/let announced = isCurrentPage\(doc\);/);
    expect(currentPage).toMatch(/if \(announced\) return;\n\s*announced = true;\n\s*onBecomeCurrent\(\);/);
    // A page that starts current must not call back before an event arrives.
    const watch = currentPage.slice(currentPage.indexOf("export function watchCurrentPage("));
    const calls = watch.match(/onBecomeCurrent\(\)/g) ?? [];
    expect(calls.length, "watchCurrentPage gained a second call site for its callback").toBe(1);
    expect(watch, "watchCurrentPage now announces at startup as well as on the edge")
      .not.toMatch(/return \(\) => \{[\s\S]*onBecomeCurrent\(\)/);
  });

  it("never answers a hello with a hello", () => {
    // The structural rule that keeps two clients from talking past each other
    // for the life of the room. The receive path may only RETIRE.
    const receive = app.slice(app.indexOf("if (recordPeerCaps(from, data)) {"));
    const branch = receive.slice(0, receive.indexOf("return;"));
    expect(branch).toMatch(/capsAnnouncer\.didHearFrom\(from\);/);
    expect(branch, "the caps receive path now sends an announcement back")
      .not.toContain("refreshPresent");
    // And there is exactly ONE caller in the whole app: the current-page edge.
    const callers = app.match(/refreshPresent\(/g) ?? [];
    expect(callers.length, "refreshPresent gained a second call site").toBe(1);
  });

  it("sends once and owes nothing: no greeted, pending, budget or timer touched", () => {
    // The announcer's whole value is that it is bounded and retires. A refresh
    // that re-greeted would restart a full retry burst on every tab switch; one
    // that consumed `#pending` would eat the attempts a peer which has never
    // answered is still owed; one that armed the timer would put periodic work
    // back into a settled, idle tab.
    const at = caps.indexOf("  refreshPresent(peerIds: readonly string[]): void {");
    expect(at, "refreshPresent is gone or no longer greppable").toBeGreaterThan(-1);
    const end = caps.indexOf("\n  }\n", at);
    expect(end, "refreshPresent has no closing brace").toBeGreaterThan(at);
    const method = caps.slice(at, end);

    expect(method).toMatch(/if \(this\.#stopped \|\| !linkRoomActive\(\)\) return;/);
    expect(method).toMatch(/for \(const id of \[\.\.\.peerIds\]\.sort\(\)\) this\.#send\(id, capsSignal\(\)\);/);
    for (const forbidden of ["#greeted", "#pending", "#arm", "#disarm", "#announce", "#handle", "#timers"]) {
      expect(method, `refreshPresent touches ${forbidden}, so it does not merely send`)
        .not.toContain(forbidden);
    }
    // Exactly one send statement: "once to each present peer", not a burst.
    const sends = method.match(/this\.#send\(/g) ?? [];
    expect(sends.length, "refreshPresent sends more than once per peer").toBe(1);
  });

  it("leaves the fail-closed link/1 admission exactly as it was", () => {
    // The repair is about re-DELIVERING an announcement, never about relaxing
    // what counts as one. A peer that has not announced this precise version is
    // still unsupported, and an unannounced peer is still never probed.
    expect(caps).toMatch(
      /export function peerSupportsLink\(peerId: string\): boolean \{\n\s*if \(!linkRoomActive\(\)\) return false;\n\s*return \(announced\[peerId\] \?\? \[\]\)\.includes\(CAP_LINK\);\n\}/,
    );
    expect(caps).toMatch(
      /export function advertisedCaps\(\): readonly string\[\] \{\n\s*return linkRoomActive\(\) \? \[CAP_LINK, CAP_PREUPLOAD\] : \[\];\n\}/,
    );
    // And an old or non-announcing peer is unchanged: still pruned per roster,
    // still two-valued, still never inferred from `text/1`.
    expect(caps).toMatch(/export function retainPeers\(ids: string\[\]\): void \{/);
    expect(caps, "refreshPresent must not have grown a default announcement for silent peers")
      .not.toMatch(/announced\[peerId\] \?\? \[CAP_LINK/);
  });
});

/**
 * The announcement-capture handshake in `mixed-link.mjs`.
 *
 * Why a contract lives here at all: the SAS assertion it protects only fails
 * under load, and it fails as a *product* accusation — "this link never
 * announced its code: []" — when what actually happened is that the runner's own
 * `MutationObserver` was still being installed while a real link announced a
 * real code. Codex hit exactly that on 2026-08-29 running this suite beside
 * device-inbox; the exclusive rerun was green in 8.82s. A test-only race that
 * only appears on a busy machine is precisely the kind a later reader deletes
 * as "an unnecessary wait", so removing the handshake has to fail here, cheaply,
 * with no browser and no server.
 *
 * The checks are structural on purpose. `toMatch(/__e2eAnnouncementsReady/)`
 * would pass on a file that declared the flag and never waited for it, and would
 * pass on one that waited *after* opening the link. Ordering is the invariant,
 * so ordering is what is asserted: source-position ordering for the call sites,
 * and real execution of the injected snippet for the flag's own meaning.
 */
describe("mixed-link's live-region observer announces when it is ready", () => {
  const MIXED = "e2e/mixed-link.mjs";

  /** Every index of `needle`, in source order. */
  const indices = (src, needle) => {
    const out = [];
    for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) out.push(i);
    return out;
  };

  /** The injected snippet, taken from the file rather than copied into it. */
  const trackerSource = (src) => {
    const m = src.match(/const TRACK_ANNOUNCEMENTS = `([\s\S]*?)`;\n/);
    expect(m, "mixed-link no longer defines TRACK_ANNOUNCEMENTS as a template literal").not.toBeNull();
    return m[1];
  };

  /**
   * Run that snippet against a fake DOM, and report what happened in what order.
   *
   * `node` environment, so there is no `document` to borrow — which is the point:
   * the fake can withhold the live region, hold the install timer, and record the
   * flag's value *at the moment* `observe()` is called. A jsdom run could not
   * answer that last question at all.
   */
  const runTracker = (source) => {
    const win = {};
    let element = null;
    const timers = [];
    let observed = null;
    let readyAtObserve = "observe was never called";
    const document = {
      querySelector: (sel) => (sel === ".activity-announcement" ? element : null),
    };
    const setTimeout = (fn) => { timers.push(fn); };
    class FakeMutationObserver {
      constructor(cb) { this.cb = cb; }
      observe(target, options) {
        readyAtObserve = win.__e2eAnnouncementsReady;
        observed = { target, options, cb: this.cb };
      }
    }
    // The snippet under test is an injected page script; executing it is the
    // only honest way to test what it does.
    new Function("window", "document", "setTimeout", "MutationObserver", source)(
      win, document, setTimeout, FakeMutationObserver,
    );
    return {
      win,
      get captured() { return win.__e2eAnnouncements; },
      get ready() { return win.__e2eAnnouncementsReady; },
      get pendingTimers() { return timers.length; },
      get readyAtObserve() { return readyAtObserve; },
      get observed() { return observed; },
      /** The live region appears, carrying whatever it currently says. */
      mount: (text) => { element = { textContent: text }; },
      /** What the product does to it afterwards. */
      say: (text) => { element.textContent = text; observed?.cb(); },
      /** Fire the install retry the snippet scheduled. */
      tick: () => { for (const fn of timers.splice(0)) fn(); },
    };
  };

  it("sets its ready flag only after the observer is attached, never before", () => {
    const block = trackerSource(read(MIXED));
    // Declared false up front, so a wait on it cannot pass on `undefined`
    // through some other path, and so its absence is visible rather than silent.
    expect(block).toMatch(/window\.__e2eAnnouncementsReady = false;/);
    const attach = block.indexOf(".observe(");
    const flag = block.indexOf("__e2eAnnouncementsReady = true");
    expect(attach, "the snippet no longer attaches a MutationObserver").toBeGreaterThan(-1);
    expect(flag, "the snippet no longer raises a ready flag").toBeGreaterThan(-1);
    // The whole meaning of the flag. Raising it first would make every wait on
    // it pass while the observer was still not listening — the original bug,
    // reintroduced with the fix's own vocabulary still in place.
    expect(flag, "the ready flag is raised before observe(), so it promises nothing")
      .toBeGreaterThan(attach);
    expect(indices(block, "__e2eAnnouncementsReady = true")).toHaveLength(1);
  });

  it("really withholds that flag until the live region exists, and then captures", () => {
    const t = runTracker(trackerSource(read(MIXED)));
    // The live region is rendered by the app, not by the document: until it
    // mounts, the snippet can only reschedule itself.
    expect(t.captured).toEqual([]);
    expect(t.ready).toBe(false);
    expect(t.pendingTimers, "the snippet stopped retrying its own installation").toBe(1);
    expect(t.observed, "it attached an observer to an element that does not exist").toBeNull();

    // Still not ready: a retry that finds nothing must not raise the flag.
    t.tick();
    expect(t.ready).toBe(false);
    expect(t.pendingTimers).toBe(1);

    t.mount("");
    t.tick();
    expect(t.ready).toBe(true);
    // Recorded from inside the fake `observe`: at that instant the flag was
    // still false. This is the ordering claim, proven at runtime rather than
    // read off the source.
    expect(t.readyAtObserve).toBe(false);
    expect(t.observed.options).toEqual({ childList: true, characterData: true, subtree: true });

    t.say("Link code 1234. Tab A wants to send you a message.");
    t.say("Tab A wants to send you a message.");
    expect(t.captured).toEqual([
      "Link code 1234. Tab A wants to send you a message.",
      "Tab A wants to send you a message.",
    ]);
  });

  it("loses exactly the announcement the flake lost, if the flag is not waited on", () => {
    // The failure this handshake exists for, reproduced in one assertion: a
    // machine busy enough that the first edge's code is announced and REPLACED
    // before the install poll lands. The snippet then captures only what the
    // live region still says — and the code line is gone for good, which is why
    // the run accused the product of never announcing it.
    const t = runTracker(trackerSource(read(MIXED)));
    t.mount("Tab A wants to send you a message."); // the code came and went
    t.tick();
    expect(t.ready).toBe(true);
    expect(t.captured).toEqual(["Tab A wants to send you a message."]);
    expect(t.captured.some((line) => line.includes("1234"))).toBe(false);
  });

  /**
   * Ordering at the call sites, as a state machine over source positions.
   *
   * A mark is a claim that nothing said before it counts. That claim is only
   * true if the observer was already listening when the mark was taken, and the
   * observer's readiness has to be re-established for each link this scenario
   * opens — the second one is where a future edit might reload a page.
   */
  it("waits for that flag before every mark, and marks before opening every link", () => {
    const src = read(MIXED);
    // Scoped to `mixedScenario`'s body, because the handshake is a rule about
    // reading the live region and that is the only scenario that reads it. The
    // scoping is not a loophole: the guard immediately below fails if the
    // multi-page scenario ever starts asserting on announcements, at which point
    // its own link opens have to come back under this state machine.
    const from = src.indexOf("async function mixedScenario(");
    const to = src.indexOf("\n}\n", from);
    expect(from, "mixedScenario is no longer greppable").toBeGreaterThan(-1);
    expect(to, "mixedScenario's body has no closing brace at column 0").toBeGreaterThan(from);
    const inScenario = (i) => i >= from && i < to;

    const waits = indices(src, "await announcementsReady(tab, who);").filter(inScenario);
    const marks = indices(src, "await announcedCount(").filter(inScenario);
    const opens = indices(src, "OPEN_WORKSPACE}').click()").filter(inScenario);
    expect(waits.length, "no readiness wait left in mixed-link").toBeGreaterThanOrEqual(2);
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(opens.length, "mixedScenario no longer opens two links").toBeGreaterThanOrEqual(2);

    // The backstop for the call site someone adds later without a wait: taking a
    // mark is itself guarded, so a missed wait fails as its own sentence instead
    // of resurfacing as "the product never announced its code". Scoped to the
    // mark helper, so the words cannot be satisfied by a comment elsewhere.
    const mark = src.slice(src.indexOf("const announcedCount ="), src.indexOf("const announcedSince ="));
    expect(mark).toContain("${ANNOUNCEMENTS_READY}");
    expect(mark).toContain("announcement mark taken before the live-region observer was installed");

    const tagged = [
      ...waits.map((i) => [i, "ready"]),
      ...marks.map((i) => [i, "mark"]),
      ...opens.map((i) => [i, "open"]),
    ].sort((x, y) => x[0] - y[0]);

    let ready = false;
    let marked = false;
    for (const [at, tag] of tagged) {
      const where = `${MIXED} line ${src.slice(0, at).split("\n").length}`;
      if (tag === "ready") { ready = true; continue; }
      if (tag === "mark") {
        expect(ready, `${where}: an announcement mark taken before any readiness wait`).toBe(true);
        marked = true;
        continue;
      }
      expect(ready, `${where}: a link opened without a readiness wait before its mark`).toBe(true);
      expect(marked, `${where}: a link opened with no announcement mark taken first`).toBe(true);
      // A new link needs its own handshake: the flag proven for the previous one
      // says nothing about a page this scenario may later reload.
      ready = false;
      marked = false;
    }
  });

  it("justifies that scoping: no other scenario reads announcements", () => {
    // The paired half of the scoping above. Restricting the state machine to
    // `mixedScenario` is only honest while every other scenario genuinely has no
    // announcement machinery in it; the moment one appears, its link opens are
    // subject to the same handshake and this fails until the scoping is widened.
    const src = read(MIXED);
    for (const fn of ["multiPageDeviceScenario", "relayFailureScenario", "unsupportedPeerScenario"]) {
      const from = src.indexOf(`async function ${fn}(`);
      const to = src.indexOf("\n}\n", from);
      expect(from, `${fn} is no longer greppable`).toBeGreaterThan(-1);
      expect(to).toBeGreaterThan(from);
      const body = src.slice(from, to);
      for (const helper of ["announcementsReady", "announcedCount", "announcedSince", "TRACK_ANNOUNCEMENTS"]) {
        expect(body, `${helper} is used in ${fn}, outside the state machine that orders it`)
          .not.toContain(helper);
      }
    }
  });

  it("still makes the product prove it announced the code", () => {
    // The cheapest "fix" for a flaky assertion is to delete it. These are the
    // two assertions the handshake was added to keep honest, so they are named.
    const src = read(MIXED);
    expect(src).toMatch(/spoken\.some\(\(line\) => line\.includes\(sasA\)\)/);
    expect(src).toMatch(/this link never announced its code on \$\{consent\.who\}/);
    expect(src).toMatch(/freshSpoken\.some\(\(line\) => line\.includes\(sas2\)\)/);
    // And it must still be doing it without buying time: a sleep here would hide
    // the same race instead of removing it.
    expect(src).not.toMatch(/await sleep\([^)]*\);\s*const (first|relink)/);
  });
});
