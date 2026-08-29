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
