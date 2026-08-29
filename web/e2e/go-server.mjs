/**
 * One real Relayium server, built from `./server`, owned by one test run.
 *
 * Extracted from `device-inbox.mjs`, which had the only hardened copy. The
 * second consumer is `mixed-link.mjs`, which previously required a human to
 * have started a server by hand on :8098 — so it ran when somebody remembered
 * to run it, and its failures were as likely to mean "you are pointing at a
 * stale dist" as "the product regressed". Both of those are lifecycle problems,
 * not scenario problems, which is why they are solved once, here.
 *
 * What a caller gets, and what each guard is actually preventing:
 *
 *   - **A built `dist/index.html`, and not an old one.** The server serves
 *     `RELAYIUM_STATIC` verbatim. A missing dist gives a 404 storm that reads
 *     like a routing bug; a *stale* dist is worse, because every page loads and
 *     the run fails somewhere deep inside a scenario against code the checkout
 *     no longer contains. Both are refused before anything spawns.
 *   - **A port this run owns.** It must be a real port first — an integer in
 *     1-65535, decided by arithmetic before any filesystem or socket work. Node
 *     fails the two ways a port goes missing differently, and neither used to
 *     say so: `listen(undefined)` binds an arbitrary free port, so a
 *     programmatic `startGoServer({ port: undefined })` passed this very check
 *     and paid a full Go build before the child died on
 *     `RELAYIUM_ADDR=127.0.0.1:undefined`, while `listen(NaN)` — what a runner's
 *     `Number()` made of a `--port` with nothing after it — threw a bare
 *     `RangeError` out of the socket probe, naming neither the flag nor the
 *     suite. Then, if something already answers there, this module refuses
 *     rather than adopting it. A borrowed server has a different database, a
 *     different dist and possibly a developer's real configuration; a green run
 *     against it proves nothing. Target one deliberately with the runner's own
 *     `--url`.
 *   - **No inherited `RELAYIUM_*` configuration.** Every such variable is
 *     stripped from the child's environment and replaced with test-owned
 *     values — deny-by-default rather than a hand-maintained list of the
 *     dangerous ones, because that list is exactly what goes stale when the
 *     server gains a new provider credential.
 *   - **A wall-clock readiness deadline, and early death reported as early
 *     death.** A child that exits during boot must not be waited on until a
 *     timeout: the timeout names the wrong cause. The captured log path is in
 *     both messages.
 *   - **Termination that actually terminates**, including on the runner's
 *     watchdog `process.exit`, where no `finally` runs.
 *
 * Every export below is used by `startGoServer`; they are exported separately
 * because each is a distinct failure mode with its own test in
 * `go-server.test.mjs`, and a lifecycle whose parts can only be exercised by
 * building Go and launching Chrome is a lifecycle nobody tests.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
/** `web/`. */
export const WEB_DIR = resolve(here, "..");
/** The Go module this builds. */
export const SERVER_DIR = resolve(here, "../../server");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the built static bundle ───────────────────────────────────────────────

/**
 * The inputs whose edits invalidate `dist/index.html`.
 *
 * Deliberately the SPA's own sources and build configuration, not `public/`:
 * `npm run build` regenerates `public/` from `scripts/gen-pages.mjs` *before*
 * Vite writes `dist`, so those files are always older than a fresh build, while
 * the thing these suites actually exercise — the app bundle — comes from `src`.
 * Widening this list would buy no signal and would start reporting a stale dist
 * for edits that cannot change one.
 */
export const STATIC_SOURCES = [
  "src",
  "index.html",
  "vite.config.ts",
  "vite-plugin-pwa.ts",
  "vite-plugin-route-shells.ts",
];

/** Newest mtime under `paths` (files and directories), or null if none exist. */
export function newestSource(paths, { root = WEB_DIR } = {}) {
  let newest = null;
  const visit = (rel) => {
    const abs = join(root, rel);
    let st;
    try { st = statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      // `node_modules` anywhere under a source root is never an input. Vitest
      // has landed a multi-megabyte cache in `src/node_modules` before now, and
      // walking it would make this guard both slow and wrong.
      if (rel.endsWith("node_modules")) return;
      for (const entry of readdirSync(abs)) visit(join(rel, entry));
      return;
    }
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: rel, mtimeMs: st.mtimeMs };
  };
  for (const p of paths) visit(p);
  return newest;
}

/**
 * Refuse a missing or stale `<staticDir>/index.html`.
 *
 * `requireFresh` exists for a caller that deliberately serves a bundle it did
 * not just build; no runner in this repository passes it, and no environment
 * variable turns the check off — an escape hatch here would be an escape hatch
 * from the single most misleading failure this module exists to prevent.
 */
