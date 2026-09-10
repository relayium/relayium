// Windows realtime interoperability: the REAL Electron client and a REAL
// browser, in one pairing room, over a real server and real WebRTC.
//
//   npm run build   (apps/windows)   # the client this drives
//   npm run build   (web)            # the bundle the browser loads
//   node test/smoke/realtime-pairing-acceptance.mjs
//
// ## The cell this fills
//
// `native-web-pairing-acceptance.sh` puts the macOS app and a browser in one
// room. This is the WINDOWS-RUNNER-HOSTED equivalent, and the distinction is
// the point of it: prior interop evidence for this client was produced on a Mac
// host, where the Electron client runs but the real Windows destination — the
// lease, the `winpath` guards and the native helper — cannot exist, and where
// every destination assertion is answered by this fixture's portable provider
// instead (see `hostProvider`). What has never run on a Windows runner is the
// Windows client in a room with a second real peer, against the real
// destination. That is the cell this fills; it is not the first interop of any
// kind, and the accepted macOS 1.3.10 interop is not superseded by it.
//
// Both peers are real products:
//
//   * a real Relayium server built from `server/`, on an ephemeral loopback
//     port, serving the real built Web bundle;
//   * a real pairing code, minted through the product's own `POST /api/pair`
//     by a synthetic account this run creates through the real HTTP API;
//   * the Windows client's own renderer and `RoomController`, driven through the
//     shipped UI in a real Electron (`realtime-peer-main.mjs`);
//   * a real headless Chrome on the real bundle, spawned and OWNED by THIS
//     process and driven over CDP through `realtime-browser-peer.mjs`, which
//     reuses the shared harness's primitives read-only;
//   * real WebRTC between them, on host candidates.
//
// ## What it proves, and what it does NOT
//
// It proves HOST INTEGRATION: that the Windows client joins a real room, agrees
// one workspace and one SAS with a different client, moves real bytes both ways,
// lands them on the real Windows destination, and tears down cleanly — in both
// code roles and both link roles.
//
// It is NOT a second protocol implementation agreeing with the first. The
// Windows renderer imports the same shipping `web/src/lib` modules the browser
// runs (`renderer/rooms/room-controller.ts:19-28`). Only the macOS Swift peer
// supplies an independent implementation, and only a macOS runner can host it.
// It is also not NAT, not TURN, not a real device, and not a race detector.
//
// ## No 65-second pacing, and why that is not a relaxed limit
//
// `wsJoinPerIPPerMinute` is 5 (`server/wsroute.go:36`) and one round spends two
// joins from one loopback address, so the macOS script sleeps 65 s between
// rounds against ONE long-lived server. That limiter is built in `main()`
// (`server/main.go:617`) and lives in that process. So this run builds the
// binary once and gives every round its OWN server process, port, database, blob
// directory and account. No constant, threshold or flag is relaxed — each round
// is simply a new instance, the same isolation rule the temp roots already
// follow.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { resolveChrome } from "../../../../web/e2e/harness.mjs";
import { closeOwnedBrowser, connectToOwnedBrowser, driveBrowserPeer } from "./realtime-browser-peer.mjs";
import { buildServerForFixture, testDiskUsageWithOverlay } from "./server-platform.mjs";

const WINDOWS = process.platform === "win32";
const APP = fileURLToPath(new URL("../..", import.meta.url));
const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const SERVER_SRC = join(REPO, "server");
const WEB_DIST = join(REPO, "web", "dist");
const PEER_MAIN = fileURLToPath(new URL("./realtime-peer-main.mjs", import.meta.url));
const GO = WINDOWS ? "go.exe" : "go";
const SERVER_BIN = WINDOWS ? "relayium-server.exe" : "relayium-server";
/** The test-only Windows Job Object guardian. Its own module, pinned to the
 *  same Go and `x/sys` the production native module already uses. */
const GUARDIAN_SRC = fileURLToPath(new URL("../native/owned-process", import.meta.url));
const GUARDIAN_BIN = WINDOWS ? "owned-process-guardian.exe" : "owned-process-guardian";

/** `CHUNK_SIZE` in the link protocol, asserted at
 *  `web/src/lib/link-protocol-vectors.test.ts:562`. The file this run sends
 *  crosses it by exactly one byte. */
const CHUNK_SIZE = 192 * 1024;

const RUN_BUDGET_MS = 25 * 60 * 1000;
const BUILD_BUDGET_MS = 8 * 60 * 1000;
const OP_BUDGET_MS = 60 * 1000;
const START_BUDGET_MS = 60 * 1000;
const ROUND_BUDGET_MS = 4 * 60 * 1000;
const JOIN_BUDGET_MS = 90 * 1000;
const TRANSFER_BUDGET_MS = 120 * 1000;
const CLOSE_BUDGET_MS = 4 * 1000;
const BODY_BUDGET_BYTES = 64 * 1024 * 1024;
const LOG_BUDGET_BYTES = 8 * 1024 * 1024;
/** Bounded, and overridable downwards for a diagnostic run. Role coverage is
 *  never waived by it: fewer rounds can only make the role assertion FAIL. */
const MAX_ROUNDS = Math.max(1, Math.min(8, Number(process.env.RT_ROUNDS ?? 8)));

/**
 * Adversarial controls. Each one must make a run FAIL that would otherwise pass,
 * and each is the counterpart of a healthy positive every green round already
 * performs. They exist because "the browser was joined" and "the browser was
 * never checked" look identical in a passing log.
 *
 * ## The selectors are NOT all the same variable
 *
 * Three of these are chosen with `RT_CONTROL`; `noKill` is chosen with
 * `INTEROP_CONTROL`, because it is read by `stopChildren` rather than by the
 * round. This block used to list all four together under one heading, which is
 * how a `noKill` run comes to be launched as `RT_CONTROL=noKill` — selecting
 * NOTHING, passing, and being recorded as a negative control that was never
 * actually exercised. Both variables are now reported in the summary so a run
 * states which control it really ran.
 *
 *   RT_CONTROL=peerExit       the Electron peer dies immediately after its
 *                             ledger is taken
 *   RT_CONTROL=badCdp         the browser is driven at a port nothing listens on
 *   RT_CONTROL=removeFails    the temp-root removal fails: the finding must
 *                             reach the exit code
 *   INTEROP_CONTROL=noKill    termination is skipped: the child must be reported
 *                             UNJOINED, its ledger retained, and its cleanup
 *                             handed to root by path
 *
 * `noKill` deliberately leaves processes alive. It prints every owned pid and
 * profile path so ROOT can dispose of exactly those and nothing else — there is
 * no prefix sweep here and never will be.
 */
const CONTROL = process.env.RT_CONTROL ?? "";
/** Read by `stopChildren`. Reported so a run is self-identifying. */
const KILL_CONTROL = process.env.INTEROP_CONTROL ?? "";

const steps = [];
const cleanupFindings = [];
const skipped = [];
let failures = 0;

const step = (name, ok, detail = "") => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!ok) failures += 1;
};

/**
 * A check this host cannot make, recorded as NOT MADE.
 *
 * Never counted as a pass. Every skip here is paired with a positive control
 * below, so "the check did not run" and "the check ran and passed" cannot be
 * confused for one another in the report.
 */
const skip = (name, why) => {
  skipped.push({ name, why });
  console.log(`SKIP ${name} :: ${why}`);
};

const runDeadline = new AbortController();
const runTimer = setTimeout(() => runDeadline.abort(), RUN_BUDGET_MS);
const opSignal = (ms = OP_BUDGET_MS) => AbortSignal.any([runDeadline.signal, AbortSignal.timeout(ms)]);

/** This run's own temp root, reported so a log names the run that produced it.
 *  Two concurrent runs writing one log path is not something a log can detect;
 *  a root recorded IN the report is what makes provenance checkable after. */
let taskRoot = null;

const children = [];
/** Every browser this run started, recorded BEFORE the first await on it. */
const ledgers = [];
/** How this run's server binary was produced. Reported, never inferred. */
let serverProvenance = null;

