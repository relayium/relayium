// Device Inbox SEND and RECEIVE, end to end, against a REAL Relayium server.
//
// A mocked `fetch` is a unit test, whatever it is called. This stands up an
// ephemeral loopback Relayium server built from `server/` at the current
// checkout, mints a synthetic account and two devices, and drives the compiled
// `dist/main/inbox/send-coordinator.js` through create, receive, retry and
// cancel against the real handlers.
//
// Everything here is REAL: the server and its handlers, the account, the two
// devices, the inbox enrolment, the target's X25519 key from the real key
// store, the `device_task` resumable upload, the sealed frame-0 manifest, the
// sealed content key, the task routes, the receiver's claim/blob/report through
// the compiled `InboxApi` — and the payload ciphertext itself, produced by the
// shared `encryptFiles` and DECRYPTED back through the shared
// `createStoreDecryptor`, with the plaintext bytes, the folder paths and the
// UTF-8 message asserted on the far side.
//
// No second crypto implementation exists anywhere in this file. There is no
// mock transport, no synthetic frame and no stand-in for the server.
//
// ## Where this came from, and what changed
//
// The assertions, their order and their guard structure are the accepted
// private root harness (`sender-v4-root-harness.mjs`, original exit 0). That
// harness was written to run once, on one machine, from two absolute paths.
// This is the same run made PORTABLE and repository-owned, so it executes on a
// developer's macOS checkout and on a Windows CI runner as the same script:
//
//   * both roots come from `import.meta.url`, never from a hardcoded path;
//   * the built server and the Go driver take `.exe` on Windows;
//   * the server's environment is sanitized rather than inherited whole;
//   * termination is bounded, by handle, and joined before any cleanup;
//   * every body read is byte-capped as well as deadline-bounded.
//
// ## Isolation
//
// Follows `scripts/lib/local-acceptance.sh`: an ephemeral kernel-assigned port,
// one temporary root removed on the way out, `RELAYIUM_RELEASE_CHECK=false`,
// and only the exact child this run started terminated — no pattern match, no
// process tree, no name. Nothing here reaches a network beyond loopback, no
// owner or production credential is read, and the account is synthetic and
// lives for the length of the run.
//
// ## The server's environment is sanitized, not inherited
//
// Every server flag has an `RELAYIUM_*` environment fallback
// (`server/main.go:269-300`), so a host that exports one silently reconfigures
// this fixture. Two of them are not cosmetic: `planMail` REFUSES to boot
// `dev-log-links` alongside any `RELAYIUM_SMTP_ADDR`, and refuses a
// `RELAYIUM_BASE_URL` that is not provably local
// (`server/mailconfig.go:76-92`, `server/mailconfig.go:135-166`). On a
// developer machine that is a confusing boot failure; on a machine configured
// for real mail it is worse than that. So the child gets the OS environment
// with every `RELAYIUM_*` key removed, the one variable this run means to set,
// and an explicit loopback `-base-url` that `requireLocalBaseURL` accepts by
// construction.
//
// ## Running it
//
//   npm run build && node test/smoke/inbox-server-acceptance.mjs
//
// `npm run build` is a precondition, not an optional step: this drives the
// COMPILED product out of `dist/main`, and a missing `dist` is reported as a
// setup failure rather than a product result.
//
// Controls, each of which must make the run fail:
//
//   INTEROP_CONTROL=early    stop after the devices exist; the completeness
//                            count must report the checks that were NOT made
//   INTEROP_CONTROL=noKill   skip the termination; the run must report an
//                            unjoined child, retain the temporary root, and
//                            exit non-zero rather than claiming a clean pass
//   INTEROP_KEEP=1           keep the temporary root for inspection
import { spawn } from "node:child_process";
import { register } from "node:module";
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { buildServerForFixture, testDiskUsageWithOverlay } from "./server-platform.mjs";

const WINDOWS = process.platform === "win32";

/**
 * Both roots come from this file's own location.
 *
 * `test/smoke/` is two levels below the app and four below the repository, and
 * `resident-smoke.mjs` already resolves its cwd the same way. A hardcoded
 * absolute path would make this script runnable on exactly one machine, which
 * is the property this port exists to remove.
 */
const APP = fileURLToPath(new URL("../..", import.meta.url));
const REPO = fileURLToPath(new URL("../../../..", import.meta.url));
const SERVER_SRC = join(REPO, "server");
const DIST = join(APP, "dist", "main");

/** `CreateProcess` appends no extension for a name that already has none on the
 *  POSIX side, and the Go toolchain is `go.exe` on Windows. Named explicitly so
 *  neither lookup depends on a shell. */
const GO = WINDOWS ? "go.exe" : "go";
const SERVER_BIN = WINDOWS ? "relayium-server.exe" : "relayium-server";

/**
 * Every check this run is expected to make.
 *
 * Asserted at the end. Several steps guard work that cannot proceed, and each
 * early `return` would otherwise leave the remaining checks unmade while the run
 * still exited 0. The count is the difference between "everything passed" and
 * "everything that ran passed".
 *
 * It is the accepted harness's count, unchanged: this port adds no assertion and
 * removes none, so a divergence here is a real divergence in what was proven.
 */
const EXPECTED_CHECKS = 43;

const RUN_BUDGET_MS = 10 * 60 * 1000;
const OP_BUDGET_MS = 60 * 1000;
const CLOSE_BUDGET_MS = 2 * 1000;
// A cold Windows runner compiles the whole server module tree from scratch.
const BUILD_BUDGET_MS = 8 * 60 * 1000;
const START_BUDGET_MS = 60 * 1000;
/** A ceiling on any single body this run reads. The largest real one here is a
 *  few chunks; the cap exists so a pathological response cannot hold a CI
 *  runner open until the job timeout, where a deadline alone would still be
 *  refreshed by a body that keeps trickling. */
const BODY_BUDGET_BYTES = 64 * 1024 * 1024;
/** How much of the server log is read looking for the verification link. */
const LOG_BUDGET_BYTES = 8 * 1024 * 1024;
/** How much of the log is quoted into a failure detail. */
const LOG_EXCERPT_CHARS = 1200;