export function assertStaticBuild(staticDir, { root = WEB_DIR, sources = STATIC_SOURCES, requireFresh = true } = {}) {
  const index = join(staticDir, "index.html");
  let built;
  try { built = statSync(index); } catch {
    throw new Error(
      `no built bundle at ${index} — run \`npm run build\` in web/ first ` +
      "(this server serves that directory verbatim; without it every page 404s)",
    );
  }
  if (!requireFresh) return;
  const newest = newestSource(sources, { root });
  if (newest && newest.mtimeMs > built.mtimeMs) {
    throw new Error(
      `${index} is older than web/${newest.path} — the bundle under test is stale.\n` +
      `      built  ${new Date(built.mtimeMs).toISOString()}\n` +
      `      source ${new Date(newest.mtimeMs).toISOString()}\n` +
      "      Run `npm run build` in web/. Serving a stale bundle fails deep inside a " +
      "scenario, against code this checkout no longer contains.",
    );
  }
}

// ── the port ──────────────────────────────────────────────────────────────

/** The only values a TCP listener can be asked for by name. `0` is excluded
 *  deliberately: to `listen` it means "any free port", which is the opposite of
 *  what a runner asking for a specific one wants. */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

const show = (value) => (typeof value === "string" ? JSON.stringify(value) : String(value));

/**
 * Normalize a requested port, or refuse it by name and range.
 *
 * This is the first guard in `startGoServer` because every alternative is both
 * later and less honest — and because Node splits this failure in two.
 * `listen(undefined)` binds an arbitrary free port, so `assertPortFree(undefined)`
 * reported success and a programmatic `startGoServer({ port: undefined })` paid a
 * full `go build` before handing the child `RELAYIUM_ADDR=127.0.0.1:undefined` and
 * watching it die — a minutes-late failure whose message pointed at the server
 * rather than at the value nobody supplied. `listen(NaN)` throws a `RangeError`
 * synchronously instead: cheap, but anonymous — it names neither the caller nor
 * the flag. One check in front of both turns either into a line that quotes what
 * it was given. A string is accepted and converted because argv only ever carries
 * strings; everything else is deliberately strict, because "nearly a port" —
 * `""`, `"--keep"`, `8124.5` — is what callers actually pass.
 */
export function assertValidPort(value, { what = "the server port" } = {}) {
  const port = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`${what} must be an integer in ${MIN_PORT}-${MAX_PORT} — got ${show(value)}`);
  }
  return port;
}

/**
 * `--port 8124` out of a runner's argv, or `dflt` when the flag is absent.
 *
 * Absent and present-but-broken are deliberately different outcomes: no flag
 * means the documented default, while `--port` with nothing after it, or with
 * the *next switch* after it, is a typo whose whole cost should be one line of
 * output. Those two cases are `undefined` and `"--keep"`. A runner that wrote
 * `Number(argFlag("--port", …))` turned the first into `NaN`, which reached the
 * socket probe and came back as a bare `RangeError` naming neither the flag nor
 * the suite; this refuses under the flag's own name instead.
 */
export function portFromArgv(argv, { flag = "--port", dflt } = {}) {
  const i = argv.indexOf(flag);
  return assertValidPort(i < 0 ? dflt : argv[i + 1], { what: flag });
}

/**
 * Refuse to adopt a listener this run did not start.
 *
 * Binding is the check rather than an HTTP probe: a probe only sees things that
 * speak HTTP and answer quickly, and "nothing answered /healthz in 200ms" is
 * indistinguishable from "a server is booting". A bind either succeeds or names
 * the collision. The HTTP probe still runs, but only to make the message say
 * *what* is there.
 */
export async function assertPortFree(port, { host = "127.0.0.1" } = {}) {
  // Before the socket, not after it. `listen(undefined)` succeeds on a port
  // nobody asked for — which is how a caller that passed no port at all used to
  // read as "that port is free" — and `listen(NaN)` throws a `RangeError` that
  // names neither the runner nor the flag.
  const target = assertValidPort(port);
  const inUse = await new Promise((res, rej) => {
    const probe = createServer();
    probe.once("error", (err) => {
      if (err.code === "EADDRINUSE" || err.code === "EACCES") res(err.code);
      else rej(err);
    });
    probe.listen(target, host, () => probe.close(() => res(null)));
  });
  if (!inUse) return;

  const answered = await fetch(`http://${host}:${target}/healthz`, { signal: AbortSignal.timeout(1_500) })
    .then((r) => r.text()).catch(() => "");
  const who = answered.trim() === "ok"
    ? "something is already answering /healthz there"
    : `${host}:${target} is already bound (${inUse})`;
  throw new Error(
    `${who} — this runner will not adopt a server it did not start. That server has its own ` +
    "database, its own bundle and possibly your real configuration, so a green run against it " +
    "proves nothing. Stop it, or target it deliberately with --url.",
  );
}