/** Track a child and subscribe to `close` AT SPAWN, so a fast exit is not raced. */
function track(child, label) {
  let exited = false;
  const closed = new Promise((resolve) => {
    child.once("close", (code) => { exited = true; resolve(`closed(${code})`); });
    child.once("error", () => { if (child.pid === undefined) { exited = true; resolve("never-spawned"); } });
  });
  const entry = { child, label, closed, get exited() { return exited; } };
  children.push(entry);
  return entry;
}

async function raceClose(closed, ms) {
  let timer;
  try {
    return await Promise.race([closed, new Promise((r) => { timer = setTimeout(() => r("pending"), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kill the children this run owns and WAIT for each to be OBSERVED closed.
 *
 * By handle, never by name, never by pattern, never as a tree. On Windows
 * `kill()` is `TerminateProcess` whatever signal is named, so the escalation
 * collapses to one forced termination; the observed `close` is what is reported
 * either way. A child that did not close is a finding, and its round root is
 * retained rather than removed under a live process.
 */
async function stopChildren(only = null) {
  const skipKill = process.env.INTEROP_CONTROL === "noKill";
  const outcomes = [];
  let clean = true;
  for (const entry of children) {
    if (only && !only.includes(entry)) continue;
    if (entry.reaped) continue;
    try { if (!skipKill) entry.child.kill("SIGTERM"); } catch { /* already gone */ }
    let state = await raceClose(entry.closed, CLOSE_BUDGET_MS);
    if (state === "pending") {
      try { if (!skipKill) entry.child.kill("SIGKILL"); } catch { /* already gone */ }
      state = await raceClose(entry.closed, CLOSE_BUDGET_MS);
    }
    if (state === "pending") {
      entry.child.unref?.();
      cleanupFindings.push(`${entry.label} (pid ${entry.child.pid ?? "-"}) did not close`);
      clean = false;
    }
    entry.reaped = true;
    outcomes.push(`${entry.label}(pid ${entry.child.pid ?? "-"}):${state}`);
  }
  if (outcomes.length > 0) console.log(`-- children joined: ${outcomes.join(", ")}`);
  if (!clean) {
    // Exactly what root must dispose of, by pid and by path. Never a pattern,
    // never a prefix, never a sweep of anything this run did not start.
    console.log(`-- ROOT-OWNED CLEANUP REQUIRED, exact children only: ${JSON.stringify(
      children.filter((e) => !e.child.killed || e.reaped === undefined)
        .map((e) => ({ label: e.label, pid: e.child.pid ?? null })))}`);
    console.log(`-- ROOT-OWNED CLEANUP REQUIRED, exact browser ledgers: ${JSON.stringify(ledgers)}`);
  }
  return clean;
}

/**
 * End ONE process this run created, named by its exact pid.
 *
 * No pattern, no prefix, no "processes that look like ours", and no tree walk.
 * Where this run holds the `ChildProcess` it uses that handle; where the
 * guardian started the process, it opens the exact pid the guardian published
 * and ends that. The descendants are not touched here at all — accounting for
 * them is the job object's, and whether they actually went is what the
 * guardian's census afterwards reports.
 */
async function killExactly({ pid, entry, label }) {
  if (entry) {
    try { entry.child.kill("SIGKILL"); } catch { /* already gone */ }
    return;
  }
  if (!pid) {
    cleanupFindings.push(`${label} could not be ended: no pid was ever published for it`);
    return;
  }
  // `process.kill` on Windows is `TerminateProcess` against that one pid. It is
  // used deliberately: this control's whole subject is that ending the PARENT
  // alone must not leave a tree behind.
  try {
    process.kill(pid, "SIGKILL");
  } catch (err) {
    if (err?.code !== "ESRCH") {
      cleanupFindings.push(`${label} (pid ${pid}) could not be ended: ${String(err?.message ?? err)}`);
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** The same deterministic filler the peer builds in the page. */
const filled = (n, seed) => {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

/** The child's environment: the host's, minus anything that reconfigures the
 *  server behind its flags. Same rule as `web/e2e/go-server.mjs` and the
 *  accepted Inbox run — deny by default, because the list of dangerous
 *  variables is exactly what goes stale. */
function sanitized(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^RELAYIUM_/i.test(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

async function collectBounded(body, label, limit = BODY_BUDGET_BYTES) {
  if (!body) return Buffer.alloc(0);
  const parts = [];
  let total = 0;
  for await (const part of body) {
    const buf = Buffer.from(part);
    total += buf.length;
    if (total > limit) throw new Error(`${label} exceeded the ${limit}-byte body budget`);
    parts.push(buf);
  }
  return Buffer.concat(parts);
}

async function readTail(path, limit) {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Number(size > limit ? limit : size);
    if (length === 0) return "";
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, Number(size) - length);
    return buf.toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Read a child's own JSON observations, or an explanation of why there are none. */
async function readObservation(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    return { __missing: `${label} wrote no observations: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// One round: one server, one account, one code, two real peers
// ---------------------------------------------------------------------------

/**
 * What each round sends browser -> Windows.
 *
 * The name and the body are the only two dimensions the reused browser half
 * exposes, and both are used deliberately. The BODY is limited by the command
 * line, which is why the chunk-boundary case travels the other way.
 */
/**
 * Build the Windows Job Object guardian, on Windows.
 *
 * ## Why Chrome needs one here at all
 *
 * `cdp(...).close()` is `ws.close()` (`harness.mjs:210`) and leaves the browser
 * running. `ChildProcess.kill` on Windows is `TerminateProcess` against the
 * PARENT, and Chrome is a process TREE — renderer, GPU, network and storage
 * children, each its own process — so the parent's `close` event says nothing
 * about any of them. Enumerating them is not an option either: by name, by
 * profile prefix or by PID adjacency is guessing, and guessing is how this
 * fixture family already killed three browsers it could not attribute
 * (`INCIDENT-chrome-kills.md`).
 *
 * A job object accounts for the tree WITHOUT enumerating it. The guardian
 * creates one, starts Chrome suspended INSIDE it, and holds the handle; its
 * census is the only reading here that can support a whole-tree claim.
 *
 * Returns `{ ok: false, why }` rather than throwing: a guardian that will not
 * build is a SETUP failure with a name, not an exception with a stack.
 */
async function buildGuardian(taskRoot) {
  const out = join(taskRoot, GUARDIAN_BIN);
  const build = track(spawn(GO, ["build", "-o", out, "."], {
    cwd: GUARDIAN_SRC, stdio: ["ignore", "pipe", "pipe"], env: sanitized(),
  }), "go-build[guardian]");
  let log = "";
  build.child.stdout.on("data", (d) => { log = (log + d).slice(-4000); });
  build.child.stderr.on("data", (d) => { log = (log + d).slice(-4000); });
  const state = await raceClose(build.closed, BUILD_BUDGET_MS);
  if (state !== "closed(0)") {
    return { ok: false, why: `the owned-process guardian did not build (${state}): ${log.trim().slice(0, 2000)}` };
  }
  return { ok: true, bin: out };
}

/**
 * Start Chrome INSIDE a job object, and keep the means to prove it was cleaned.
 *
 * The guardian's own `ChildProcess` and its ledger are recorded BEFORE the
 * first await, exactly as the direct Chrome spawn's are: attribution that only
 * exists after a clean finish is absent precisely when it is needed.
 *
 * Chrome's pid arrives on the guardian's first report line, which the guardian
 * writes and flushes before it waits on anything.
 */
function startGuarded({ guardianBin, configPath, index, label, env = sanitized() }) {
  // The guarded process inherits THIS environment: the guardian's
  // `CreateProcess` passes a null environment block, which is inheritance, and
  // no handle is inherited with it. So the sanitising happens here, once, where
  // the rest of this fixture already does it.
  const guardian = track(spawn(guardianBin, [configPath], {
    stdio: ["pipe", "pipe", "pipe"], env,
  }), `guardian[${label}r${index}]`);
  // BEFORE the first await.
  const ledger = {
    round: index, kind: `guardian:${label}`, pid: guardian.child.pid ?? null, ppid: process.pid,
    executable: guardianBin, config: configPath,
  };
  ledgers.push(ledger);
  console.log(`-- owned guardian ledger: ${JSON.stringify(ledger)}`);

  const records = [];
  let pending = "";
  let stderr = "";
  guardian.child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); }
      catch { records.push({ kind: "unparsed", finding: line.slice(0, 300) }); }
    }
  });
  guardian.child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-4000); });

  const firstOf = (kind) => records.find((r) => r.kind === kind) ?? null;
  return {
    guardian, ledger, records,
    get stderr() { return stderr; },
    /**
     * Ask the job how many processes it still holds.
     *
     * The whole-tree reading, available while the job is still held — which is
     * what makes it usable as "has this half finished?" for a peer that died
     * without saying so.
     */
    async accounting(budgetMs = 5_000) {
      const before = records.filter((r) => r.kind === "accounting").length;
      try {
        guardian.child.stdin.write(JSON.stringify({ command: "accounting" }) + "\n");
      } catch {
        return null;
      }
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline && !guardian.exited) {
        const seen = records.filter((r) => r.kind === "accounting");
        if (seen.length > before) return seen[seen.length - 1];
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    },
    /** The guarded process's own pid, once the guardian has published it. */
    async awaitLedger(budgetMs) {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline && !guardian.exited) {
        const ledgerRecord = firstOf("ledger");
        if (ledgerRecord) return ledgerRecord;
        await new Promise((r) => setTimeout(r, 100));
      }
      return firstOf("ledger");
    },
    /**
     * Ask for the graceful join, then read what the guardian PROVED.
     *
     * `mode: "join"` because the caller has already asked the guarded process
     * to end — CDP `Browser.close` for Chrome, an ordinary run to completion
     * for the Electron peer. The guardian waits for the JOB's census to reach
     * zero, which is the only reading that covers Electron's own renderer and
     * utility children and the native IO helper it starts. If it does not reach
     * zero the guardian escalates, records a finding and exits non-zero.
     * Nothing here converts an unproven teardown into a clean one.
     */
    async shutdown(budgetMs) {
      try {
        guardian.child.stdin.write(JSON.stringify({ command: "shutdown", mode: "join" }) + "\n");
        guardian.child.stdin.end();
      } catch (err) {
        return { ok: false, why: `the guardian's command stream could not be written: ${String(err)}` };
      }
      const state = await raceClose(guardian.closed, budgetMs);
      const closed = firstOf("closed");
      if (state !== "closed(0)" || !closed || closed.outcome !== "joined"
          || closed.activeAfter !== 0 || (closed.findings ?? []).length > 0) {
        return {
          ok: false,
          why: `the guarded ${label} tree's cleanup was not proven: guardian ${state}, `
            + `report ${JSON.stringify(closed ?? null)}`
            + `${stderr ? ` | guardian stderr: ${stderr.slice(-600)}` : ""}`,
          closed,
        };
      }
      return { ok: true, closed };
    },
  };
}

const CASES = [
  {
    key: "real-bytes",
    // One batch, three shapes, all with actual bytes: a nested Unicode path, an
    // EMPTY file, and a file crossing the chunk boundary by exactly one byte.
    // Expressible only because this fixture drives the tab directly — the
    // command line the retired browser half used caps a body far below
    // `CHUNK_SIZE`.
    files: [
      { name: "docs/notes/deep/报告 ünïcode.bin", text: "nested unicode payload — 你好 ✅" },
      { name: "docs/空/empty.txt", text: "" },
      { name: "docs/boundary/chunk-plus-one.bin", size: CHUNK_SIZE + 1, seed: 23 },
    ],
    expectWritten: true,
  },
  {
    key: "illegal-win-name",
    // `NUL.txt` is the NUL DEVICE, not a text file: `winpath.ts:57-61,151`
    // rejects it on the stem before the first dot. A receiver that wrote it
    // would be writing to a device. Sent alone, so a refusal cannot be confused
    // with a partial batch.
    files: [{ name: "NUL.txt", text: "must never be written" }],
    expectWritten: false,
  },
];

/** The bytes a spec means, rebuilt here so the digest is computed independently
 *  of whatever the page produced. */
const bytesOf = (spec) =>
  spec.text !== undefined ? Buffer.from(spec.text, "utf8") : filled(spec.size, spec.seed);

async function runRound(root, bin, index, plan, guardianBin) {
  const dir = join(root, `round-${index}`);
  await mkdir(join(dir, "blobs"), { recursive: true });
  await mkdir(join(dir, "dest"), { recursive: true });
  await mkdir(join(dir, "profile"), { recursive: true });
  await mkdir(join(dir, "secrets"), { recursive: true });

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logPath = join(dir, "server.log");
  const logFd = await open(logPath, "a");
  const roundChildren = [];

  try {
    const server = track(
      spawn(bin, [
        "-addr", `127.0.0.1:${port}`, "-db", join(dir, "relayium.db"),
        "-blob-dir", join(dir, "blobs"), "-static", WEB_DIST,
        "-base-url", origin,
        "-stun-urls", "stun:127.0.0.1:3478", "-mail-transport", "dev-log-links",
      ], { env: sanitized({ RELAYIUM_RELEASE_CHECK: "false" }), stdio: ["ignore", logFd.fd, logFd.fd] }),
      `server[r${index}]`,
    );
    roundChildren.push(server);

    let up = false;
    const startDeadline = Date.now() + START_BUDGET_MS;
    while (Date.now() < startDeadline && !server.exited) {
      try {
        const r = await fetch(`${origin}/api/config`, { signal: opSignal(5_000) });
        if (r.ok) { up = true; break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!up) {
      return {
        ok: false,
        why: `server never listened (exited=${server.exited}); log: ${(await readTail(logPath, LOG_BUDGET_BYTES)).slice(-800)}`,
        roundChildren,
      };
    }

    // ---- a synthetic account, through the product's own API ---------------
    const call = async (method, path, body, bearer) => {
      const headers = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      const res = await fetch(`${origin}${path}`, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: opSignal(),
      });
      const text = (await collectBounded(res.body, `${method} ${path}`)).toString("utf8");
      let json;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, json };
    };

    const email = `rt-${randomBytes(4).toString("hex")}@example.invalid`;
    const password = randomBytes(24).toString("hex");
    await call("POST", "/api/auth/register", { email, password });
    const verifyToken = /verify-email\?token=([0-9a-f]+)/.exec(await readTail(logPath, LOG_BUDGET_BYTES))?.[1];
    if (!verifyToken) return { ok: false, why: "the synthetic account was never verifiable", roundChildren };
    await call("POST", "/api/auth/email/verify", { token: verifyToken, password });
    const login = await call("POST", "/api/auth/native/login", { email, password, deviceName: "windows-realtime" });
    const token = login.json?.token;
    if (!token) return { ok: false, why: `no bearer for the synthetic account (${login.status})`, roundChildren };

    // The JOINER round needs a code the Windows client did not mint. Minted
    // through the same real route `PairControl` uses.
    let code = "";
    if (plan.codeRole === "join") {
      const pair = await call("POST", "/api/pair", {}, token);
      code = pair.json?.code ?? "";
      if (!code) return { ok: false, why: `the server minted no pairing code (${pair.status})`, roundChildren };
    }

    // ---- the Windows peer --------------------------------------------------
    const peerOut = join(dir, "peer.json");
    const peerStatus = join(dir, "peer-status.json");
    const peerLogPath = join(dir, "peer.log");
    const configPath = join(dir, "peer-config.json");
    await writeFile(configPath, JSON.stringify({
      out: peerOut,
      // Written BY the peer, polled by this process. On win32 the peer is
      // started by the guardian through `CreateProcess`, so there is no pipe
      // here to read it from — and handing a guarded process inherited handles
      // is exactly the kind of ambient plumbing this fixture avoids.
      status: peerStatus,
      log: peerLogPath,
      origin,
      role: plan.codeRole === "create" ? "create" : "join",
      code,
      token: plan.codeRole === "create" ? token : null,
      accountEmail: email,
      userDataDir: join(dir, "profile"),
      secretsDir: join(dir, "secrets"),
      destinationDir: join(dir, "dest"),
      verify: true,
      sendMessage: plan.peerMessage,
      // The message this half must actually WATCH FOR, rather than hope to find
      // in a snapshot taken at the end of the round.
      //
      // This key existed and was read by `realtime-peer-main.mjs` from the
      // start, and was never once written here — so the Windows half never
      // waited for the browser's message at all. It sent, then waited on the
      // consent card, then read the thread once, whenever it happened to get
      // there. That read is after `LinkPane`'s message Card can already have
      // unmounted (it is gated on `connected`), which is how a message that DID
      // arrive reads back as an empty history.
      expectMessage: plan.browserMessage,
      sendFiles: [plan.peerFile],
      lifecycle: plan.lifecycle,
      joinBudgetMs: JOIN_BUDGET_MS,
      transferBudgetMs: TRANSFER_BUDGET_MS,
    }, null, 2));

    const electron = (await import("electron")).default;
    /** Only ever filled on the unguarded path, where this process holds the
     *  pipes. On win32 the peer's own log file is read instead. */
    let peerLive = "";
    const peerEnv = sanitized({
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      RELAYIUM_WINDOWS_ENGINEERING: "1",
      RELAYIUM_WINDOWS_ORIGIN: origin,
      RELAYIUM_WINDOWS_NO_LAN_AUTOSTART: "1",
    });

    // ---- who owns the Electron peer ---------------------------------------
    //
    // Electron is a process TREE for the same reason Chrome is — it IS Chromium
    // — and on win32 it starts one more child this fixture particularly cares
    // about: the native IO helper that performs the real receive. Joining the
    // Electron main process says nothing about any of them, so on Windows the
    // peer goes into a job object exactly as the browser does. The pairing code
    // and the running commentary come back through files the peer writes into
    // its own round directory, so nothing has to inherit a handle.
    let peer = null;
    let guardedPeer = null;
    let peerPid = null;
    if (guardianBin) {
      const peerGuardianConfig = join(dir, "peer-guardian.json");
      await writeFile(peerGuardianConfig, JSON.stringify({
        purpose: "owned-peer",
        executable: String(electron),
        args: [PEER_MAIN, configPath],
        workingDirectory: APP,
        joinBudgetMs: CLOSE_BUDGET_MS * 5,
        terminateBudgetMs: CLOSE_BUDGET_MS * 5,
      }, null, 2));
      guardedPeer = startGuarded({
        guardianBin, configPath: peerGuardianConfig, index, label: "electron", env: peerEnv,
      });
      roundChildren.push(guardedPeer.guardian);
      const publishedPeer = await guardedPeer.awaitLedger(START_BUDGET_MS);
      if (!publishedPeer?.pid) {
        return {
          ok: false,
          why: `the guardian never published an Electron ledger; records `
            + `${JSON.stringify(guardedPeer.records.slice(0, 6))}`
            + `${guardedPeer.stderr ? ` | stderr: ${guardedPeer.stderr.slice(-600)}` : ""}`,
          roundChildren,
        };
      }
      peerPid = publishedPeer.pid;
      ledgers.push({ round: index, kind: "electron", pid: peerPid,
        ppid: guardedPeer.ledger.pid, owner: "windows-job-object", executable: String(electron) });
      console.log(`-- owned electron ledger: ${JSON.stringify(
        { pid: peerPid, ppid: guardedPeer.ledger.pid, owner: "windows-job-object" })}`);
    } else {
      peer = track(
        spawn(String(electron), [PEER_MAIN, configPath], {
          cwd: APP, stdio: ["ignore", "pipe", "pipe"], env: peerEnv,
        }),
        `electron[r${index}]`,
      );
      roundChildren.push(peer);
      peerPid = peer.child.pid ?? null;
      ledgers.push({ round: index, kind: "electron", pid: peerPid, ppid: process.pid,
        owner: "parent-handle-join-only", executable: String(electron) });
      peer.child.stdout.on("data", (d) => { peerLive += d; });
      peer.child.stderr.on("data", (d) => { peerLive += d; });
    }

    if (CONTROL === "peerExit") {
      // After the ledger, before anything depends on it: an early death must be
      // reported as an early death, not waited out to a timeout.
      //
      // On Windows the target is the EXACT pid the guardian published, ended
      // through a handle opened on that pid alone. That is also the control's
      // real subject there: killing the Electron main process must not leave
      // its renderer, utility and native-helper children behind, and the
      // guardian's census afterwards is what says whether it did.
      await killExactly({ pid: peerPid, entry: peer, label: `electron[r${index}]` });
    }

    /**
     * Has this half stopped, whichever way it is owned?
     *
     * On the guarded path the GUARDIAN is not the answer: it deliberately
     * outlives the process it holds — that is the whole point of holding the
     * job handle — and waits for a shutdown command. So the peer's own
     * `finished` flag, published atomically as the last thing it does, is what
     * says the Windows half is done. A guardian that has exited on its own is
     * also terminal, and for a worse reason, so it counts too.
     */
    const peerGone = async () => {
      if (peer) return peer.exited;
      if (guardedPeer.guardian.exited) return true;
      const progress = await readObservation(peerStatus, "the Windows peer's progress");
      if (progress.finished === true) return true;
      // A peer that ended WITHOUT publishing `finished` is still ended — it was
      // killed, or it crashed. `peerExit` is exactly that case, and its whole
      // point is that an early death is reported AS an early death rather than
      // waited out to a timeout; reading only the status file would wait out the
      // entire round budget for a flag that can never be written now.
      //
      // The job's census is the reading that covers it, and it covers the whole
      // tree: zero means the Electron main process AND its renderer, utility and
      // native-helper children have all gone.
      const census = await guardedPeer.accounting(2_000);
      return census?.activeProcesses === 0;
    };
    /** The peer's own commentary, from whichever place it lands. */
    const peerCommentary = async () =>
      peerLive || (await readTail(peerLogPath, LOG_BUDGET_BYTES));

    // The CREATOR round has to publish its code before the browser can join.
    if (plan.codeRole === "create") {
      const deadline = Date.now() + JOIN_BUDGET_MS;
      while (Date.now() < deadline && !(await peerGone())) {
        // The peer's own progress file, written atomically the moment the code
        // is minted. Its observations file is written once, at the very end,
        // which is far too late for a browser that has to join this room.
        const progress = await readObservation(peerStatus, "the Windows peer's progress");
        if (progress.code) { code = progress.code; break; }
        const seen = await readObservation(peerOut, "the Windows peer");
        if (seen.code) { code = seen.code; break; }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!code) {
        return {
          ok: false,
          why: `the Windows client never published a code; peer log: `
            + `${(await peerCommentary()).slice(-800)}`,
          roundChildren,
        };
      }
    }

    // ---- the browser, spawned and OWNED HERE ------------------------------
    //
    // Not delegated to a Node process that owns it, because joining that process
    // is not joining Chrome. The ledger below is written BEFORE the first await
    // so this browser is attributable from the log alone even if everything
    // after it fails — the exact gap that made an earlier cleanup unprovable.
    const chromeProfile = join(dir, "chrome-profile");
    await mkdir(chromeProfile, { recursive: true });
    const debugPort = await freePort();
    let chromeBin;
    try {
      chromeBin = process.env.CHROME_PATH || resolveChrome();
    } catch (err) {
      return { ok: false, why: `SETUP: ${String(err?.message ?? err)}`, roundChildren };
    }
    const chromeArgs = [
      "--headless=new",
      `--remote-debugging-port=${debugPort}`,
      // INSIDE this round's root, never the shared `tmpdir()/relayium-e2e-`
      // namespace: a profile that another session's run could also match is
      // not an ownership record.
      `--user-data-dir=${chromeProfile}`,
      "--no-first-run", "--no-default-browser-check",
      // Host candidates rather than mDNS `.local` ones: there is no mDNS
      // resolver in a headless run, so hiding the local IP means the two peers
      // never pair a usable candidate. Same reason as the shared harness.
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
      "about:blank",
    ];

    // ---- who owns Chrome, and what that ownership can prove ---------------
    //
    // On WINDOWS the guardian owns it, in a job object: `ChildProcess.kill`
    // there is `TerminateProcess` against the parent alone, and Chrome's
    // renderer, GPU and utility children would survive it unaccounted.
    //
    // Everywhere else Chrome is spawned directly and joined by handle, which on
    // a POSIX host is a real join of a real process. That is NOT the same
    // guarantee — it does not account for the tree — and it is labelled as a
    // different one in the report rather than being described as job ownership.
    let chrome = null;
    let guarded = null;
    let chromeErr = "";
    if (guardianBin) {
      const guardianConfig = join(dir, "guardian.json");
      await writeFile(guardianConfig, JSON.stringify({
        purpose: "owned-browser",
        executable: chromeBin,
        args: chromeArgs,
        joinBudgetMs: CLOSE_BUDGET_MS * 5,
        terminateBudgetMs: CLOSE_BUDGET_MS * 5,
      }, null, 2));
      guarded = startGuarded({ guardianBin, configPath: guardianConfig, index, label: "chrome" });
      roundChildren.push(guarded.guardian);
      const published = await guarded.awaitLedger(START_BUDGET_MS);
      if (!published?.pid) {
        return {
          ok: false,
          why: `the guardian never published a browser ledger; records `
            + `${JSON.stringify(guarded.records.slice(0, 6))}`
            + `${guarded.stderr ? ` | stderr: ${guarded.stderr.slice(-600)}` : ""}`,
          roundChildren,
        };
      }
      const ledger = {
        pid: published.pid, ppid: guarded.ledger.pid, owner: "windows-job-object",
        debugPort, profileDir: chromeProfile, executable: chromeBin,
      };
      ledgers.push({ round: index, ...ledger });
      console.log(`-- owned chrome ledger: ${JSON.stringify(ledger)}`);
    } else {
      chrome = track(
        spawn(chromeBin, chromeArgs, { stdio: ["ignore", "ignore", "pipe"], env: sanitized() }),
        `chrome[r${index}]`,
      );
      roundChildren.push(chrome);
      chrome.profileDir = chromeProfile;
      const ledger = {
        pid: chrome.child.pid ?? null, ppid: process.pid, owner: "parent-handle-join-only",
        debugPort, profileDir: chromeProfile, executable: chromeBin,
      };
      ledgers.push({ round: index, ...ledger });
      console.log(`-- owned chrome ledger: ${JSON.stringify(ledger)}`);
      chrome.child.stderr.on("data", (d) => {
        // Bounded: Chrome writes megabytes of GPU/sandbox noise, and an
        // undrained pipe would block the browser itself.
        chromeErr = (chromeErr + d).slice(-4000);
      });
    }

    let browserObserved = null;
    let browserFailure = null;
    let browserGraceful = null;
    let ownedClient = null;
    /** Set where the join actually happens, which is now inside the `finally`. */
    let peerTimedOut = true;
    /** The guardians' own reports on each tree, when there were any. */
    let browserTreeProof = null;
    let peerTreeProof = null;
    try {
      const owned = await connectToOwnedBrowser(
        CONTROL === "badCdp" ? await freePort() : debugPort,
        CONTROL === "badCdp" ? 5_000 : JOIN_BUDGET_MS, runDeadline.signal);
      ownedClient = owned;
      browserObserved = await driveBrowserPeer(owned, {
        origin, code,
        message: plan.browserMessage,
        files: plan.browserFiles,
        expectMessage: plan.peerMessage,
        verify: true,
        joinBudgetMs: JOIN_BUDGET_MS,
        transferBudgetMs: TRANSFER_BUDGET_MS,
      });
    } catch (err) {
      browserFailure = `${String(err?.message ?? err)}${chromeErr ? ` | chrome stderr: ${chromeErr.slice(-600)}` : ""}`;
    } finally {
      // ---- wait for both halves, bounded ----------------------------------
      //
      // ## The browser is joined AFTER the Windows half, not before it
      //
      // This `finally` used to shut the browser down the instant
      // `driveBrowserPeer` returned. That is not a teardown detail — it
      // truncates the ROOM while the other real peer is still in it, and the
      // shipped protocol has a step that can only happen afterwards.
      //
      // Both peers hand over a batch at nearly the same moment, so their
      // manifests cross. `mixed-file-session.svelte.ts:1183-1198` arbitrates
      // that glare deterministically: the INITIATOR (the smaller room id) keeps
      // its outbound and answers FILE_BUSY, and the RESPONDER yields and
      // requeues its own batch for exactly one replay once the keeper's batch
      // has finished (`requeueOrFail`, `:1436-1458`). When the browser draws
      // responder, its batch therefore reaches the Windows client on the
      // REPLAY — and a browser that has already been closed never replays. The
      // Windows half then waits out its whole receive budget for a consent card
      // that can no longer come, and by the time it reads the thread `connected`
      // is false, `LinkPane`'s message Card has unmounted, and the history it
      // reads back is empty.
      //
      // That is the whole of the "one round of three did not deliver the
      // browser's message" failure, and it was introduced by moving the close
      // here — not uncovered by a stricter assertion. The message check is
      // byte-identical in the green, pre-correction and current sources.
      //
      // So: join the Windows peer first, bounded by the round budget, and only
      // then close the browser. The `finally` guarantee is unchanged — a round
      // that threw still reaches this and still closes the browser — and
      // `Browser.close` is still the graceful path that tears down Chrome's own
      // process tree rather than its parent alone.
      const roundDeadline = Date.now() + ROUND_BUDGET_MS;
      while (Date.now() < roundDeadline && !(await peerGone())) {
        await new Promise((r) => setTimeout(r, 250));
      }
      peerTimedOut = !(await peerGone());

      // The Electron TREE first, and only then the browser.
      //
      // Order matters twice over. The browser must outlive the Windows half
      // because the shipped glare arbitration can defer the browser's batch to
      // a replay that only a live browser performs. And the peer's job census
      // has to reach zero — Electron's renderer and utility children and the
      // native IO helper included — before this round's directory can be called
      // clean, because those are the processes that hold its files open.
      if (guardedPeer) {
        const proof = await guardedPeer.shutdown(ROUND_BUDGET_MS);
        peerTreeProof = proof.closed ?? null;
        if (!proof.ok) cleanupFindings.push(proof.why);
      }
      if (ownedClient) browserGraceful = (await closeOwnedBrowser(ownedClient)).graceful;
      // The graceful request has been made; the guardian says whether the whole
      // TREE actually went. A report it cannot prove is a cleanup finding, and
      // reaches the exit code like every other one.
      if (guarded) {
        const proof = await guarded.shutdown(ROUND_BUDGET_MS);
        browserTreeProof = proof.closed ?? null;
        if (!proof.ok) cleanupFindings.push(proof.why);
      }
    }

    const timedOut = peerTimedOut;

    return {
      ok: true,
      timedOut,
      dir,
      code,
      peer: await readObservation(peerOut, "the Windows peer"),
      browser: browserObserved ?? { __missing: browserFailure ?? "the browser produced no observations" },
      browserNote: browserObserved?.failure ?? null,
      browserGraceful,
      browserTreeProof,
      peerTreeProof,
      browserFailure,
      peerLog: await peerCommentary(),
      roundChildren,
    };
  } finally {
    await logFd.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------

const findings = { rolesSeen: new Set(), codeRolesPassed: new Set(), retained: [], rounds: [] };

async function main() {
  const root = await mkdtemp(join(tmpdir(), "relayium-realtime-"));
  taskRoot = root;
  console.log(`-- task root: ${root}`);
  let keepRoot = false;
  try {
    // ---- preflight: setup failures are named as setup failures ------------
    for (const [what, path] of [["the Windows client bundle", join(APP, "dist", "main", "index.js")],
                                ["the built Web bundle", join(WEB_DIST, "index.html")],
                                ]) {
      try {
        await readFile(path);
      } catch {
        throw new Error(`SETUP: ${what} is missing at ${path}; run the builds named in this file's header`);
      }
    }

    // The same platform precondition the Inbox fixture runs: on Windows the
    // server is compiled with one file overlaid, so the overlay's own package
    // test must pass before anything depends on the binary. SKIPPED where no
    // overlay applies — and reported as skipped, never as executed.
    const platform = await testDiskUsageWithOverlay({
      repoRoot: REPO, taskRoot: root, register: (child, label) => track(child, label),
    });
    if (platform.unjoined) {
      cleanupFindings.push(`${platform.ledger?.label ?? "diskusage-probe"} (pid ${platform.ledger?.pid ?? "-"}) did not close`);
    }
    if (platform.skipped) {
      console.log(`-- storage platform positive: SKIPPED (${platform.why})`);
    } else if (!platform.ok) {
      throw new Error(`SETUP: the storage platform positive failed at the ${platform.stage} stage: `
        + `${(platform.stderr || platform.stdout || platform.spawnError || `exit ${platform.code}`).trim().slice(0, 4000)}`);
    } else {
      console.log(`-- storage platform positive: PASSED (${JSON.stringify(platform.ledger)})`);
    }

    const bin = join(root, SERVER_BIN);
    const built = await buildServerForFixture({
      repoRoot: REPO, taskRoot: root, outPath: bin, timeoutMs: BUILD_BUDGET_MS,
      register: (child, label) => track(child, label),
    });
    if (built.unjoined) {
      cleanupFindings.push(`${built.ledger.label} (pid ${built.ledger.pid ?? "-"}) did not close`);
    }
    if (!built.ok) {
      throw new Error(`SETUP: building the server from ${SERVER_SRC} failed: `
        + `${(built.stderr || built.stdout || `exit ${built.code}`).trim().slice(0, 4000)}`);
    }
    serverProvenance = built.provenance;
    console.log(`-- server build: ${JSON.stringify(built.provenance)}`);

    // ---- who will own Chrome -----------------------------------------------
    //
    // Built on Windows, where it is the only mechanism that can account for
    // Chrome's process tree. Off Windows the guardian refuses to run by design
    // — a POSIX stand-in would pass different tests and could be mistaken for
    // evidence about Windows cleanup — so the direct spawn is used and the
    // report says so rather than implying a guarantee that was never made.
    let guardianBin = null;
    if (WINDOWS) {
      const guardian = await buildGuardian(root);
      if (!guardian.ok) throw new Error(`SETUP: ${guardian.why}`);
      guardianBin = guardian.bin;
      console.log(`-- browser ownership: windows job object, guardian at ${guardianBin}`);
    } else {
      console.log(`-- browser ownership: parent-handle join only `
        + `(${process.platform} has no job object; the guardian refuses to substitute one)`);
    }

    // ---- the rounds --------------------------------------------------------
    const results = [];
    for (let index = 1; index <= MAX_ROUNDS; index += 1) {
      const bothRoles = findings.rolesSeen.has("initiator") && findings.rolesSeen.has("responder");
      const casesDone = new Set(results.filter((r) => r.outcome?.ok).map((r) => r.plan.case.key));
      const codeRolesDone = findings.codeRolesPassed.size >= 2;
      if (bothRoles && casesDone.size >= CASES.length && codeRolesDone && index > 3) break;

      const plan = {
        case: CASES[(index - 1) % CASES.length],
        browserFiles: CASES[(index - 1) % CASES.length].files,
        codeRole: index % 2 === 1 ? "create" : "join",
        browserMessage: `browser round ${index} — 你好 ✅`,
        peerMessage: `windows round ${index} — ünïcode ✅`,
        // Windows -> browser is where the chunk boundary can travel: the bytes
        // are built in the page, so they never cross a command line.
        peerFile: index === 1
          ? { name: "chunk-boundary.bin", size: CHUNK_SIZE + 1, seed: 7 }
          : { name: `round-${index} ünïcode.txt`, text: `round ${index} payload — 你好` },
        lifecycle: index === 1 ? "leave" : "none",
      };

      console.log(`\n== round ${index}: ${plan.case.key}, windows ${plan.codeRole}s the code ==`);
      const outcome = await runRound(root, bin, index, plan, guardianBin);
      results.push({ plan, outcome, index });
      const clean = await stopChildren(outcome.roundChildren);
      if (!clean) {
        findings.retained.push(join(root, `round-${index}`));
        break;
      }
      if (!outcome.ok) {
        console.log(`-- round ${index} did not reach an assertion: ${outcome.why}`);
        continue;
      }
      // Bounded per-round diagnosis. A round that reached an assertion but did
      // not open a link says nothing at all without this, and this fixture's
      // first real run is on a platform nobody can attach a debugger to.
      console.log(`-- round ${index}: linkOpen=${String(outcome.peer?.linkOpen)}`
        + ` peerErrors=${JSON.stringify((outcome.peer?.errors ?? []).slice(0, 4))}`
        + ` browserRole=${outcome.browser?.role ?? "-"} browserWorkspace=${String(outcome.browser?.reachedWorkspace)}`
        + ` browserSas=${outcome.browser?.sas ?? "-"} peerSas=${outcome.peer?.sas ?? "-"}`
        + ` browserFailure=${JSON.stringify(String(outcome.browserNote ?? outcome.browserFailure ?? "none").slice(0, 200))}`
        + ` browserNotes=${JSON.stringify((outcome.browser?.notes ?? []).map((n) => String(n).slice(0, 300)))}`
        + ` peerTail=${JSON.stringify((outcome.peerLog ?? "").slice(-500))}`);
      if (outcome.browser?.role) {
        findings.rolesSeen.add(outcome.browser.role);
        // Both sides, named: the browser reports the assignment it drew and the
        // Windows client necessarily holds the other one. A single label would
        // not say which client was which.
        findings.rounds.push({
          round: index,
          codeRole: `windows-${plan.codeRole}s`,
          browserLinkRole: outcome.browser.role,
          windowsLinkRole: outcome.browser.role === "initiator" ? "responder" : "initiator",
          case: plan.case.key,
        });
      }
      if (outcome.peer?.linkOpen && outcome.browser?.reachedWorkspace) {
        findings.codeRolesPassed.add(plan.codeRole);
      }
      if (runDeadline.signal.aborted) break;
    }

    const usable = results.filter((r) => r.outcome?.ok);
    step("at least one round put both real peers in one room", usable.length > 0,
      `${usable.length} of ${results.length} rounds reached an assertion`);
    if (usable.length === 0) {
      for (const r of results) console.log(`-- round ${r.index}: ${r.outcome?.why ?? "unknown"}`);
      return;
    }

    // ---- what every usable round must have been true of --------------------
    const workspaces = usable.filter((r) => r.outcome.peer.linkOpen && r.outcome.browser.reachedWorkspace);
    step("both clients reached ONE unified workspace", workspaces.length === usable.length,
      `${workspaces.length}/${usable.length}`);

    // Every verified round must have produced BOTH digits. A round that showed
    // none is a round that compared nothing, and filtering those out is how a
    // suite reports agreement it never observed.
    const sasAgreed = usable.filter((r) => {
      const a = String(r.outcome.peer.sas ?? "").replace(/\s+/g, "");
      const b = String(r.outcome.browser.sas ?? "").replace(/\s+/g, "");
      return a !== "" && b !== "" && a === b;
    });
    step("the two clients agreed the SAS on the opt-in path, in EVERY verified round",
      sasAgreed.length === usable.length && usable.length > 0,
      `${sasAgreed.length}/${usable.length} rounds compared two digit strings`);

    // EXACT, and against what the thread ACTUALLY HELD while the link was up.
    //
    // Two changes, both tightenings. `includes` was a substring test on an
    // element whose text content is `{entry.body}` and nothing else
    // (`LinkPane.svelte:580-582`), so a prefix of the expected message would
    // have satisfied it; equality is what that element can support. And the
    // subject is `receivedMessagesPeak` — the fullest thread the Windows half
    // observed DURING the round — rather than a snapshot read after it, because
    // the message Card is gated on `connected` and unmounts when the peer
    // leaves. The final read is still reported beside it.
    const threadHeld = (r, message) =>
      (r.outcome.peer.receivedMessagesPeak ?? []).some((m) => m === message);
    const gotBrowserMsg = usable.filter((r) => threadHeld(r, r.plan.browserMessage));
    step("the Windows client received the browser's UTF-8 message",
      gotBrowserMsg.length === usable.length,
      `${gotBrowserMsg.length}/${usable.length}` + (gotBrowserMsg.length === usable.length ? "" :
        `; per round ${JSON.stringify(usable.map((r) => ({
          round: r.index,
          windowsLinkRole: r.outcome.browser?.role === "initiator" ? "responder" : "initiator",
          timing: r.outcome.peer.receiveTiming ?? null,
          peak: r.outcome.peer.receivedMessagesPeak ?? null,
          final: r.outcome.peer.receivedMessages ?? null,
        })))}`));

    const gotPeerMsg = usable.filter((r) =>
      r.outcome.browser.receivedMessages?.some((m) => m === r.plan.peerMessage));
    step("the browser received the Windows client's UTF-8 message",
      gotPeerMsg.length === usable.length, `${gotPeerMsg.length}/${usable.length}`);

    // ---- the chunk-boundary file, Windows -> browser ------------------------
    const boundary = usable.find((r) => r.plan.peerFile.size === CHUNK_SIZE + 1);
    if (boundary) {
      const expected = bytesOf(boundary.plan.peerFile);
      const got = boundary.outcome.browser.receivedFileHex ?? "";
      step("Windows -> browser: a file crossing the chunk boundary by one byte arrived byte-exact",
        got === hex(expected),
        `${got.length / 2} bytes, sha256 ${got ? sha256(Buffer.from(got, "hex")) : "-"} vs ${sha256(expected)}`);
    } else {
      skip("Windows -> browser: a file crossing the chunk boundary by one byte arrived byte-exact",
        "no round completed the chunk-boundary case");
    }

    // ---- the Windows destination, with ACTUAL BYTES ------------------------
    const hostProvider = usable.some((r) => r.outcome.peer.hostProvider);
    const label = (what) => `${what}${hostProvider ? " [PORTABLE HOST PROVIDER, not the Windows destination]" : ""}`;
    const realBytes = usable.find((r) => r.plan.case.key === "real-bytes");
    if (!realBytes) {
      skip(label("a real batch landed at the destination byte-exact"), "no round completed the real-bytes case");
      skip(label("an EMPTY file was created, not skipped"), "no round completed the real-bytes case");
      skip(label("a file crossing the chunk boundary landed byte-exact"), "no round completed the real-bytes case");
    } else {
      const entries = realBytes.outcome.peer.destinationEntries ?? [];
      // EXACT relative path. `endsWith(leaf)` accepted a file the receiver had
      // flattened into the root, or written under some other folder, while the
      // check claimed the DECLARED path had survived — the one thing it exists
      // to prove. Only the platform separator is normalised.
      const normalise = (path) => String(path).split("\\").join("/");
      const at = (spec) => entries.find((e) => normalise(e.path) === normalise(spec.name));
      const compare = (spec) => {
        const want = bytesOf(spec);
        const got = at(spec);
        return { got, ok: Boolean(got) && got.size === want.length && got.sha256 === sha256(want), want };
      };
      const nested = compare(realBytes.plan.case.files[0]);
      const empty = compare(realBytes.plan.case.files[1]);
      const boundaryIn = compare(realBytes.plan.case.files[2]);
      step(label("a nested Unicode path landed under its own declared path, byte-exact"),
        nested.ok, `${JSON.stringify(nested.got ?? null)} vs sha256 ${sha256(nested.want)}`);
      step(label("an EMPTY file was created at the destination, not skipped"),
        empty.ok && empty.got?.size === 0, JSON.stringify(empty.got ?? null));
      step(label("a file crossing the chunk boundary by one byte landed byte-exact"),
        boundaryIn.ok && boundaryIn.got?.size === CHUNK_SIZE + 1,
        `${boundaryIn.got?.size ?? "-"} bytes, sha256 ${boundaryIn.got?.sha256 ?? "-"} vs ${sha256(boundaryIn.want)}`);
    }

    // ---- the typed Windows refusal ----------------------------------------
    const illegal = usable.find((r) => r.plan.case.key === "illegal-win-name");
    if (!WINDOWS) {
      skip("a Windows-illegal name is REFUSED for that reason, and nothing is written",
        `the real destination, its winpath guards and the helper's typed E_MANIFEST refusal `
        + `exist only on win32; this host is ${process.platform}`);
    } else if (!illegal) {
      skip("a Windows-illegal name is REFUSED for that reason, and nothing is written",
        "no round completed the illegal-name case");
    } else {
      const entries = illegal.outcome.peer.destinationEntries ?? [];
      const outcome = illegal.outcome.peer.receivedOutcome;
      const notice = String(illegal.outcome.peer.receivedNotice ?? "").trim();
      const opens = illegal.outcome.peer.destinationOpens ?? [];

      // ## Why the panel's text is reported and not believed
      //
      // A terminal `recv-failed`/`recv-cancelled` with some non-empty text is
      // NOT a path refusal. `LinkPane.svelte:115-121` gives `unsupported`,
      // `permission`, `conflict`, `timeout`, `internal` and `helper-unavailable`
      // their own sentences and maps everything else — a refused manifest
      // included — to one generic string, so a helper that timed out or a
      // folder that denied permission produces exactly the same reading. The
      // previous check accepted all of them.
      //
      // The typed cause is the helper's own `E_MANIFEST`, observed at the
      // destination seam before `RoomController.#pickSaveTarget` rethrows it
      // without a receipt. `refusalOf` demands that exact cause; the DOM
      // outcome travels in the detail as context.
      const refusalOf = (open) => Boolean(open)
        && open.outcome === "refused"
        && open.errorName === "NativeHelperError"
        && open.helperCode === "E_MANIFEST";
      const refused = opens.find(refusalOf);
      const declared = illegal.plan.case.files.map((f) => f.name);
      const named = Boolean(refused) && declared.every((name) => refused.manifest.includes(name));

      step("a Windows-illegal name is REFUSED for that reason, and nothing is written",
        named && entries.length === 0,
        `refusal=${JSON.stringify(refused ?? null)} declared=${JSON.stringify(declared)} `
        + `entries=${JSON.stringify(entries)} `
        + `[panel, reported only: outcome=${outcome || "(none)"} notice=${JSON.stringify(notice)}]`);

      // A SEPARATE oracle, and deliberately separate.
      //
      // The check above proves the refusal happened FOR THE RIGHT REASON, read
      // from the destination seam where the typed cause still exists. This one
      // proves the USER WAS TOLD, read from the shipped pane. They are
      // different claims and one must never stand in for the other: the Windows
      // runner reported a correct `E_MANIFEST` refusal alongside
      // `outcome=(none) notice=""`, which is a receiver that did the right
      // thing and said nothing about it.
      //
      // `recv-saved` cannot satisfy this, and neither can an empty notice — the
      // two readings that made the old single check pass for the wrong reason.
      step("the refusal is VISIBLE: the shipped pane reaches a terminal receipt with a reason",
        (outcome === "recv-failed" || outcome === "recv-cancelled") && notice !== "",
        `outcome=${outcome || "(none)"} notice=${JSON.stringify(notice)}`);

      // ---- controls on the refusal evidence itself -------------------------
      //
      // Each runs the SAME `refusalOf` predicate the assertion above used, over
      // the SAME observed record, so none of them is two constants compared.

      // Healthy positive: the observer records a destination that OPENED. An
      // empty or always-failing `destinationOpens` would otherwise make every
      // refusal check vacuous, and a refusal is only meaningful if the same
      // seam can also report success.
      const openedSomewhere = usable.some((r) =>
        (r.outcome.peer.destinationOpens ?? []).some((o) => o.outcome === "opened"));
      step("positive control: the destination observer also records a destination that OPENED",
        openedSomewhere,
        "so an absent or always-failing observation is a blind spot rather than a refusal");

      // Wrong-reason negative: the REAL observed refusal, with only its typed
      // cause replaced by another real `NativeHelperError` code, must stop
      // satisfying the predicate.
      if (refused) {
        const wrongReason = { ...refused, helperCode: "E_ACCESS" };
        const wrongName = { ...refused, errorName: "Error" };
        step("negative control: the refusal check rejects a DIFFERENT typed cause",
          !refusalOf(wrongReason) && !refusalOf(wrongName),
          `the observed refusal with helperCode E_ACCESS, and with a non-NativeHelperError name, `
          + `are both rejected by the same predicate that accepted ${JSON.stringify(refused.helperCode)}`);
      } else {
        step("negative control: the refusal check rejects a DIFFERENT typed cause", false,
          "no refusal was observed, so the control had nothing real to mutate");
      }

      // Empty-outcome negative: an absent observation must never pass.
      step("negative control: the refusal check rejects an ABSENT outcome",
        !refusalOf(undefined) && !refusalOf({ manifest: declared, outcome: "", errorName: "", helperCode: "" }),
        "neither a missing record nor a record with no typed cause satisfies the refusal check");
    }

    // ---- browser ownership --------------------------------------------------
    //
    // On Windows this is a claim about the whole TREE, made from the job's own
    // census. Off Windows there is no such claim to make, and it is SKIPPED
    // rather than quietly satisfied by the parent's exit — which is exactly the
    // conflation the guardian exists to end.
    //
    // BOTH trees, separately. Chrome is the obvious one; Electron is Chromium
    // with the same renderer and utility children, plus — on win32 — the native
    // IO helper that performs the real receive. A fixture that accounted for the
    // browser and joined the Electron parent by handle would have closed one
    // multiprocess tree and guessed about the other.
    for (const [what, field] of [["browser", "browserTreeProof"], ["Electron peer", "peerTreeProof"]]) {
      if (!WINDOWS) {
        skip(`every owned ${what} TREE was proven empty after the round`,
          `a job object exists only on win32; on ${process.platform} the parent is joined by `
          + `handle, which says nothing about its renderer, utility or helper children`);
        continue;
      }
      const proofs = usable.map((r) => r.outcome[field] ?? null);
      const proven = proofs.filter((p) => p && p.outcome === "joined" && p.activeAfter === 0
        && (p.findings ?? []).length === 0);
      step(`every owned ${what} TREE was proven empty after the round`,
        proofs.length > 0 && proven.length === proofs.length,
        `${proven.length}/${proofs.length} rounds reported a job census of zero; `
        + `reports ${JSON.stringify(proofs)}`);
    }

    // ---- roles --------------------------------------------------------------
    step("BOTH link-role assignments were observed, not one of them twice",
      findings.rolesSeen.has("initiator") && findings.rolesSeen.has("responder"),
      [...findings.rolesSeen].join("+") || "none");
    step("the Windows client both MINTED a code and JOINED one it did not mint",
      findings.codeRolesPassed.has("create") && findings.codeRolesPassed.has("join"),
      [...findings.codeRolesPassed].join("+") || "none");

    // ---- lifecycle ----------------------------------------------------------
    const left = usable.find((r) => r.plan.lifecycle === "leave");
    if (!left) {
      skip("leaving the room ends the link and leaves no residue", "no round completed the lifecycle case");
    } else {
      step("leaving the room ends the link and leaves no residue",
        left.outcome.peer.leftRoom === true &&
        (left.outcome.peer.destinationEntries ?? []).every((e) => !e.path.includes(".relayium-staging")),
        `left=${String(left.outcome.peer.leftRoom)}`);
    }

    // ---- required coverage: a case that did not RUN is a FAILURE ------------
    //
    // A `skip` is only legitimate for the one check whose subject does not exist
    // off win32 — the real destination and its `winpath` guards. Everything else
    // that did not run is coverage this suite owes and did not deliver, and a
    // suite that exits 0 having run none of it is the failure mode all of this
    // exists to prevent.
    const ranCases = new Set(usable.map((r) => r.plan.case.key));
    for (const required of CASES.map((c) => c.key)) {
      if (required === "illegal-win-name" && !WINDOWS) continue; // the documented native skip
      step(`the REQUIRED case "${required}" actually ran`, ranCases.has(required),
        `ran ${JSON.stringify([...ranCases])}`);
    }
    step("the REQUIRED chunk-boundary case ran in BOTH directions", Boolean(boundary) && ranCases.has("real-bytes"),
      `outbound=${Boolean(boundary)} inbound=${ranCases.has("real-bytes")}`);
    step("the REQUIRED lifecycle case ran", Boolean(left), `lifecycle=${Boolean(left)}`);

    // ---- positive controls for everything that could skip -------------------
    // Each proves the machinery that would have judged a skipped check is
    // itself working, so a SKIP can never be read as a silent pass.
    step("positive control: the destination reader sees files that ARE there",
      (usable.find((r) => r.plan.case.key === "real-bytes")?.outcome.peer.destinationEntries ?? []).length === 3,
      "the same reader that must report an EMPTY destination for the refusal case, "
      + "so an empty list there is a refusal rather than a blind spot");
    // A constant compared against another constant proves nothing about the
    // pipeline that produced the bytes above. This runs the REAL comparison used
    // by the destination assertions against the REAL observed entries, with one
    // byte of the expectation changed, and requires it to reject.
    if (realBytes) {
      const entries = realBytes.outcome.peer.destinationEntries ?? [];
      const normalise = (path) => String(path).split("\\").join("/");
      const spec = realBytes.plan.case.files[0];
      const got = entries.find((e) => normalise(e.path) === normalise(spec.name));
      const corrupted = Buffer.from(bytesOf(spec));
      corrupted[0] ^= 0xff;
      step("mutation control: the REAL destination comparison rejects one flipped byte",
        Boolean(got) && got.sha256 !== sha256(corrupted) && got.sha256 === sha256(bytesOf(spec)),
        `observed ${got?.sha256 ?? "-"}; mutated expectation ${sha256(corrupted)}`);
      step("mutation control: the REAL path comparison rejects a flattened path",
        !entries.some((e) => normalise(e.path) === normalise(spec.name.split("/").pop())),
        "a receiver that flattened the folder would no longer satisfy the path check");
    } else {
      step("mutation control: the REAL destination comparison rejects one flipped byte", false,
        "the real-bytes case did not run, so the control could not be applied");
    }
  } finally {
    clearTimeout(runTimer);
    const clean = await stopChildren();
    if (!clean) {
      keepRoot = true;
      cleanupFindings.push("temp root retained under an unjoined child");
    }
    if (!keepRoot && process.env.INTEROP_KEEP !== "1") {
      const remove = CONTROL === "removeFails"
        ? () => Promise.reject(new Error("control: the temp root could not be removed"))
        : () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await remove().catch((e) => cleanupFindings.push(String(e)));
    } else {
      console.log(`-- temp root retained: ${root}`);
    }
  }
}

let threw = null;
try {
  await main();
} catch (error) {
  threw = error;
  step("the acceptance completed without throwing", false, String(error?.stack ?? error));
}
console.log(JSON.stringify({
  platform: process.platform,
  serverBuild: serverProvenance,
  ownedBrowsers: ledgers,
  ran: steps.length,
  failures,
  skipped,
  cleanupFindings,
  taskRoot,
  control: CONTROL || null,
  killControl: KILL_CONTROL || null,
  keepRootRequested: process.env.INTEROP_KEEP === "1",
  roundsRequested: MAX_ROUNDS,
  rounds: findings.rounds,
  rolesSeen: [...findings.rolesSeen],
  codeRolesPassed: [...findings.codeRolesPassed],
  threw: threw === null ? null : String(threw?.message ?? threw),
  steps,
}, null, 2));
process.exit(failures === 0 && cleanupFindings.length === 0 && steps.length > 0 ? 0 : 1);
