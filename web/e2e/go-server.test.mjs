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
 * `mixed-link.mjs`'s own inventory: one scenario, twenty acts.
 *
 * `page-shell-contract.test.mjs` guards its runner from silently dropping a
 * scenario, and the same failure exists here one level down and is worse. That
 * suite has four scenarios, so counting them is a real check. This one has a
 * single `mixedScenario` that performs twenty distinct acts against one live
 * link — so `1/1` would be reported by a run that had been edited down to its
 * first assertion, and by a run whose 5 MiB resume act quietly stopped
 * executing. The literal that actually protects it is the ACT count.
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

  it("declares exactly those acts, in that order, as one frozen literal", () => {
    const match = src.match(/const ACTS = Object\.freeze\(\[([^\]]*)\]\);/);
    expect(match, "ACTS is no longer a frozen array literal").not.toBeNull();
    const listed = match[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
    expect(listed).toEqual(ACT_NAMES);
  });

  it("records every one of them from an act() call, exactly once", () => {
    for (const name of ACT_NAMES) {
      const calls = src.match(new RegExp(`\\bact\\("${name}"`, "g")) ?? [];
      expect(calls, `${name} is declared but never recorded by an act() call`).toHaveLength(1);
    }
    // And nothing records an act the frozen list does not name: `act()` throws
    // on an unknown name at runtime, but a run that never reaches it would not
    // find out, and this is free.
    const recorded = [...src.matchAll(/\bact\("([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect(recorded).toEqual(ACT_NAMES);
  });

  it("checks both counts against fixed literals, not against array lengths", () => {
    expect(src).toMatch(/const EXPECTED_SCENARIO_COUNT = 1;/);
    expect(src).toMatch(/const EXPECTED_ACT_COUNT = 20;/);
    expect(src).toMatch(/ran !== EXPECTED_SCENARIO_COUNT/);
    expect(src).toMatch(/ledger\.length !== EXPECTED_ACT_COUNT/);
    // The comparisons this guard exists to forbid: an array and its own length
    // still agree after somebody deletes an entry from it, so either of these
    // would report a clean run over a shrunken inventory.
    expect(src, "the scenario check fell back to the mutable array length").not.toMatch(
      /ran !== SCENARIOS\.length/,
    );
    expect(src, "the act check fell back to the mutable array length").not.toMatch(
      /ledger\.length !== ACTS\.length/,
    );
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

  it("runs the inventory rather than calling the scenario directly", () => {
    // `await mixedScenario(...)` straight from main() — which is what this file
    // did before C3b-1 — bypasses both counts entirely, so the check is not
    // "runScenarios exists" but "nothing calls the scenario around it".
    expect(src).toMatch(/await runScenarios\(session\.browser, base\);/);
    expect(src).toMatch(/const SCENARIOS = \[mixedScenario\];/);
    expect(src, "main() calls the scenario directly, around the inventory")
      .not.toMatch(/await mixedScenario\(/);
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
    const waits = indices(src, "await announcementsReady(tab, who);");
    const marks = indices(src, "await announcedCount(");
    const opens = indices(src, "OPEN_WORKSPACE}').click()");
    expect(waits.length, "no readiness wait left in mixed-link").toBeGreaterThanOrEqual(2);
    expect(marks.length).toBeGreaterThanOrEqual(2);
    expect(opens.length, "mixed-link no longer opens two links").toBeGreaterThanOrEqual(2);

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