// ── the environment ───────────────────────────────────────────────────────

/**
 * The child's environment: everything inherited EXCEPT `RELAYIUM_*`, then this
 * run's own values, then the caller's overrides.
 *
 * The strip is total and that is the point. Listing the dangerous variables —
 * Stripe keys, the TURN secret, the fleet node token, SMTP credentials, the
 * developer's `RELAYIUM_ENV_FILE` — means maintaining that list forever, and
 * the failure mode of forgetting an entry is a test run reaching a real
 * provider with a real credential. Deny by default; the four keys a suite
 * genuinely needs are cheap to pass explicitly.
 *
 * `RELAYIUM_ENV_FILE` is pointed at a path inside the temporary root that does
 * not exist: unset would let the server fall back to its own default lookup and
 * pick up a checkout's `.env`.
 */
export function serverEnv({ port, root, staticDir, baseUrl, env = {}, parentEnv = process.env }) {
  const inherited = Object.fromEntries(
    Object.entries(parentEnv).filter(([key]) => !key.startsWith("RELAYIUM_")),
  );
  return {
    ...inherited,
    RELAYIUM_ADDR: `127.0.0.1:${port}`,
    RELAYIUM_BASE_URL: baseUrl ?? `http://127.0.0.1:${port}`,
    RELAYIUM_DB: join(root, "relayium.db"),
    RELAYIUM_BLOB_DIR: join(root, "blobs"),
    RELAYIUM_STATIC: staticDir,
    RELAYIUM_ENV_FILE: join(root, "no-such.env"),
    // No outbound release check from a test process.
    RELAYIUM_RELEASE_CHECK: "0",
    ...env,
  };
}

// ── readiness ─────────────────────────────────────────────────────────────

/**
 * Poll `/healthz` until it says `ok`, the child dies, or the budget is spent.
 *
 * `exited()` returns a description string once the child is gone, and it is
 * checked FIRST on every pass. A server that fails to bind its port exits in
 * well under a second; waiting the full readiness budget for it and then
 * reporting a timeout hides the one line of its log that says why.
 */
export async function awaitHealthy({
  base, timeoutMs = 60_000, pollMs = 200, exited = () => null, logPath = "", label = "the Go server",
}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dead = exited();
    if (dead) throw new Error(`${label} ${dead} before answering ${base}/healthz — captured log: ${logPath}`);
    const body = await fetch(`${base}/healthz`).then((r) => r.text()).catch(() => "");
    if (body.trim() === "ok") return;
    if (Date.now() >= deadline) {
      throw new Error(`${label} never answered ${base}/healthz within ${timeoutMs}ms — captured log: ${logPath}`);
    }
    await sleep(pollMs);
  }
}

// ── termination ───────────────────────────────────────────────────────────

/**
 * SIGTERM, then SIGKILL after a bounded grace. Idempotent and safe on a child
 * that has already exited.
 *
 * Sending a signal and returning is not enough: an un-awaited child handle
 * keeps Node's event loop alive, so the script "finishes" without the command
 * ever returning — indistinguishable from a hang in CI. And a SIGTERM a child
 * chooses to ignore has to escalate, or the grace becomes the hang.
 */
export async function terminate(child, { graceMs = 3_000 } = {}) {
  if (!child) return;
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (!alive()) return;
  const exited = new Promise((res) => child.once("exit", res));
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  let timer;
  await Promise.race([exited, new Promise((res) => { timer = setTimeout(res, graceMs); })]);
  clearTimeout(timer);
  if (alive()) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    await exited;
  }
}

// ── the build ─────────────────────────────────────────────────────────────