const steps = [];
const cleanupFindings = [];
let failures = 0;

const step = (name, ok, detail = "") => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
  if (!ok) failures += 1;
};

const runDeadline = new AbortController();
const runTimer = setTimeout(() => runDeadline.abort(), RUN_BUDGET_MS);

const opSignal = (ms = OP_BUDGET_MS) => AbortSignal.any([runDeadline.signal, AbortSignal.timeout(ms)]);

const children = [];

/** Track a child and subscribe to `close` AT SPAWN, so a fast exit is not raced. */
function track(child, label) {
  let exited = false;
  const closed = new Promise((resolve) => {
    child.once("close", () => { exited = true; resolve("closed"); });
    child.once("error", () => {
      if (child.pid === undefined) { exited = true; resolve("never-spawned"); }
    });
  });
  const entry = { child, label, closed, get exited() { return exited; } };
  children.push(entry);
  return entry;
}

async function raceClose(closed, ms) {
  let timer;
  try {
    return await Promise.race([
      closed,
      new Promise((r) => {
        timer = setTimeout(() => r("pending"), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Kill every child and WAIT for each to be OBSERVED closed.
 *
 * SIGTERM, a bounded wait, then SIGKILL and a second one. A child that did not
 * close may still hold the database and the blob directory, so a timeout here is
 * a finding and the caller keeps the temp root: removing it under a live child
 * is how a cleanup manufactures its own errors and hides the real outcome.
 *
 * On Windows there are no signals: `subprocess.kill()` is `TerminateProcess`
 * whatever name is passed, so the escalation below collapses into a single
 * forced termination. That is deliberate and it changes nothing that matters
 * here — the OBSERVED `close` is what this function reports, not the call that
 * asked for it. Each child is reached by its own handle: never by name, never
 * by pattern, and never as a process tree, so nothing outside this fixture can
 * be caught by it.
 */
async function stopChildren() {
  const outcomes = [];
  // `INTEROP_CONTROL=noKill` is the control that proves the join is real: with
  // the kill skipped, the run must report an unjoined child, retain the temp
  // root and exit non-zero rather than reporting a clean pass.
  const skipKill = process.env.INTEROP_CONTROL === "noKill";
  for (const entry of children) {
    try {
      if (!skipKill) entry.child.kill("SIGTERM");
    } catch { /* already gone */ }
    let state = await raceClose(entry.closed, CLOSE_BUDGET_MS);
    if (state === "pending") {
      try {
        if (!skipKill) entry.child.kill("SIGKILL");
      } catch { /* already gone */ }
      state = await raceClose(entry.closed, CLOSE_BUDGET_MS);
    }
    if (state === "pending") {
      // Not a claim it is gone: it converts a hang into an observable failure.
      entry.child.unref?.();
      cleanupFindings.push(`${entry.label} (pid ${entry.child.pid ?? "-"}) did not close`);
    }
    outcomes.push(`${entry.label}(pid ${entry.child.pid ?? "-"}):${state}`);
  }
  // The PIDs are in the line so a CI log proves afterwards which processes this
  // run owned, and that each of them was joined.
  console.log(`-- children joined: ${outcomes.join(", ") || "none"}`);
  return cleanupFindings.length === 0;
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

/**
 * The child's environment: the host's, minus everything that could reconfigure
 * the server behind the flags below. See the header.
 */
function serverEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Windows environment names are case-insensitive, hence the flag.
    if (/^RELAYIUM_/i.test(key)) continue;
    if (value !== undefined) env[key] = value;
  }
  env.RELAYIUM_RELEASE_CHECK = "false";
  return env;
}

/** Read a body with a byte ceiling as well as the caller's deadline. */
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

/** The tail of a file, capped, without loading a log of unknown size. */
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

/** A memory-backed `SecretStore`, for the receiver's real key store. */
class MemorySecrets {
  constructor() {
    this.store = new Map();
  }
  get(key) {
    const value = this.store.get(key);
    if (value === undefined) {
      const err = new Error("not-found");
      err.name = "SecretStoreError";
      err.code = "not-found";
      return Promise.reject(err);
    }
    return Promise.resolve(value);
  }
  put(key, value) {
    this.store.set(key, value);
    return Promise.resolve();
  }
  putIfAbsent(key, value) {
    if (this.store.has(key)) return Promise.resolve({ created: false });
    this.store.set(key, value);
    return Promise.resolve({ created: true });
  }
  delete(key) {
    this.store.delete(key);
    return Promise.resolve();
  }
}

const logFdRef = { handle: null };
/** How this run's server binary was produced. Reported, never inferred. */
let serverProvenance = null;

/**
 * Build the server this run drives.
 *
 * A build failure is a SETUP failure, not a product result, and it is raised
 * with the compiler's own words: the top-level handler below turns it into a
 * reported failure and a non-zero exit with the completeness count intact, so
 * nothing is silently skipped by it.
 */
async function buildServer(bin, taskRoot) {
  const built = await buildServerForFixture({
    repoRoot: REPO, taskRoot, outPath: bin, timeoutMs: BUILD_BUDGET_MS,
    // The build's child belongs to THIS run's registry, so it is listed and
    // joined by the same `stopChildren` every other child goes through.
    register: (child, label) => track(child, label),
  });
  if (built.unjoined) {
    // Never removed under a live child: an unjoined build process is a cleanup
    // finding, and the caller retains its task root.
    cleanupFindings.push(`${built.ledger.label} (pid ${built.ledger.pid ?? "-"}) did not close`);
  }
  if (!built.ok) {
    const said = (built.stderr || built.stdout || `exit ${built.code}`).trim();
    throw new Error(`SETUP: building the server from ${SERVER_SRC} failed: ${said.slice(0, 4000)}`);
  }
  // Named in the run's own output: a Windows run compiles the real handlers
  // with ONE file overlaid, and a reader must not have to infer that.
  console.log(`-- server build: ${JSON.stringify(built.provenance)}`);
  return built.provenance;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "inbox-sender-"));
  let keepRoot = false;
  try {
    // ---- the platform positive, BEFORE the build depends on it -----------
    //
    // On Windows the server is compiled with one file overlaid, so the overlay's
    // own correctness is a precondition of everything below. The package's real
    // `TestDiskUsage` runs first, against the replacement, as an owned and
    // joined child. On a host that needs no overlay this reports SKIPPED — the
    // product file is what runs there and the package's own tests cover it.
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
    serverProvenance = await buildServer(bin, root);
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    await mkdir(join(root, "blobs"), { recursive: true });
    await mkdir(join(root, "static"), { recursive: true });
    const logPath = join(root, "server.log");
    const logFd = await open(logPath, "a");
    logFdRef.handle = logFd;
    const server = track(
      spawn(
        bin,
        [
          "-addr", `127.0.0.1:${port}`, "-db", join(root, "relayium.db"),
          "-blob-dir", join(root, "blobs"), "-static", join(root, "static"),
          // Explicit and loopback: `dev-log-links` refuses a base URL it cannot
          // prove is local, and the default would describe a port nothing here
          // is listening on.
          "-base-url", origin,
          "-stun-urls", "stun:127.0.0.1:3478", "-mail-transport", "dev-log-links",
        ],
        { env: serverEnv(), stdio: ["ignore", logFd.fd, logFd.fd] },
      ),
      "server",
    );

    let up = false;
    const startDeadline = Date.now() + START_BUDGET_MS;
    while (Date.now() < startDeadline) {
      // A server that exited is never going to answer. Without this the loop
      // would spend its whole budget probing a dead port and report a timeout,
      // which on a platform this has never run on is the least useful thing it
      // could say.
      if (server.exited) break;
      try {
        const r = await fetch(`${origin}/api/config`, { signal: opSignal(5_000) });
        if (r.ok) { up = true; break; }
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    step("real server listening", up, up
      ? origin
      : `${origin}; exited=${server.exited}; log tail: ${
        (await readTail(logPath, LOG_BUDGET_BYTES).catch((e) => String(e))).slice(-LOG_EXCERPT_CHARS)}`);
    if (!up) return;

    // ---- compiled modules, real crypto ------------------------------------
    const load = (rel) => import(pathToFileURL(join(DIST, rel)).href);
    const runtime = (await load("inbox-runtime.js")).default;
    const { SendCoordinator } = await load("inbox/send-coordinator.js");
    const { SendPlanStore } = await load("inbox/send-plan.js");
    const { SendTransport } = await load("inbox/send-transport.js");
    const { DeviceTaskByteTransport } = await load("inbox/send-bytes.js");
    const { buildSendManifest, encodeSendManifest } = await load("inbox/send-manifest.js");
    const { UploadTransport } = await load("stored/upload/transport.js");
    const { UploadEngine } = await load("stored/upload/engine.js");
    const { Fence } = await load("stored/upload/authority.js");
    const { planUpload } = await load("stored/upload/plan.js");
    const { captureAccount } = await load("inbox/account.js");
    const { newAtRestKeyBytes } = await load("inbox/atrest.js");
    const { InboxKeyStore } = await load("inbox/keys.js");
    const { InboxApi } = await load("inbox/api.js");

    // ---- account, two devices, enrolment, a REAL device key ---------------
    const email = `send-${randomBytes(4).toString("hex")}@example.invalid`;
    const password = randomBytes(24).toString("hex");
    const call = async (method, path, body, bearer) => {
      const headers = {};
      if (body !== undefined) headers["content-type"] = "application/json";
      if (bearer) headers.authorization = `Bearer ${bearer}`;
      const res = await fetch(`${origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: opSignal(),
      });
      const text = (await collectBounded(res.body, `${method} ${path}`)).toString("utf8");
      let json;
      try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, json };
    };

    await call("POST", "/api/auth/register", { email, password });
    const verifyToken = /verify-email\?token=([0-9a-f]+)/.exec(await readTail(logPath, LOG_BUDGET_BYTES))?.[1];
    step("synthetic account verified", Boolean(verifyToken));
    if (!verifyToken) return;
    await call("POST", "/api/auth/email/verify", { token: verifyToken, password });

    const recv = await call("POST", "/api/auth/native/login", { email, password, deviceName: "windows-target" });
    const send = await call("POST", "/api/auth/native/login", { email, password, deviceName: "windows-sender" });
    const recvToken = recv.json?.token;
    const sendToken = send.json?.token;
    const recvID = (await call("GET", "/api/devices", undefined, recvToken)).json?.devices?.find((d) => d.Current)?.ID;
    const sendID = (await call("GET", "/api/devices", undefined, sendToken)).json?.devices?.find((d) => d.Current)?.ID;
    step("two devices, two bearers", Boolean(recvID && sendID && recvID !== sendID));
    if (!recvID || !sendID) return;
    // `INTEROP_CONTROL=early` is the control that proves the completeness
    // assertion: an early return here must report how many checks were NOT made
    // and exit non-zero, where a harness without the count would exit 0.
    if (process.env.INTEROP_CONTROL === "early") return;

    const recvContext = captureAccount({
      accountID: email, deviceID: recvID, epoch: 1, inboxRoot: join(root, "target", "inbox"),
    });
    const keys = new InboxKeyStore(recvContext, new MemorySecrets(), runtime);
    const keyRecord = await keys.append(Date.now());
    await call("PUT", `/api/devices/${recvID}/inbox`, {
      platform: "windows", appVersion: "0.0.1-sender-interop",
      protocolVersions: [runtime.constants.protocolVersion],
      capabilities: [runtime.constants.capReceiveV3, runtime.constants.capTextV1],
      autoAccept: "ask", receiveDirReady: true,
    }, recvToken);
    const registered = await call("POST", `/api/devices/${recvID}/inbox/keys`,
      { algorithm: runtime.constants.keyAlgorithm, publicKey: keyRecord.publicKey }, recvToken);
    const serverKey = registered.json?.key;
    step("target enrolled with a real X25519 key", Boolean(serverKey?.ID), `keyID ${serverKey?.ID ?? "-"}`);
    if (!serverKey?.ID) return;
    await keys.bindKeyID(keyRecord.publicKey, serverKey.ID);

    // ---- the compiled sender ----------------------------------------------
    const planDir = join(root, "sender", "inbox");
    const senderContext = captureAccount({
      accountID: email, deviceID: sendID, epoch: 1, inboxRoot: planDir,
    });
    const planFiles = {
      readFile: (path) => readFile(path),
      writeAtomic: async (path, bytes) => {
        const tmp = `${path}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, path);
      },
      mkdirp: async (path) => { await mkdir(path, { recursive: true }); },
    };
    // One at-rest key for the whole run, from the real generator: every plan in
    // this run is sealed and reopened exactly as the product does it.
    const planKey = newAtRestKeyBytes();
    const plans = new SendPlanStore(
      senderContext, planFiles, () => Promise.resolve(planKey), runtime.constants.sealedBoxBytes,
    );
    const tasks = new SendTransport({ context: { origin, bearer: sendToken, epoch: 1 } });
    const geometry = {
      storeChunkSize: runtime.constants.storeChunkSize,
      frameOverhead: runtime.constants.frameOverhead,
    };
    const authority = {
      accountId: email, deviceId: sendID, documentId: "harness-doc", origin, bearer: sendToken,
    };

    /** Per-job material the callbacks need. Never persisted, never logged. */
    const jobs = new Map();

    const coordinator = new SendCoordinator({
      accountId: email,
      deviceId: sendID,
      plans,
      tasks,
      bytesFor: () => new DeviceTaskByteTransport(new UploadTransport(origin, sendToken), origin, sendToken),
      engineFor: (jobID, bytes, fence, onSession) => {
        const job = jobs.get(jobID);
        return UploadEngine.open({
          runtime, key: job.storeKey, sealedManifest: job.sealedManifest, plan: job.uploadPlan,
          retention: { burnAfterRead: false, ttlSeconds: 3600 },
          transport: bytes, fence, hooks: { onSession },
        });
      },
      sealToTarget: (jobID, target) =>
        runtime.sealContentKey(jobs.get(jobID).contentKey, target.key.algorithm, target.key.publicKey),
      // Deliberately no `releaseObject`: `handleDeleteFile` refuses a
      // task-purpose object, and central's own collector reclaims it.
      runtimeCaps: {
        receiveV3: runtime.constants.capReceiveV3,
        textV1: runtime.constants.capTextV1,
        keyAlgorithm: runtime.constants.keyAlgorithm,
      },
      protocolVersion: runtime.constants.protocolVersion,
      retention: { burnAfterRead: false, ttlSeconds: 3600 },
    });

    /**
     * Stage one job from REAL content.
     *
     * `items` are `{ path, bytes }`. Everything below is the shared code: the
     * canonical v3 encoder, the frame-0 seal, and the schedule `planUpload`
     * derives from the same geometry the encryptor uses.
     */
    async function stageJob(jobID, items, kind = "file") {
      const contentKey = randomBytes(runtime.constants.contentKeyBytes);
      const storeKey = await runtime.importStoreKey(contentKey);
      const descriptors = items.map((item) => ({ relativePath: item.path, size: item.bytes.length }));
      const manifest = kind === "text"
        ? buildSendManifest(runtime, "text", [{ relativePath: "", size: items[0].bytes.length }])
        : buildSendManifest(runtime, "file", descriptors);
      const manifestBytes = encodeSendManifest(runtime, manifest);
      const sealedManifest = await runtime.sealManifestBytes(storeKey, manifestBytes);
      const planned = planUpload(descriptors.map((d) => ({ path: d.relativePath, size: d.size })), geometry);
      if (!planned.ok) throw new Error(`plan refused: ${JSON.stringify(planned.refusal)}`);
      // Node `File`s over the real bytes. `encryptFiles` touches only `.size`
      // and `.slice().arrayBuffer()`, so this is the SAME call the renderer
      // makes, with the same objects it would make it with.
      const files = items.map((item) => new File([item.bytes], item.path));
      jobs.set(jobID, {
        contentKey, storeKey, sealedManifest, manifestBytes, files, items, kind,
        uploadPlan: planned.plan,
        digest: sha256(sealedManifest),
        frames: [],
      });
      return jobs.get(jobID);
    }

    /**
     * Drive the engine from the PRODUCTION encryptor.
     *
     * The frames come out of the shared `encryptFiles`; the engine independently
     * checks each one against the schedule it derived from sizes alone, so the
     * two agreeing is itself evidence that `plan.ts` and the encryptor have not
     * drifted.
     */
    const feedFor = (jobID) => async (engine) => {
      const job = jobs.get(jobID);
      for await (const frame of runtime.encryptFiles(job.files, job.storeKey)) {
        const next = engine.expects;
        if (next === null) throw new Error("the encryptor produced a frame the schedule did not owe");
        job.frames.push(frame);
        await engine.feed({ fileIndex: next.fileIndex, seq: next.seq, bytes: frame });
      }
      if (engine.expects !== null) throw new Error("the encryptor owed more frames than it produced");
    };

    /** Decrypt a downloaded blob back to plaintext through the SHARED decryptor. */
    async function decryptPayload(contentKey, ciphertext, expectedBytes) {
      const decryptor = runtime.createStoreDecryptor(await runtime.importStoreKey(contentKey));
      const parts = [];
      for await (const part of decryptor.push(ciphertext)) parts.push(Buffer.from(part));
      for await (const part of decryptor.end(expectedBytes)) parts.push(Buffer.from(part));
      return Buffer.concat(parts);
    }

    /** The BLOB this job produced: the payload frames, in order. Frame 0 is not
     *  in it — the sealed manifest travels in the init body. */
    const payloadBytes = (job) => Buffer.concat(job.frames.map(Buffer.from));

    // ---- content this run actually sends --------------------------------
    const chunk = runtime.constants.storeChunkSize;
    /** Deterministic filler: `crypto.getRandomValues` caps at 65536 bytes. */
    const filled = (n, seed) => {
      const out = Buffer.alloc(n);
      for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed) & 0xff;
      return out;
    };
    const MESSAGE = "你好 — Relayium ✅ nested/folder message";

    // A nested folder, an empty leading entry, a file that CROSSES a chunk
    // boundary by exactly one byte, and a short tail. Paths carry `/`, which is
    // how a folder keeps its shape in a v3 manifest — and, deliberately, NOT
    // the host separator: a manifest path is wire data, not a filesystem path,
    // and it must be identical on both platforms.
    const folderItems = [
      { path: "docs/empty.txt", bytes: Buffer.alloc(0) },
      { path: "docs/notes/deep/report.bin", bytes: filled(chunk + 1, 7) },
      { path: "docs/notes/tail.txt", bytes: Buffer.from("tail — ünïcode", "utf8") },
    ];

    // ---- 1. create a real nested-folder delivery -------------------------
    const folderJob = "job-folder";
    const folderMaterial = await stageJob(folderJob, folderItems);
    const folderOutcome = await coordinator.deliver({
      jobID: folderJob, targetDeviceID: recvID, kind: "file",
      idempotencyKey: `idem-${folderJob}`, manifestDigest: folderMaterial.digest, authority,
    }, feedFor(folderJob)).done;
    step("a real nested-folder delivery created a task",
      folderOutcome.kind === "delivered" && folderOutcome.created === true,
      `${folderOutcome.kind} ${folderOutcome.task?.ID ?? "-"}`);
    if (folderOutcome.kind !== "delivered") return;
    const folderTaskID = folderOutcome.task.ID;

    // The shared encryptor's own total is what `?size=` declared, and the
    // schedule `plan.ts` derived from sizes alone agrees with both.
    step("the shared encryptor, the plan and the server agree on the exact size",
      runtime.cipherSizeFor(folderMaterial.files) === folderMaterial.uploadPlan.cipherBytes &&
      folderOutcome.task.CiphertextBytes === folderMaterial.uploadPlan.cipherBytes,
      `${folderOutcome.task.CiphertextBytes} bytes`);
    step("the chunk-crossing file produced two frames and the empty one none",
      folderMaterial.uploadPlan.frames[0].frameCount === 0 &&
      folderMaterial.uploadPlan.frames[1].frameCount === 2 &&
      folderMaterial.frames.length === folderMaterial.uploadPlan.frameCount,
      `${folderMaterial.frames.length} frames`);
    step("the task object is invisible to the account's file list",
      ((await call("GET", "/api/files", undefined, sendToken)).json?.files ?? []).length === 0);
    step("central REFUSES a client-side delete of a task object",
      (await call("DELETE", `/api/files/${folderOutcome.task.StoredFileID}`, undefined, sendToken)).status === 404);

    // ---- 2. receive it, and DECRYPT the content --------------------------
    const recvApi = new InboxApi({ context: { origin, bearer: recvToken, deviceID: recvID, epoch: 1 } });
    await call("POST", `/api/devices/${recvID}/inbox/tasks/${folderTaskID}/accept`, { accept: true }, recvToken);
    const claimed = await recvApi.claim(4, opSignal());
    const delivery = claimed.deliveries.find((d) => d.ID === folderTaskID);
    step("the target claimed the delivery", Boolean(delivery), `${claimed.deliveries.length} claimed`);
    if (!delivery) return;

    const opened = await keys.openSealedContentKey(serverKey.ID, runtime.decodeKey(delivery.WrappedKey));
    step("the sealed key opened to the SAME content key",
      Buffer.from(opened).equals(Buffer.from(folderMaterial.contentKey)));

    const manifestBack = runtime.decodeInboxManifest(
      await runtime.openManifestBytes(await runtime.importStoreKey(opened), Buffer.from(delivery.EncManifest, "base64")),
    );
    step("the manifest carried the NESTED PATHS unchanged",
      JSON.stringify(manifestBack.items.map((i) => i.name)) ===
        JSON.stringify(folderItems.map((i) => i.path)),
      JSON.stringify(manifestBack.items.map((i) => i.name)));

    const stream = await recvApi.blob(folderTaskID, delivery.ClaimToken, 0, delivery.CiphertextBytes, opSignal());
    const downloaded = await collectBounded(stream.body, `blob ${folderTaskID}`);
    const expectedPlain = Buffer.concat(folderItems.map((i) => i.bytes));
    const plaintext = await decryptPayload(opened, downloaded, expectedPlain.length);
    step("the payload DECRYPTED to the exact bytes that were sent",
      plaintext.equals(expectedPlain), `${plaintext.length} bytes, sha256 ${sha256(plaintext)}`);

    // Split by the manifest's declared sizes — which is how a receiver does it,
    // there being no per-file delimiter in the frame stream.
    let at = 0;
    const perFile = manifestBack.items.map((item) => {
      const slice = plaintext.subarray(at, at + item.size);
      at += item.size;
      return slice;
    });
    step("every file's bytes landed under its own declared path",
      perFile.every((slice, i) => slice.equals(folderItems[i].bytes)) && at === expectedPlain.length,
      `${perFile.length} files`);
    step("the chunk-crossing file survived the boundary exactly",
      perFile[1].length === chunk + 1 && perFile[1].equals(folderItems[1].bytes),
      `${perFile[1].length} bytes`);

    await recvApi.report(folderTaskID, delivery.ClaimToken, "downloading", false, "", opSignal());
    await recvApi.report(folderTaskID, delivery.ClaimToken, "verifying", false, "", opSignal());
    const saved = await recvApi.report(folderTaskID, delivery.ClaimToken, "saved", true, "", opSignal());
    step("the target reported saved through the real state machine",
      saved.State === "saved" && saved.Terminal === true, `savedAt ${saved.SavedAt}`);

    // ---- 3. retry converges, never a second task -------------------------
    coordinator.release(folderJob);
    const retry = await coordinator.resume(folderJob, authority).done;
    step("a retry read the recorded task instead of creating another",
      retry.kind === "delivered" && retry.created === false && retry.task.ID === folderTaskID,
      `${retry.kind} ${retry.task?.ID ?? "-"} state ${retry.task?.State ?? "-"}`);
    step("central still holds exactly one task for that key",
      ((await call("GET", `/api/devices/${recvID}/inbox/tasks?limit=100`, undefined, sendToken)).json?.tasks ?? [])
        .filter((t) => t.IdempotencyKey === `idem-${folderJob}`).length === 1);

    // ---- 4. a real UTF-8 TEXT delivery -----------------------------------
    const textJob = "job-text";
    const textBody = Buffer.from(MESSAGE, "utf8");
    const textMaterial = await stageJob(textJob, [{ path: "message", bytes: textBody }], "text");
    const textOutcome = await coordinator.deliver({
      jobID: textJob, targetDeviceID: recvID, kind: "text",
      idempotencyKey: `idem-${textJob}`, manifestDigest: textMaterial.digest, authority,
    }, feedFor(textJob)).done;
    step("a real text delivery created a task",
      textOutcome.kind === "delivered" && textOutcome.created === true,
      `${textOutcome.kind} ${textOutcome.task?.ID ?? "-"}`);
    if (textOutcome.kind !== "delivered") return;

    await call("POST", `/api/devices/${recvID}/inbox/tasks/${textOutcome.task.ID}/accept`, { accept: true }, recvToken);
    const textClaim = await recvApi.claim(4, opSignal());
    const textDelivery = textClaim.deliveries.find((d) => d.ID === textOutcome.task.ID);
    step("the target claimed the message", Boolean(textDelivery));
    if (!textDelivery) return;
    const textKey = await keys.openSealedContentKey(serverKey.ID, runtime.decodeKey(textDelivery.WrappedKey));
    const textManifestBack = runtime.decodeInboxManifest(
      await runtime.openManifestBytes(await runtime.importStoreKey(textKey), Buffer.from(textDelivery.EncManifest, "base64")),
    );
    step("its manifest is ONE text item declaring UTF-8 BYTES and no name",
      textManifestBack.items.length === 1 && textManifestBack.items[0].kind === "text" &&
      textManifestBack.items[0].size === textBody.length && textManifestBack.items[0].name === undefined,
      `${textBody.length} bytes for ${MESSAGE.length} characters`);
    const textStream = await recvApi.blob(textOutcome.task.ID, textDelivery.ClaimToken, 0, textDelivery.CiphertextBytes, opSignal());
    const textPlain = await decryptPayload(
      textKey, await collectBounded(textStream.body, `blob ${textOutcome.task.ID}`), textBody.length);
    step("the MESSAGE decrypted back, byte for byte and character for character",
      textPlain.equals(textBody) && textPlain.toString("utf8") === MESSAGE,
      JSON.stringify(textPlain.toString("utf8")));

    // ---- 5. the exact request is what converges --------------------------
    const persisted = await plans.find(textJob);
    const duplicate = await call("POST", `/api/devices/${recvID}/inbox/tasks`, {
      idempotencyKey: persisted.idempotencyKey, storedFileId: persisted.storedObjectID,
      protocolVersion: runtime.constants.protocolVersion, wrapAlgorithm: runtime.constants.keyAlgorithm,
      wrappedKey: persisted.wrappedKey, targetKeyId: persisted.targetKeyID,
      targetKeyGeneration: persisted.targetKeyGeneration,
    }, sendToken);
    step("the identical request converges on 200 {created:false}",
      duplicate.status === 200 && duplicate.json?.created === false &&
      duplicate.json?.task?.ID === textOutcome.task.ID,
      `status ${duplicate.status} created ${String(duplicate.json?.created)}`);
    const conflicting = await call("POST", `/api/devices/${recvID}/inbox/tasks`, {
      idempotencyKey: persisted.idempotencyKey, storedFileId: folderOutcome.task.StoredFileID,
      protocolVersion: runtime.constants.protocolVersion, wrapAlgorithm: runtime.constants.keyAlgorithm,
      wrappedKey: persisted.wrappedKey, targetKeyId: persisted.targetKeyID,
      targetKeyGeneration: persisted.targetKeyGeneration,
    }, sendToken);
    step("a CHANGED request under the same key is refused",
      conflicting.status === 409 && conflicting.json?.error === "idempotency_key_conflict",
      `status ${conflicting.status} ${conflicting.json?.error ?? "-"}`);

    // ---- 6. cancel is refused while a receiver holds the lease -----------
    const inProgress = await coordinator.cancel(textJob);
    step("a claimed delivery refuses cancellation, and says why",
      inProgress.kind === "refused" && inProgress.reason === "task_in_progress" && inProgress.retryable === true,
      `${inProgress.kind}:${inProgress.reason ?? "-"}`);
    step("the claimed task and its plan are untouched",
      (await call("GET", `/api/devices/${recvID}/inbox/tasks/${textOutcome.task.ID}`, undefined, sendToken)).status === 200 &&
      (await plans.find(textJob))?.phase === "created");

    // ---- 7. cancel a delivery nobody has claimed -------------------------
    const cancelJob = "job-cancel";
    const cancelMaterial = await stageJob(cancelJob, [{ path: "one.bin", bytes: filled(2048, 11) }]);
    const cancelOutcome = await coordinator.deliver({
      jobID: cancelJob, targetDeviceID: recvID, kind: "file",
      idempotencyKey: `idem-${cancelJob}`, manifestDigest: cancelMaterial.digest, authority,
    }, feedFor(cancelJob)).done;
    step("a third delivery was created for the cancel case", cancelOutcome.kind === "delivered",
      `${cancelOutcome.kind} ${cancelOutcome.task?.ID ?? "-"}`);
    if (cancelOutcome.kind !== "delivered") return;
    const cancelObjectID = cancelOutcome.task.StoredFileID;
    const cancelled = await coordinator.cancel(cancelJob);
    step("cancel reported a cancellation", cancelled.kind === "cancelled", `${cancelled.kind}`);
    step("the cancelled task is gone from central",
      (await call("GET", `/api/devices/${recvID}/inbox/tasks/${cancelOutcome.task.ID}`, undefined, sendToken)).status === 404);
    const rebind = await call("POST", `/api/devices/${recvID}/inbox/tasks`, {
      idempotencyKey: `idem-${cancelJob}-rebind`, storedFileId: cancelObjectID,
      protocolVersion: runtime.constants.protocolVersion, wrapAlgorithm: runtime.constants.keyAlgorithm,
      wrappedKey: (await plans.find(cancelJob)).wrappedKey,
      targetKeyId: serverKey.ID, targetKeyGeneration: serverKey.Generation,
    }, sendToken);
    step("its ciphertext went with it",
      rebind.status === 409 && rebind.json?.error === "stored_object_unavailable",
      `status ${rebind.status} ${rebind.json?.error ?? "-"}`);

    // ---- 8. cancel racing terminality ------------------------------------
    const raced = await coordinator.cancel(folderJob, authority);
    step("cancelling a saved delivery reports it delivered, not cancelled",
      raced.kind === "delivered" && raced.task?.State === "saved",
      `${raced.kind} state ${raced.task?.State ?? "-"}`);
    step("and the saved task row was NOT deleted",
      (await call("GET", `/api/devices/${recvID}/inbox/tasks/${folderTaskID}`, undefined, sendToken)).status === 200);

    // ---- 8b. eligibility refuses before a byte moves ---------------------
    await call("PUT", `/api/devices/${recvID}/inbox`, {
      platform: "windows", appVersion: "0.0.1-sender-interop",
      protocolVersions: [runtime.constants.protocolVersion],
      capabilities: [runtime.constants.capReceiveV3, runtime.constants.capTextV1],
      autoAccept: "off", receiveDirReady: true,
    }, recvToken);
    const offJob = "job-off";
    const offMaterial = await stageJob(offJob, [{ path: "never.bin", bytes: filled(16, 13) }]);
    const refused = await coordinator.deliver({
      jobID: offJob, targetDeviceID: recvID, kind: "file",
      idempotencyKey: `idem-${offJob}`, manifestDigest: offMaterial.digest, authority,
    }, feedFor(offJob)).done;
    step("a target with receiving off is refused before any upload",
      refused.kind === "refused" && refused.reason === "auto_receive_disabled" && offMaterial.frames.length === 0,
      `${refused.kind}:${refused.reason ?? "-"}`);
    step("and nothing was staged for it", (await plans.find(offJob)) === null);

    // ---- 9. the lifecycle a host awaits ----------------------------------
    coordinator.fence();
    step("fencing closes admissions without cancelling anything",
      coordinator.admitting === false && coordinator.fenceOf(folderJob) !== null);
    coordinator.resumeAdmissions();
    // A document revocation is per-job and remembered, so a job cannot be
    // re-admitted into a document that no longer exists.
    // The cancel lands FIRST, so the fence's first reason is `cancelled` and a
    // later document revocation can never appear in it. Teardown must still be
    // refused, which only a registry check can decide.
    await coordinator.cancel(folderJob);
    const docDrain = await coordinator.invalidateDocument("harness-doc");
    let reAdmitted = true;
    try {
      coordinator.deliver({
        jobID: "job-readmit", targetDeviceID: recvID, kind: "file",
        idempotencyKey: "idem-readmit", manifestDigest: "d", authority,
      }, feedFor("job-readmit"));
    } catch {
      reAdmitted = false;
    }
    let teardownRefused = false;
    try {
      coordinator.cleanup(folderJob);
    } catch (e) {
      teardownRefused = /document-revoked/.test(String(e?.message ?? e));
    }
    step("a revoked document is remembered, and its drain reports honestly",
      docDrain.quiet === true && docDrain.remembered === true && reAdmitted === false,
      `quiet ${String(docDrain.quiet)} remembered ${String(docDrain.remembered)}`);
    step("teardown is refused for a job CANCELLED BEFORE its document was revoked",
      teardownRefused && coordinator.fenceOf(folderJob).reason === "cancelled",
      `first reason ${coordinator.fenceOf(folderJob).reason}`);
    await coordinator.quiesce();
    step("quiesce returned actually quiet", coordinator.quiet === true);
    await coordinator.dispose();
    step("the coordinator disposed with nothing left running", coordinator.isLive(folderJob) === false);

    // ---- a STORED LINK, minted here and opened by the shipping receiver ----
    //
    // The Device Inbox above proves the shared upload engine, its transport,
    // its fence and its planner against this server. What it does not touch is
    // the stored-LINK lifecycle: a key that lives in a URL fragment, a manifest
    // in the stored shape rather than the inbox one, and the download-and-
    // decrypt path a person reaches by opening a link somebody sent them.
    //
    // Everything below is the shipping code. The key comes from the stored
    // runtime's own `generateKey`, so the fragment is encoded the way the
    // product encodes it; the manifest is sealed by `sealManifest`; the link is
    // assembled from `downloadPrefix`; and it is opened by `receiveStoredLink`,
    // which parses it with the shipping parser rather than a split here.
    //
    // `hosts` is the one override, and the receive module documents it as
    // tests-only: without it a loopback origin is not a trusted link host, which
    // is the correct production rule and would refuse this harness's own server.
    {
      // `build-mode.ts` reads `app.isPackaged` at module scope and `origin.ts`
      // imports it, so every module under `stored/**` needs an `electron`
      // specifier to resolve before it loads. Registered HERE, immediately
      // before those imports, and scoped to that one specifier — see
      // `electron-host-loader.mjs`. No product module is replaced.
      register("./electron-host-loader.mjs", import.meta.url);
      const storedRt = await (await load("stored/runtime.js")).storedRuntime();
      const { receiveStoredLink } = await load("stored/receive.js");
      const { StoredTransport } = await load("stored/transport.js");

      const storedRoot = join(root, "stored-landing");
      await mkdir(storedRoot, { recursive: true });
      const payload = Buffer.from("stored-link round trip \u2014 \u4e2d\u6587 \u2014 " + randomBytes(48).toString("hex"));
      const { key: storeKey, encoded: fragment } = await storedRt.generateKey();
      const manifest = { files: [{ name: "round-trip.txt", size: payload.length }] };
      const sealedManifest = await storedRt.sealManifest(storeKey, manifest);
      const planned = planUpload([{ path: "round-trip.txt", size: payload.length }], geometry);
      if (!planned.ok) throw new Error(`stored plan refused: ${JSON.stringify(planned.refusal)}`);

      // The renderer's own encoder over the same key. Main never encrypts for a
      // stored send — the page does — so this is where that side is stood in
      // for, and it is the SAME shared implementation, not a second one.
      const engine = await UploadEngine.open({
        runtime, key: storeKey, sealedManifest, plan: planned.plan,
        retention: { burnAfterRead: false, ttlSeconds: 3600 },
        transport: new UploadTransport(origin, sendToken), fence: new Fence(),
      });
      for await (const frame of runtime.encryptFiles([new File([payload], "round-trip.txt")], storeKey)) {
        // The engine is fed a FRAME, not bytes: it checks the sequence and the
        // file index it derived from sizes alone against what the encryptor
        // actually produced, and the two agreeing is the point.
        const owed = engine.expects;
        if (owed === null) throw new Error("the stored encryptor produced a frame the schedule did not owe");
        await engine.feed({ fileIndex: owed.fileIndex, seq: owed.seq, bytes: frame });
      }
      if (engine.expects !== null) throw new Error("the stored encryptor owed more frames than it produced");
      const published = await engine.end();
      step("a stored object publishes against the real server",
        published.status === "published" && typeof published.objectId === "string" && published.objectId.length > 0,
        JSON.stringify(published).slice(0, 200));
      if (published.status !== "published") throw new Error("stored upload did not publish");

      // ## The `relayium://` form, and why it is the right one here
      //
      // A stored link is `https://<trusted host>/d/<id>#k=…` or
      // `relayium://d/<id>#k=…`, and the parser accepts no other scheme and no
      // https port but 443 — correctly, since anything on the machine can hand
      // this app a link. A loopback `http://127.0.0.1:PORT/...` therefore cannot
      // parse and MUST not: loosening that to reach this server would be testing
      // a rule the product does not have.
      //
      // The custom-scheme form carries no host at all, so it needs no override:
      // it is a genuine product link, and the TRANSPORT is what points at this
      // run's server. Nothing tests-only remains in this round trip.
      const link = `relayium://d/${published.objectId}#k=${fragment}`;

      // The destination is a plain writer: what is under test here is the LINK
      // and the decryption, and the native writer has its own Windows proof.
      // The host is asked for a destination and answers with a root it owns.
      // Anonymous: a public link carries no bearer, which is the whole reason
      // opening one needs no account.
      const storedAuthority = {
        grant: async () => ({ rootPath: storedRoot, authorityId: "harness-stored" }),
      };
      const landed = new Map();
      const destination = async (request) => {
        const files = request.manifest.map((entry) => entry.name ?? entry.relativePath);
        const open = new Map();
        return {
          fileCount: files.length,
          assertAuthority: () => undefined,
          begin: async (index) => { open.set(index, []); },
          write: async (index, chunk) => { open.get(index).push(Buffer.from(chunk)); },
          finish: async (index) => { landed.set(files[index], Buffer.concat(open.get(index))); },
          publish: async () => ({ status: "complete", publishedCount: files.length, total: files.length }),
          cancel: async () => undefined,
        };
      };

      const report = await receiveStoredLink({
        link,
        authority: storedAuthority,
        transport: new StoredTransport(origin),
        destination,
        runtime: async () => storedRt,
      });
      step("the shipping receiver opens a link minted in this run",
        report.status === "saved" || report.status === "complete",
        JSON.stringify(report).slice(0, 240));

      // The whole point: the bytes that come back are the bytes that went in,
      // through a key that never left the fragment.
      const got = landed.get("round-trip.txt");
      step("the plaintext survives the round trip byte for byte",
        got !== undefined && Buffer.compare(got, payload) === 0,
        got === undefined ? "nothing landed" : `${got.length} vs ${payload.length}`);

      // A link whose fragment has been altered must NOT open. Without this the
      // case above would pass for a transport that ignored the key entirely.
      // A DIFFERENT key, minted the same way, rather than a mutated string: a
      // corrupted encoding is refused by the parser, which would prove nothing
      // about whether the receiver actually uses the key.
      const { encoded: wrongFragment } = await storedRt.generateKey();
      const refused = await receiveStoredLink({
        link: `relayium://d/${published.objectId}#k=${wrongFragment}`,
        authority: storedAuthority,
        transport: new StoredTransport(origin),
        destination,
        runtime: async () => storedRt,
      }).catch((e) => ({ status: "threw", reason: String(e?.message ?? e) }));
      // It must fail for the RIGHT reason. `link-invalid` here would mean the
      // link was rejected before the key mattered, and the case would pass for
      // a receiver that never decrypted anything.
      const tamperCode = refused?.failure?.code ?? refused?.status;
      step("a link with a tampered key does not open, and fails on the KEY",
        refused.status !== "saved" && refused.status !== "complete"
          && tamperCode !== "link-invalid",
        JSON.stringify(refused).slice(0, 220));
    }
  } finally {
    clearTimeout(runTimer);
    const allClosed = await stopChildren();
    await logFdRef.handle?.close().catch(() => undefined);
    if (!allClosed) {
      keepRoot = true;
      cleanupFindings.push("temp root retained under an unjoined child");
    }
    if (!keepRoot && process.env.INTEROP_KEEP !== "1") {
      // The retries are for Windows, where a handle the OS has not finished
      // releasing answers EBUSY/EPERM for a moment after the process is gone.
      // A failure is still REPORTED: this does not claim to have removed a path
      // it could not remove.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .catch((e) => cleanupFindings.push(String(e)));
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
  step("harness completed without throwing", false, String(error?.stack ?? error));
}
const complete = steps.length >= EXPECTED_CHECKS;
step("harness completeness", complete, `ran ${steps.length} of ${EXPECTED_CHECKS}`);
console.log(JSON.stringify({
  platform: process.platform,
  serverBuild: serverProvenance,
  expected: EXPECTED_CHECKS,
  ran: steps.length,
  failures,
  cleanupFindings,
  threw: threw === null ? null : String(threw?.message ?? threw),
  steps,
}, null, 2));
process.exit(failures === 0 && cleanupFindings.length === 0 ? 0 : 1);