function goBuild(out, pkg) {
  const r = spawnSync("go", ["build", "-o", out, pkg], {
    cwd: SERVER_DIR, encoding: "utf8", timeout: 600_000,
  });
  if (r.error) throw new Error(`go build ${pkg} could not start: ${r.error.message} (is the Go toolchain installed?)`);
  if (r.status !== 0) {
    throw new Error(`go build ${pkg} failed (${r.status})\n${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  }
}

// ── the lifecycle ─────────────────────────────────────────────────────────

/**
 * Build and start a Relayium server for one test run.
 *
 * `root` is the temporary directory holding the database, the blob store and
 * the captured log. Pass one to share it with the rest of a suite's scratch
 * space (Device Inbox keeps its CLI config and receive directory in the same
 * tree and removes it itself); omit it and this module makes and removes its
 * own.
 *
 * Returns `{ base, port, root, binaries, logPath, log(), stop() }`. `stop()` is
 * idempotent; it writes the captured log to `logPath` before terminating, so
 * the log survives a failed run.
 */
export async function startGoServer({
  port,
  root: callerRoot,
  staticDir = join(WEB_DIR, "dist"),
  requireFreshStatic = true,
  env = {},
  /** Extra binaries to build from the same module, e.g. the CLI. */
  extraBinaries = [],
  readyTimeoutMs = 60_000,
  graceMs = 3_000,
  keep = false,
  label = "the Go server",
  report = () => {},
} = {}) {
  // All three guards run before anything is built, spawned or written: they are
  // the failures that otherwise cost a full build and then lie about the cause.
  // The order is cheapest-and-most-certain first — a malformed port is decided
  // by arithmetic, so it must not wait behind a filesystem walk or a socket.
  const boundPort = assertValidPort(port);
  assertStaticBuild(staticDir, { requireFresh: requireFreshStatic });
  await assertPortFree(boundPort);

  const ownsRoot = !callerRoot;
  const root = callerRoot ?? mkdtempSync(join(tmpdir(), "relayium-go-server-"));
  const removeRoot = () => {
    if (!ownsRoot || keep) return;
    try { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* a temp directory left behind is harmless */ }
  };

  let child = null;
  let onProcessExit = null;
  // Declared out here because the failure path needs them. `awaitHealthy` names
  // `logPath` in both of its messages, so the failure path must flush it — and
  // must ALSO print the tail, because that path then removes the temporary root
  // the file lives in. A message naming a file nobody wrote, or one that was
  // deleted a millisecond later, is worse than no message.
  let writeLog = () => {};
  let logTail = () => "";
  let logPath = "";
  try {
    mkdirSync(join(root, "blobs"), { recursive: true });
    const bin = join(root, "relayium-server");
    goBuild(bin, ".");
    const binaries = {};
    for (const extra of extraBinaries) {
      binaries[extra.name] = join(root, extra.name);
      goBuild(binaries[extra.name], extra.pkg);
    }
    report(`built the server${extraBinaries.length ? ` and ${extraBinaries.map((e) => e.name).join(", ")}` : ""} from source`);

    const base = `http://127.0.0.1:${boundPort}`;
    logPath = join(root, "server.log");
    const logs = [];
    child = spawn(bin, [], {
      cwd: root,
      env: serverEnv({ port: boundPort, root, staticDir, baseUrl: base, env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const capture = (chunk) => {
      logs.push(String(chunk));
      // Bounded: a server that fails in a loop must not turn a captured log
      // into unbounded memory. The tail is the part that says why.
      if (logs.length > 400) logs.shift();
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const log = () => logs.join("");
    writeLog = () => { try { writeFileSync(logPath, log()); } catch { /* best effort */ } };
    logTail = () => log().split("\n").slice(-40).join("\n").trim();

    // The runners wrap themselves in `withWatchdog`, which calls process.exit()
    // on a hard timeout — no `finally` runs on that path. This hook is the only
    // thing standing between a hung run and an orphaned server holding the port
    // for every later run on the machine. Handlers must be synchronous.
    onProcessExit = () => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      removeRoot();
    };
    process.on("exit", onProcessExit);

    await awaitHealthy({
      base,
      timeoutMs: readyTimeoutMs,
      logPath,
      label,
      exited: () => (child.exitCode !== null || child.signalCode !== null
        ? `exited (${child.signalCode ?? `code ${child.exitCode}`})`
        : null),
    });
    report(`server up on ${base}`);

    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      if (onProcessExit) process.off("exit", onProcessExit);
      writeLog();
      await terminate(child, { graceMs });
      removeRoot();
      if (ownsRoot && keep) console.log(`  kept: ${root}`);
    };
    return { base, port: boundPort, root, binaries, logPath, log, stop };
  } catch (err) {
    // A partially started server must not survive the error that stopped it:
    // it would hold the port, and the NEXT run would fail with a collision that
    // points at nothing.
    if (onProcessExit) process.off("exit", onProcessExit);
    writeLog();
    await terminate(child, { graceMs });
    // Print the tail BEFORE the root goes: the thrown error names `logPath`, and
    // on this path that file is inside the directory about to be removed.
    const tail = logTail();
    if (tail) console.error(`\n  ── captured ${label} log (${logPath}) ──\n${tail}\n  ──\n`);
    // `removeRoot` honours `keep`, which is exactly when the full log is worth
    // keeping on disk — so say where it is.
    removeRoot();
    if (keep && ownsRoot) console.log(`  kept: ${root}`);
    throw err;
  }
}
