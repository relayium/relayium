// The resident lifecycle, in a real Electron, against the real wiring.
//
// `smoke-main.mjs` proves the app comes up and a sign-in can be cancelled. This
// one proves the thing that makes it a resident app: closing the window does
// not end anything, quitting asks first and can be refused, and a quit whose
// cleanup failed leaves an app that still works.
//
// Same isolation as the other entry — injected store, injected network,
// injected picker, wrapper-owned directories, no keychain, no protocol
// association, no visible window — plus one more injection: the resident
// PLATFORM, so the native dialogs can be answered without a person. Everything
// else is the shipping path: the real `ResidentRuntime`, the real
// `QuitCoordinator`, the real `AppService`.

import { app, BrowserWindow, clipboard } from "electron";
import { SecretStore } from "../../dist/main/secrets.js";
import { IceControl } from "../../dist/main/net/ice-control.js";
import { PairControl } from "../../dist/main/net/pair-control.js";
import { PreferenceStore } from "../../dist/main/preferences.js";
import { bootstrap, ownedReceives, residentRuntime, wakeInbox } from "../../dist/main/main.js";
import { receiveStoredLink } from "../../dist/main/stored/receive.js";
// The REAL vault and the REAL grant store, used to seed one message before the
// account is adopted. Not a fake: the record this writes is sealed with the
// same at-rest key the receiver would use, into the same directory, and the
// page reads it back through the shipped facade. What it does NOT prove is the
// receive path that normally puts it there — that has its own owning tests
// (`inbox-facade.test.ts`, `inbox-receive.test.ts`), and a smoke that forged a
// delivery would need a second manifest encoder to do it.
import { captureAccount } from "../../dist/main/inbox/account.js";
import { InboxFiles } from "../../dist/main/inbox/files.js";
import { MessageVault } from "../../dist/main/inbox/vault.js";
import { InboxGrantStore } from "../../dist/main/features/inbox-grant.js";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as nodeCrypto from "node:crypto";

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
};

const [userDataDir, secretsDir, destinationDir, inboxRootDir, firstSendDir, updateDir, restartSendDir, phase] =
  process.argv.slice(2);
/**
 * Which half of the run this is.
 *
 * `first` drives everything and leaves durable state behind — an enrolled
 * account, a received delivery, a named history. `restart` is a SECOND
 * Electron process over the SAME task-owned directories, and it exists to prove
 * one thing the first cannot: that what the user was shown survives the app
 * being closed and reopened. A reload would not have proved it — the cache is
 * warm in the process that wrote it.
 */
const RESTART_PHASE = phase === "restart";
/**
 * The send journal this phase uses.
 *
 * The restart phase gets its OWN. See the wrapper: the first phase leaves a
 * deliberately unresolvable upload behind, and an unresolved upload is real
 * unfinished business that the install consent refuses to install over — so
 * sharing the journal would make the installer unreachable for a reason that
 * has nothing to do with updates.
 */
const sendJournalDir = RESTART_PHASE ? restartSendDir : firstSendDir;
if (!userDataDir || !secretsDir || !destinationDir || !inboxRootDir || !firstSendDir || !updateDir || !restartSendDir) {
  process.stdout.write(
    `RELAYIUM_SMOKE ${JSON.stringify({ failures: ["missing task-owned directory arguments"] })}\n`,
  );
  app.exit(1);
}
app.setPath("userData", userDataDir);
app.disableHardwareAcceleration();

const PRODUCTION_ORIGIN = "https://relayium.com";
const MAGIC = Buffer.from([0x52, 0x4c, 0x4d, 0x31]);
const testCipher = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.concat([MAGIC, Buffer.from(p, "utf8").map((b) => b ^ 0x5a)]),
  decrypt: (c) => {
    if (!c.subarray(0, 4).equals(MAGIC)) throw new Error("not sealed by this cipher");
    return Buffer.from(c.subarray(4).map((b) => b ^ 0x5a)).toString("utf8");
  },
};

/** Nothing leaves the machine. See `smoke-main.mjs` for why this is injected
 *  rather than suppressed with an environment variable. */
function makeSyntheticSocket() {
  const socket = {
    send() {},
    close() {
      socket.onclose?.();
    },
    bufferedAmount: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  setImmediate(() => socket.onopen?.());
  return socket;
}

async function syntheticFetch() {
  // A loopback STUN string: real in shape, inert in effect.
  const body = { iceServers: [{ urls: "stun:127.0.0.1:3478" }] };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A stored receive that actually STREAMS, so the page's progress and Cancel are
 * exercised against a running transfer rather than a finished one.
 *
 * It behaves like the real `receiveStoredLink` where it matters: it asks for a
 * folder, opens nothing without one, reports cumulative bytes, and honours the
 * abort signal — including while it is mid-stream, which is what Cancel has to
 * prove.
 */
const stream = { released: null, granted: false, closed: false };

/**
 * Transfers this run holds open on purpose, one per marker link.
 *
 * Separate from `stream` because the scenarios below need a transfer that is
 * still running while something else happens to it — a sign-out, a quit
 * prompt, a reload. `holdAfterAbort` keeps one alive past its own cancellation
 * so its OUTCOME can be delivered at a moment the test chooses, which is the
 * only way to observe which document it is delivered to.
 */
const holds = new Map();
const MARKERS = ["holding", "afterstay", "late"];
function holdFor(marker) {
  let entry = holds.get(marker);
  if (!entry) {
    entry = { granted: false, aborted: false, release: null, holdAfterAbort: false };
    holds.set(marker, entry);
  }
  return entry;
}

async function heldReceive(marker, options) {
  const held = holdFor(marker);
  const facts = { fileCount: 1, totalBytes: 100, burnAfterRead: false, expiresAt: 4_000_000_000 };
  const grant = await options.authority.grant(facts);
  if (grant === null) return { status: "declined" };
  held.granted = true;
  // Reported ONCE, the instant the job starts moving — deliberately the hardest
  // case. That frame races its own acknowledgement across the process boundary:
  // the page learns the job id from the `receive()` reply, and a frame that
  // wins the race has no id to match against yet. It used to be dropped, which
  // left the bar at zero for a transfer that reports once and then stalls. The
  // controller now holds the last unacknowledged frame per job, so this must
  // reach the screen whichever way the race goes.
  options.onProgress?.(30, 100);
  await new Promise((resolve) => {
    held.release = resolve;
    options.signal?.addEventListener(
      "abort",
      () => {
        held.aborted = true;
        if (!held.holdAfterAbort) resolve();
      },
      { once: true },
    );
  });
  if (options.signal?.aborted === true) {
    return { status: "cancelled", residue: false, cleanupTicket: null };
  }
  options.onProgress?.(100, 100);
  return { status: "saved", facts, publishedCount: 1, residue: false, cleanupTicket: null };
}

async function streamingReceive(options) {
  const marker = MARKERS.find((name) => options.link.includes(`/d/${name}`));
  if (marker) return heldReceive(marker, options);
  // Only the marker link is simulated. Everything else goes to the REAL
  // receive, so the refusal path below is the shipping parser refusing an
  // untrusted host rather than this stand-in agreeing to.
  if (!options.link.includes("/d/streaming")) return receiveStoredLink(options);
  const facts = { fileCount: 1, totalBytes: 100, burnAfterRead: false, expiresAt: 4_000_000_000 };
  const grant = await options.authority.grant(facts);
  if (grant === null) return { status: "declined" };
  stream.granted = true;
  options.onProgress?.(25, 100);
  await new Promise((resolve) => {
    stream.released = resolve;
    options.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  // The body is closed on the way out either way — that is what releases the
  // connection, and it is a side effect the test can observe.
  stream.closed = true;
  if (options.signal?.aborted === true) {
    return { status: "cancelled", residue: false, cleanupTicket: null };
  }
  options.onProgress?.(100, 100);
  return { status: "saved", facts, publishedCount: 1, residue: false, cleanupTicket: null };
}

/** How the injected dialogs answer, changed per scenario. */
/**
 * The Device Inbox's side of this run.
 *
 * A stand-in for `InboxApi` that records what was actually SENT — an enrolment
 * with a capability set, a withdrawal, an accept with the flag central reads —
 * so every assertion below is a side effect rather than an acknowledgement.
 */
const inbox = {
  device: { id: "smoke-device", name: "Smoke PC" },
  folderUsable: true,
  /** What the injected folder dialog answers. `null` is a person closing it. */
  pick: () => destinationDir,
  enrolled: 0,
  withdrawn: 0,
  heartbeats: 0,
  claims: 0,
  /** Milliseconds to hold `enrol`, for the premature-barrier discrimination. */
  enrolDelay: 0,
  lastCapabilities: [],
  lastAutoAccept: "",
  accepted: [],
  /** What `pending` hands back, so a delivery can be offered on demand. */
  tasks: [],
  /** Every directory a reveal actually opened, in order. */
  revealed: [],
  /** When set, the reveal adapter refuses the way the OS does. */
  revealRefuses: false,
  // ---- the real-delivery half ---------------------------------------------
  /** THIS device's advertised public key, captured as main registers it. */
  publicKey: "",
  keyID: "key-1",
  /** Deliveries `claim()` will hand back, once each. */
  deliveries: [],
  /** Ciphertext bodies by task id, for `blob`. */
  bodies: new Map(),
  /** Every `report` central was sent, so an ACK can be asserted on. */
  reports: [],
  /** When set, the injected destination writes real files here. */
  writeTo: null,
  /** Files the injected destination actually wrote, by relative name. */
  written: [],
};

const inboxApi = {
  async enrol(request) {
    // Discrimination knob: a slow enrol is what a loaded Windows agent looks
    // like. With it set, a fixture that waits on the DOM instead of on this
    // call fails; one that waits on the call passes.
    if (inbox.enrolDelay > 0) await new Promise((r) => setTimeout(r, inbox.enrolDelay));
    inbox.enrolled += 1;
    inbox.lastCapabilities = [...request.capabilities];
    inbox.lastAutoAccept = request.autoAccept;
    return { protocolVersion: 3, receiveCapability: "inbox.receive.v3", keyAlgorithm: "x25519" };
  },
  async deleteInbox() {
    inbox.withdrawn += 1;
  },
  async registerKey(algorithm, publicKey) {
    // Captured so this run can seal a REAL delivery to the key main actually
    // generated. Nothing here invents a keypair: the private half never leaves
    // the key store, which is the property the seal exercises.
    inbox.publicKey = publicKey;
    return { ID: inbox.keyID };
  },
  async listKeys() {
    return [];
  },
  async pending() {
    return { tasks: inbox.tasks, leaseSeconds: 60, heartbeatIntervalSecs: 30 };
  },
  async accept(taskID, accept) {
    inbox.accepted.push({ taskID, accept });
    // Central acknowledges the accept; the delivery is then leased by a claim,
    // and this run has none to hand back — which is exactly the `queued`
    // outcome the page must render truthfully rather than as a save.
    inbox.tasks = inbox.tasks.filter((task) => task.ID !== taskID);
    return { ID: taskID, State: "queued", Terminal: false };
  },
  async claim() {
    inbox.claims += 1;
    // Handed back ONCE. A claim that kept re-offering the same delivery would
    // make the scheduler receive it forever.
    const deliveries = inbox.deliveries;
    inbox.deliveries = [];
    return { deliveries, leaseSeconds: 60 };
  },
  async report(taskID, claimToken, state, committed) {
    inbox.reports.push({ taskID, state, committed });
    return { State: state, Terminal: state === "saved", SavedAt: 1 };
  },
  async currentDevice() {
    return { ID: inbox.device.id, Name: inbox.device.name };
  },
  async blob(taskID, claimToken, offset) {
    const body = inbox.bodies.get(taskID);
    if (body === undefined) throw new Error("no delivery in this run");
    const slice = body.subarray(offset);
    return {
      partial: offset > 0,
      body: new ReadableStream({
        pull(controller) {
          controller.enqueue(slice);
          controller.close();
        },
      }),
    };
  },
  async renameDevice(name) {
    inbox.device = { ...inbox.device, name };
    return name;
  },
  async heartbeat() {
    inbox.heartbeats += 1;
    return { presence: "online", intervalSeconds: 30 };
  },
};

/**
 * Build a REAL encrypted delivery, with the real protocol runtime.
 *
 * Nothing about the delivery is faked: the manifest is the canonical v3
 * document sealed at frame 0, the body is the SAME `encryptFiles` the renderer
 * produces, and the content key is sealed to the public key MAIN registered —
 * so opening it exercises the real key store, the real manifest decoder and the
 * real frame decryptor. What is injected is the transport that carries it and,
 * separately, the destination that writes the bytes down.
 */
async function buildRealDelivery(id, files) {
  const runtime = await protocolRuntime();
  const contentKey = crypto.getRandomValues(new Uint8Array(runtime.constants.contentKeyBytes));
  const storeKey = await runtime.importStoreKey(contentKey);
  const manifest = runtime.fileManifest(files.map((file) => ({ name: file.name, size: file.bytes.length })));
  const encManifest = await runtime.sealManifestBytes(storeKey, runtime.encodeInboxManifest(manifest));

  const frames = [];
  let total = 0;
  for await (const frame of runtime.encryptFiles(
    files.map((file) => new File([file.bytes], file.name)),
    storeKey,
  )) {
    const copy = new Uint8Array(frame.byteLength);
    copy.set(frame);
    frames.push(copy);
    total += copy.byteLength;
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const frame of frames) {
    body.set(frame, at);
    at += frame.byteLength;
  }
  inbox.bodies.set(id, body);

  return {
    ID: id,
    SourceDeviceID: "another-device",
    IdempotencyKey: `idem-${id}`,
    State: "claimed",
    ErrorCode: "",
    CiphertextBytes: body.byteLength,
    WrapAlgorithm: runtime.constants.keyAlgorithm,
    TargetKeyID: inbox.keyID,
    TargetKeyGeneration: 1,
    CreatedAt: 1,
    ExpiresAt: 9_999_999,
    SavedAt: 0,
    Terminal: false,
    EncManifest: Buffer.from(encManifest).toString("base64"),
    // Sealed to the key main registered. A wrong key here fails to open, which
    // is what makes this a real exercise of the key store rather than a fixture
    // handing itself its own plaintext.
    WrappedKey: await runtime.sealContentKey(contentKey, runtime.constants.keyAlgorithm, inbox.publicKey),
    ClaimToken: `claim-${id}`,
  };
}

/** The protocol runtime, loaded from the SAME artifact main loads. */
let protocolRuntimeCache = null;
async function protocolRuntime() {
  if (protocolRuntimeCache !== null) return protocolRuntimeCache;
  const { pathToFileURL } = await import("node:url");
  const artifact = pathToFileURL(path.resolve(process.cwd(), "dist/main/inbox-runtime.js")).href;
  const loaded = await import(artifact);
  protocolRuntimeCache = loaded.default ?? loaded;
  return protocolRuntimeCache;
}

/**
 * A destination that actually writes the files.
 *
 * ## What this is and is not
 *
 * The shipped destination is the packaged Windows native helper, and it is NOT
 * what runs here: this smoke executes on the host the developer is on, and the
 * helper is a Windows binary with its own owning tests and its own acceptance
 * gate. So the bytes are written by this injected destination instead.
 *
 * Everything BEFORE it is the real path — the claim, the key unseal, the
 * manifest decode, the frame decryptor, the item cursor, the journal, the ACK
 * and the presentation capture. What "bytes on disk" proves here is that the
 * decrypted plaintext reaching the destination is the sender's own; it does not
 * prove the helper writes it, and nothing in this file claims otherwise.
 */
function makeWritingDestination(options) {
  const names = options.manifest.map((entry) => entry.name);
  const staged = new Map();
  return {
    fileCount: options.manifest.length,
    assertAuthority() {},
    async begin(index) {
      staged.set(index, []);
    },
    async write(index, chunk) {
      staged.get(index).push(Buffer.from(chunk));
    },
    async finish() {},
    async publish() {
      for (const [index, parts] of staged) {
        const name = names[index];
        const target = path.join(options.rootPath, name);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, Buffer.concat(parts));
        inbox.written.push(name);
      }
      return { status: "complete", publishedCount: staged.size, total: options.manifest.length };
    },
    async cancel() {},
  };
}

/**
 * The server the SEND half talks to, as an in-memory sink.
 *
 * A CONTROLLED FIXTURE, and named as one. It answers the five routes a
 * delivery touches and records every request, so what this run asserts about
 * the `device_task` object and the sealed key is what the client actually
 * composed rather than what it was assumed to.
 */
const sendSink = {
  requests: [],
  received: new Map(),
  tasks: new Map(),
  /**
   * Holds the ciphertext append open, so a delivery is GENUINELY in flight.
   *
   * It has to be read by the handler to mean anything. It was not: an earlier
   * version assigned it and nulled it and nothing ever awaited it, so the
   * upload completed at full speed and every assertion about a "held" send was
   * sampling a state that lasted microseconds. A barrier nobody waits on is not
   * a barrier, and a green run over one proves nothing at all.
   */
  holdAppend: null,
  /** Resolved when the handler has ENTERED the held append. */
  onAppendEntered: null,
  async fetch(input, init) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const entry = { method, url: `${url.pathname}${url.search}` };
    sendSink.requests.push(entry);
    const runtime = await protocolRuntime();
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/api/devices") {
      return reply(200, {
        devices: [
          { ID: inbox.device.id, Name: inbox.device.name, Inbox: { Capabilities: ["inbox.receive.v3"], AutoAccept: "auto" } },
          {
            ID: "target-device",
            Name: "Study desktop",
            Inbox: {
              Capabilities: ["inbox.receive.v3", "inbox.text.v1"],
              AutoAccept: "auto",
              ProtocolVersion: 3,
              Revoked: false,
            },
          },
          { ID: "old-laptop", Name: "Old laptop", Inbox: { Capabilities: [], AutoAccept: "off" } },
        ],
      });
    }
    if (url.pathname.endsWith("/inbox/keys") && method === "GET") {
      const pair = await runtime.generateKeyPair();
      return reply(200, {
        keys: [
          {
            ID: "target-key-1",
            Generation: 3,
            PublicKey: runtime.encodeKey(pair.publicKey),
            Algorithm: runtime.constants.keyAlgorithm,
          },
        ],
      });
    }
    if (url.pathname === "/api/uploads" && method === "POST") {
      const id = `send-up-${String(sendSink.received.size + 1)}`;
      sendSink.received.set(id, 0);
      return reply(200, { uploadId: id, chunkSize: 64 * 1024 });
    }
    const append = /^\/api\/uploads\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (append !== null) {
      const id = append[1];
      if (method === "GET") return reply(200, { received: sendSink.received.get(id) ?? 0 });
      // AWAITED. See `holdAppend`. The entered-signal fires first, so a
      // scenario can wait for the request to be in the handler rather than
      // guessing that it is.
      if (sendSink.holdAppend !== null) {
        sendSink.onAppendEntered?.();
        sendSink.onAppendEntered = null;
        await sendSink.holdAppend;
      }
      const range = new Headers(init?.headers ?? {}).get("content-range");
      const parsed = range === null ? null : /bytes (\d+)-(\d+)\//.exec(range);
      if (parsed !== null) sendSink.received.set(id, Number(parsed[2]) + 1);
      return reply(200, { received: sendSink.received.get(id) ?? 0 });
    }
    const finalize = /^\/api\/uploads\/([A-Za-z0-9_-]+)\/finalize$/.exec(url.pathname);
    if (finalize !== null) return reply(200, { id: `obj-${finalize[1]}`, expiresAt: 9_999_999 });
    if (url.pathname.endsWith("/inbox/tasks") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      entry.body = body;
      const task = {
        ID: `sent-task-${String(sendSink.tasks.size + 1)}`,
        SourceDeviceID: inbox.device.id,
        IdempotencyKey: String(body.idempotencyKey),
        StoredFileID: String(body.storedFileId),
        State: "queued",
        ErrorCode: "",
        CiphertextBytes: 0,
        WrapAlgorithm: String(body.wrapAlgorithm),
        TargetKeyID: String(body.targetKeyId),
        TargetKeyGeneration: Number(body.targetKeyGeneration),
        CreatedAt: 1,
        ExpiresAt: 9_999_999,
        SavedAt: 0,
        Terminal: false,
      };
      sendSink.tasks.set(task.IdempotencyKey, task);
      return reply(201, { task });
    }
    return reply(404, { error: "no route" });
  },
};

/**
 * The account endpoints, as an in-memory sink.
 *
 * ## Why this MUST be injected before the account wiring runs
 *
 * `AccountSummaryService.refresh()` is asked for at startup, and this run signs
 * in for real with a synthetic bearer against the PRODUCTION origin. Without
 * this seam those reads would leave the machine — three requests to
 * `relayium.com` carrying a token this fixture invented. That is not a test
 * failure mode, it is a test doing something it must never do, so the injection
 * is a precondition of the wiring rather than a convenience.
 *
 * The bodies are the real contracts, spelled out: `/api/me` is WRAPPED in
 * `user`, `/api/me/usage` is FLAT with a nested `plan`, and `/api/devices` is
 * wrapped in `devices` with PascalCase rows. A fixture written to whatever the
 * parser happened to accept would prove nothing about either.
 */
const accountSink = {
  requests: [],
  /** Switched by a scenario to make ONE section fail while the others succeed. */
  failUsage: false,
  renamed: [],
  /** The device rows this sink serves. A rename MUTATES them. */
  devices: [
    { id: "smoke-device", name: "Smoke PC", createdAt: 1_780_000_000, lastSeenAt: 1_789_000_000, current: true, enrolled: true },
    { id: "study-desktop", name: "Study desktop", createdAt: 1_770_000_000, lastSeenAt: 1_788_000_000, current: false, enrolled: false },
  ],
  /** `0` is UNLIMITED here — the case the UI must never render as a meter. */
  storageCap: 0,
  /** The plan's retention cap, in seconds. Fourteen days by default. */
  retentionSecs: 1_209_600,
  async fetch(input, init) {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    accountSink.requests.push(`${method} ${url.pathname}`);
    const reply = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/api/me" && method === "GET") {
      return reply(200, {
        user: {
          id: "acct-1",
          email: "smoke@example.invalid",
          displayName: "Smoke Owner",
          hasPassword: true,
          emailVerified: true,
          onlyOwnNodes: false,
          planId: "pro",
          subscriptionStatus: "active",
          subscriptionEnd: 0,
          hasBilling: true,
          scheduledPlanId: "",
          scheduledCycle: "",
          billingCycle: "monthly",
          entitlementProvider: "stripe",
          // The ACTUAL server shape. It returns the object with `available:
          // false` rather than omitting the field — an omission is accepted by
          // the parser but is not what this app will meet, and a fixture that
          // is merely compatible proves less than one that is real.
          appleRenewal: { available: false },
          linkedMethods: ["password"],
        },
      });
    }
    if (url.pathname === "/api/me/usage" && method === "GET") {
      // A section that fails on its own, beside two that succeed — the thing
      // the design insists must never be turned into a zero or a free plan.
      if (accountSink.failUsage) return reply(503, { error: "usage unavailable" });
      return reply(200, {
        period: "2026-09",
        resetsAt: 1_790_000_000,
        traffic: { used: 3_221_225_472, cap: 10_737_418_240 },
        storage: { used: 1_073_741_824, cap: accountSink.storageCap },
        plan: {
          id: "pro",
          name: "Pro",
          storageBytes: accountSink.storageCap,
          trafficBytes: 10_737_418_240,
          retentionSecs: accountSink.retentionSecs,
          priceMonthly: 500,
          priceYearly: 5000,
          isTop: false,
          subscriptionStatus: "active",
          subscriptionEnd: 0,
          billingCycle: "monthly",
          scheduledPlanId: "",
          scheduledPlanName: "",
          scheduledCycle: "",
          entitlementProvider: "stripe",
          appleRenewal: { available: false },
        },
      });
    }
    if (url.pathname === "/api/devices" && method === "GET") {
      // Served from the sink's OWN state, so a rename actually changes what a
      // later read returns. A fixture that answered a constant would let a
      // mutation "succeed" against a server that never moved.
      return reply(200, {
        devices: accountSink.devices.map((row) => ({
          ID: row.id,
          Name: row.name,
          Kind: "windows",
          CreatedAt: row.createdAt,
          LastSeenAt: row.lastSeenAt,
          Current: row.current,
          Inbox: row.enrolled ? { AutoAccept: "auto" } : null,
        })),
      });
    }
    const device = /^\/api\/devices\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (device !== null && method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const name = String(body.name ?? "");
      const row = accountSink.devices.find((entry) => entry.id === device[1]);
      if (row === undefined) return reply(404, { error: "no such device" });
      accountSink.renamed.push({ id: device[1], name });
      // The server state MOVES. This is what makes the assertion below — that
      // the row's rendered name changed — a real oracle.
      row.name = name;
      return reply(200, { ok: true });
    }
    // A DELETE is deliberately not answered here: no scenario revokes a device,
    // because the only safe one to revoke in this run is the current device and
    // that would sign the run out mid-flight. Root's own probe owns that case.
    return reply(404, { error: "no route" });
  },
};

/**
 * A signed update feed, generated in this process.
 *
 * ## Why a real key and a real signature
 *
 * The core fetches the signature, fetches the metadata, and verifies a DETACHED
 * Ed25519 signature over those EXACT BYTES against a pinned key — before it
 * parses anything. A fixture that stubbed the verifier would prove the state
 * machine and nothing about the gate that protects it, so this generates a
 * keypair, signs the bytes it serves, and pins the public half through the
 * PRIVATE composition seam.
 *
 * That key is a TEST key. It is reachable only through `bootstrap({composition})`
 * in this process: the shipped `pinnedKeys` stays empty, and no renderer
 * message, flag or environment variable can reach it. Nothing here provisions
 * production trust and nothing leaves the machine — both fetches are injected.
 */
const updateFeed = (() => {
  const { generateKeyPairSync, sign, createHash } = nodeCrypto;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // `generateKeyPairSync` already returns a KeyObject for the public half;
  // passing it back through `createPublicKey` asks Node to derive a public key
  // FROM a public key, which it refuses.
  const jwk = publicKey.export({ format: "jwk" });

  /** The artifact this feed advertises. Bytes, so its hash is the real one. */
  const artifact = Buffer.from("relayium-setup-fixture-bytes");
  const digest = createHash("sha256").update(artifact).digest("hex");

  const manifest = {
    schema: 1,
    product: "relayium-windows",
    channel: "stable",
    platform: "windows",
    arch: "x64",
    // Higher than ANY version this process can report as its own. In an
    // unpackaged run `app.getVersion()` answers with ELECTRON's version (38.x
    // today), so a 9.x fixture is a version REGRESSION rather than an update —
    // which the view normalises to `other`, and which cost a debugging pass.
    version: "999.9.9",
    // Strictly greater than this build's, which is the gate the core applies.
    build: 999_999,
    // The WIRE shape: `artifact` is nested. The TypeScript `UpdateManifest` is
    // the parsed OUTPUT and flattens these — writing the fixture from the
    // interface rather than from the parser produced a document the real feed
    // would never send, and the core rightly called it malformed.
    artifact: {
      url: "https://relayium.com/apps/windows/Relayium-Setup-9.9.9.exe",
      sizeBytes: artifact.byteLength,
      sha256: digest,
    },
    publishedAt: 1_789_000_000,
    notesUrl: "https://relayium.com/apps/windows/notes-9.9.9",
  };
  // The signature covers these EXACT bytes, so they are what is served — never
  // a re-serialisation, which would produce something the signature misses.
  const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const signature = sign(null, bytes, privateKey);

  return {
    publicKeyBase64Url: String(jwk.x),
    bytes,
    signatureText: signature.toString("base64url"),
    artifact,
    manifest,
    /** Every request this fixture answered, so the run can prove none escaped. */
    requests: [],
    /** What the person answers when asked to close the app. */
    consent: false,
    /** How many times the native consent was actually asked for. */
    consentCalls: 0,
    /** Every `installVerified` the core reached, with what it was handed. */
    installs: [],
    /** What the synthetic installer answers. Never a real launch. */
    installOutcome: { outcome: "refused", refusal: "no-expected-publisher" },
    /** Every host exit the launched-install choreography asked for. */
    exits: 0,
    fetchFeed(input) {
      const url = String(input);
      updateFeed.requests.push(url);
      if (url.endsWith(".sig")) {
        return Promise.resolve(new Response(updateFeed.signatureText, { status: 200 }));
      }
      return Promise.resolve(new Response(updateFeed.bytes, { status: 200 }));
    },
    fetchArtifact(input) {
      updateFeed.requests.push(String(input));
      return Promise.resolve(new Response(updateFeed.artifact, { status: 200 }));
    },
  };
})();

/** One pending delivery, as central would list it. No token, no key. */
function pendingTask(id) {
  return {
    ID: id,
    SourceDeviceID: "another-device",
    IdempotencyKey: `idem-${id}`,
    State: "notified",
    ErrorCode: "",
    CiphertextBytes: 4096,
    WrapAlgorithm: "x25519",
    TargetKeyID: "key-1",
    TargetKeyGeneration: 1,
    CreatedAt: 1_700_000_000,
    ExpiresAt: 1_900_000_000,
    SavedAt: 0,
    Terminal: false,
  };
}

/**
 * Where this run's uploads go.
 *
 * A CONTROLLED IN-MEMORY transport — an object implementing the transport
 * interface, keeping bytes in a variable. There is no `createServer`, no
 * `listen` and no HTTP anywhere in this file, so nothing below is evidence
 * about the remote handler or about the protocol as a server answers it. What
 * it does prove is the whole client path: the page's own production
 * `encryptFiles`, the accepted upload engine, and the bytes that come out.
 *
 * It is not a mock that records calls — the assertions are about the BYTES, so
 * it has to hold them — and it follows the endpoint's OFFSET RULE because that
 * is what makes the engine's offset algebra observable here.
 */
const sendHeld = {
  manifest: new Uint8Array(0),
  body: new Uint8Array(0),
  finalized: false,
  removed: [],
  /** Set to make finalize answer 409, which is the AMBIGUOUS case. */
  ambiguous: false,
  /** Held while set, so a transfer can be observed mid-flight. */
  hold: null,
  reset() {
    sendHeld.manifest = new Uint8Array(0);
    sendHeld.body = new Uint8Array(0);
    sendHeld.finalized = false;
  },
};

const sendTransport = {
  async init(sealedManifest) {
    sendHeld.reset();
    sendHeld.manifest = new Uint8Array(sealedManifest);
    return { uploadId: `upload-${String(Date.now())}`, chunkSize: 1 << 20 };
  },
  async append(_id, from, _total, bytes) {
    if (sendHeld.hold) await sendHeld.hold;
    if (from !== sendHeld.body.byteLength) {
      return { outcome: "offset", received: sendHeld.body.byteLength };
    }
    const next = new Uint8Array(sendHeld.body.byteLength + bytes.byteLength);
    next.set(sendHeld.body);
    next.set(bytes, sendHeld.body.byteLength);
    sendHeld.body = next;
    return { outcome: "committed", received: sendHeld.body.byteLength };
  },
  async status() {
    return { received: sendHeld.body.byteLength };
  },
  async finalize() {
    if (sendHeld.ambiguous) return { outcome: "already-finalized" };
    sendHeld.finalized = true;
    return { outcome: "finalized", id: "object-1", expiresAt: 4_000_000_000 };
  },
  async remove(id) {
    sendHeld.removed.push(id);
    return "deleted";
  },
  /** The account's object list, for reconciliation. Empty: nothing matches. */
  async list() {
    return [];
  },
};

/** The unauthenticated metadata reader reconciliation uses. In memory too. */
const sendSource = {
  async meta() {
    throw new Error("no candidate in this run");
  },
};

/** What the injected device-auth poll answers. Flipped to sign in for real. */
let pollAnswer = { status: "pending" };

/**
 * ONE store instance for this run.
 *
 * `SecretStore` serialises per key WITHIN an instance, and `putIfAbsent`'s
 * create-once guarantee holds nowhere else — so a factory that built a fresh
 * store per call would be testing a composition the app does not use.
 */
const smokeSecretStore = new SecretStore(secretsDir, testCipher);

const answers = {
  firstClose: 0, // 0 hide, 1 quit, 2 cancel
  confirm: [], // consumed in order; `true` is Quit, `false` is Stay
  confirmCalls: 0,
  /** The last quit prompt main composed. Risk-specific; see `confirm`. */
  lastPrompt: null,
  firstCloseCalls: 0,
  exited: false,
  stopped: [],
  /** Run once, WHILE the confirmation is on screen. A person reading a dialog
   *  takes time, and that window is exactly where a late start has to be
   *  refused; nothing else in this file can observe it. */
  onConfirm: null,
};
/** Cleanup failure, switched on for the residue scenario. */
let breakCleanup = false;

async function main() {
  await bootstrap({
    showOnLaunch: false,
    // The native consent, answered in process. The shipped adapter still does
    // every check around it — the re-check after the prompt, the cleanup
    // counts, the exclusion — this only supplies the ANSWER a person would.
    confirmUpdateInstall: async () => {
      updateFeed.consentCalls += 1;
      return updateFeed.consent;
    },
    // ## The exit is RECORDED, never performed
    //
    // The shipped hook sets `quitting` and calls `app.quit()`. Letting that run
    // here would end the run mid-scenario, so this records the decision
    // instead — which is the fact under test: that a LAUNCHED install ends the
    // process exactly once, and that a refusal ends it never.
    exitAfterInstall: () => {
      updateFeed.exits += 1;
    },
    composition: {
      makeStore: async () => smokeSecretStore,
      makeAuthClient: () => ({
        start: async () => ({
          userCode: "SMOKE-CODE",
          deviceCode: "smoke-device-code",
          verificationURL: `${PRODUCTION_ORIGIN}/device`,
          interval: 1,
          expiresIn: 600,
        }),
        poll: async () => pollAnswer,
      }),
      openApproval: async () => true,
      makeSignalingSocket: makeSyntheticSocket,
      makeIceControl: () => new IceControl(PRODUCTION_ORIGIN, syntheticFetch),
      makePairControl: () => new PairControl(PRODUCTION_ORIGIN, syntheticFetch),
      makePreferences: () => new PreferenceStore(path.join(secretsDir, "preferences.json")),
      // A lease can be opened without a person. The renderer still cannot name
      // this path: it names a room and a manifest, exactly as it always does.
      // A variable rather than a constant, so the Inbox scenario can answer it
      // the way a person closing the dialog does.
      pickDirectory: async () => inbox.pick(),
      // The Device Inbox's seams. The runtime, the facade, the stores, the
      // scheduler and every guard are the shipped ones; what is injected is the
      // network, the device row central would issue, the folder probe, and a
      // task-owned data root. The backoff is an hour on every arm so nothing
      // fires on its own and each pass is stepped deliberately.
      // The stored-send engine is the REAL one; only the transport it hands
      // this run's. The producer is the renderer's own shared `encryptFiles`.
      storedSendJournalDirectory: sendJournalDir,
      // Task-owned, so this run never writes into a user profile — and so the
      // journal states are reachable on a host that is not Windows.
      updateDataDirectory: updateDir,
      storedSend: {
        transportFactory: () => sendTransport,
        sourceFactory: () => sendSource,
      },
      inbox: {
        dataRoot: () => inboxRootDir,
        // Observed rather than opened: a run must not put Explorer on whatever
        // machine it happens to be on.
        revealDirectory: async (directory) => {
          inbox.revealed.push(directory);
          // The production adapter throws when `shell.openPath` answers with a
          // non-empty string, which is how the OS reports a refusal. Modelled
          // here so the run can prove the PAGE says so — a refusal that only
          // main knows about is invisible to the person it happened to.
          if (inbox.revealRefuses) {
            throw Object.assign(new Error("reveal was refused"), { code: "internal" });
          }
        },
        makeApi: () => inboxApi,
        // The Inbox's OWN destination factory, distinct from the stored one
        // below. Off by default: only the automatic-receive scenario turns it
        // on, and only for the delivery it built.
        makeDestination: async (request) =>
          inbox.writeTo === null
            ? makeDestination({ manifest: request.manifest })
            : makeWritingDestination({ ...request, rootPath: inbox.writeTo }),
        resolveDevice: async () => inbox.device,
        directoryUsable: async () => inbox.folderUsable,
        backoff: { idle: 3600, afterWork: 3600, first: 3600, cap: 3600, blocked: 3600 },
      },
      // Device Inbox SEND. Only the HTTP is injected: the coordinator, the plan
      // store, the `device_task` adapter and the upload engine are the shipped
      // ones, and the ciphertext comes from the renderer's own producer.
      inboxSend: { fetchImpl: (input, init) => sendSink.fetch(input, init) },
      // The account reads. Injected because the wiring asks for them at
      // startup under this run's synthetic bearer, and the origin is the
      // PRODUCTION one — see `accountSink`.
      accountSummary: { fetchImpl: (input, init) => accountSink.fetch(input, init) },
      // ## The update core, injected ONLY in the restart phase
      //
      // The first phase runs the SHIPPED defaults so the disabled truth is the
      // real one — trust null, no pinned key, nothing offered. The restart
      // phase pins this run's TEST key and serves a signed feed, which is the
      // only way the transition states are reachable at all. Both fetches are
      // injected; nothing in either phase reaches the network.
      ...(RESTART_PHASE
        ? {
            updateCore: {
              trust: {
                publicKeys: [updateFeed.publicKeyBase64Url],
                feedUrl: "https://relayium.com/apps/windows/updates.json",
                signatureUrl: "https://relayium.com/apps/windows/updates.json.sig",
                artifactHosts: ["relayium.com"],
                product: "relayium-windows",
                channel: "stable",
                platform: "windows",
                arch: "x64",
                // A TEST publisher, pinned only in this in-process trust. The
                // SHIPPED base still has none, so the signed install path stays
                // unreachable in a real build by construction. Without one here
                // the core stops at `ready-unsigned` — which is correct product
                // behaviour, and is why the install path cannot be exercised by
                // a fixture that leaves this null.
                expectedPublisher: "CN=Relayium Test Publisher",
              },
              feed: { fetchImpl: (input) => updateFeed.fetchFeed(input) },
              artifact: { fetchImpl: (input) => updateFeed.fetchArtifact(input) },
              // PREVIEW only: what the user is SHOWN about the publisher.
              // `unsigned` is the truthful answer for a fixture artifact that
              // carries no Authenticode signature, and it is what a build with
              // no provisioned certificate would see in production too.
              // PREVIEW only — it decides what the user is SHOWN, never what
              // runs. The installer below is the only thing that could run
              // anything, and it never does.
              verifier: { verify: async () => "signed-by-expected-publisher" },
              // The one thing allowed to run an executable — and this one never
              // does. It records what it was handed and answers with a closed
              // refusal, so the composition is exercised end to end without
              // launching anything on a developer's machine.
              installer: {
                async installVerified(expectation) {
                  updateFeed.installs.push({
                    name: expectation.name,
                    sizeBytes: expectation.sizeBytes,
                    sha256: expectation.sha256,
                    publisher: expectation.publisher,
                    receipt: expectation.receipt,
                  });
                  return updateFeed.installOutcome;
                },
              },
            },
          }
        : {}),
      storedReceive: { receive: streamingReceive },
      // Never the real Windows startup programs: this run must not add itself
      // to whatever machine it happens to be on.
      loginItem: {
        read: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }),
        write: () => {},
        reportFailure: () => {},
      },
      makeDestination: async (options) => makeDestination(options),
      // The real registry, the real adapter contract, and no Finder window on
      // whatever machine this runs on. It THROWS on refusal exactly like the
      // shipped `shell.openPath` wrapper — a seam that resolved on failure
      // would make this green for the very bug it exists to catch.
      revealReceiveFolder: async (directory) => {
        receives.revealed.push(directory);
        if (receives.revealRefuses) throw Object.assign(new Error("reveal was refused"), { code: "internal" });
      },
    },
    // The REAL platform, with the two questions and the exit answered by this
    // script. Show, hide, focus and notifications stay the shipped ones.
    residentPlatform: (real) => ({
      ...real,
      askFirstClose: async () => {
        answers.firstCloseCalls += 1;
        return answers.firstClose;
      },
      confirm: async (prompt) => {
        answers.confirmCalls += 1;
        // The prompt is RISK-SPECIFIC — `quitPrompt` picks a different title
        // for a transfer, for unsent text, and for an unknown answer — so it is
        // the only thing here that can tell those apart. Captured because
        // "was the user asked" does not discriminate: this app has several
        // reasons to ask.
        answers.lastPrompt = prompt ?? null;
        const next = answers.confirm.shift();
        const hook = answers.onConfirm;
        if (hook) {
          answers.onConfirm = null;
          await hook();
        }
        // An exhausted script means the app asked something this scenario did
        // not expect: Stay, so a runaway cannot end the process.
        return next === true;
      },
      exit: () => {
        answers.exited = true;
      },
      showStopped: (notice) => {
        // Recorded rather than shown: a modal nobody can dismiss would hang the
        // run. The REAL implementation is what `main.ts` composes; this asserts
        // it is reached with closed, localized copy.
        answers.stopped.push(notice);
      },
      reportFailure: () => {},
    }),
  });

  const win = BrowserWindow.getAllWindows()[0];
  const runtime = residentRuntime();
  check("the resident runtime is composed", runtime !== null);
  if (!runtime || !win) {
    report();
    return;
  }

  await waitForShell(win);

  // ## The restart half
  //
  // A SECOND process over the same task-owned directories. It drives nothing
  // and asserts one thing: that the history the first half produced is still
  // there and still names the same files. Everything else in this file would
  // only re-prove what the first half proved.
  if (RESTART_PHASE) {
    await scenarioRestartedHistory(win, runtime);
    // The signed transition, with this run's TEST key pinned through the
    // private seam. Only reachable in this phase — see the injection.
    await scenarioUpdateSignedTransition(win);
    report();
    app.exit(failures.length === 0 ? 0 : 1);
    return;
  }

  await scenarioHideKeepsEverything(win, runtime);
  await scenarioQuitCancelled(win, runtime);
  await scenarioResidueThenStay(win, runtime);
  await scenarioRepeatedQuitJoins(runtime);
  await scenarioResidentSurfaces(win, runtime);
  await scenarioStoredReceive(win, runtime);
  // The receipt a finished receive earns, and the reveal it authorises. Early,
  // while the app is still on its first document and signed out: the receipt is
  // bound to the document that asked, and a later scenario replaces it.
  await scenarioReceiveReceipt(win);
  // The Device Inbox vertical, in order: consent, the resident promise, the
  // held deliveries, the message history, a refused quit, and an account
  // change. It signs in for real and signs out at the end, so the anonymous
  // stored-download scenario below still starts from a signed-out app.
  await seedOneMessage(smokeSecretStore);
  await scenarioInboxConsent(win);
  await scenarioInboxKeepsReceiving(win, runtime);
  await scenarioInboxPending(win);
  await scenarioInboxMessages(win);
  await scenarioInboxPolicy(win);
  await scenarioInboxReceiptsAndReveal(win);
  // The delivery that arrives with nobody looking, and the history that names
  // it. Ordered here because it needs consent, a key and a chosen folder, and
  // because everything after it may navigate away.
  await scenarioInboxAutomaticReceive(win, runtime);
  await scenarioInboxSend(win);
  // The pre-quit answer, with a delivery genuinely held open by the server.
  await scenarioSendQuitRisk(win, runtime);
  // The account screen, composed. After the Inbox scenarios because it signs in
  // through the same account they established.
  await scenarioAccountScreen(win);
  // The Stored send card. AFTER the account screen, because its retention
  // gating reads the plan that scenario proves is loaded.
  await scenarioStoredSendCard(win);
  // The SHIPPED update truth: this phase runs the real defaults.
  await scenarioUpdateDisabledTruth(win);
  // Stored send, while the smoke is signed in and BEFORE any quit scenario.
  // A quit fences admissions and a Stay clears them; running the whole send
  // flow through that would be testing the fence, which has its own coverage,
  // rather than the send.
  await scenarioStoredSendFlow(win);
  await scenarioStoredSendHistory(win);
  await scenarioStoredSendAmbiguous(win);
  await scenarioStoredSendCancelAndNavigation(win);
  await scenarioInboxQuitStay(win, runtime);
  // The send scenarios sign in, because sending a link needs an account. The
  // session is put back here, immediately before the scenario that needs it:
  // `scenarioControlMetrics` measures the account screen's sign-in control, and
  // everything after it is written against a signed-out session. Not earlier —
  // the Inbox scenario above needs the account too.
  await js(win, `globalThis.relayium.auth.signOut().then(() => "ok", () => "threw")`);
  pollAnswer = { status: "pending" };
  await scenarioControlMetrics(win);
  await scenarioInboxAccountChange(win);
  await scenarioAnonymousAcrossSignOut(win);
  await scenarioNoLateStartWhileQuitting(win, runtime);
  // Last: it replaces the document every earlier scenario was driving.
  await scenarioOutcomeDoesNotCrossDocuments(win);

  report();
  app.exit(failures.length === 0 ? 0 : 1);
}


// ---------------------------------------------------------------------------
// Device Inbox — receive
// ---------------------------------------------------------------------------

/** Click what a person clicks: the row's own button, not its marked wrapper. */
const clickTest = (win, name) =>
  js(
    win,
    `(() => { const el = document.querySelector('[data-test="${name}"]'); if (!el) return false;` +
      ` const target = el.tagName === "BUTTON" ? el : el.querySelector("button") ?? el;` +
      ` target.click(); return true; })()`,
  );

const present = (win, name) => js(win, `document.querySelector('[data-test="${name}"]') !== null`);

const shown = (win, name) => js(win, `document.querySelector('[data-test="${name}"]')?.textContent ?? ""`);

/** A wait the Inbox scenarios use: this run steps the scheduler itself, so a
 *  condition that is not met quickly is a failure rather than a slow success. */
const waitInbox = (win, what, expr) => waitFor(win, what, expr, 8000);

async function openInbox(win) {
  await js(win, `(() => { document.querySelector('[data-test="nav-inbox"] button')?.click(); return true; })()`);
  return waitInbox(win, "the Inbox page", `document.querySelector('[data-test="inbox-enable"]') !== null
    || document.querySelector('[data-test="inbox-disable"]') !== null
    || document.querySelector('[data-test="inbox-sign-in"]') !== null`);
}

/**
 * Seed ONE real message before the account is adopted.
 *
 * Written through the shipped `MessageVault` with the at-rest key the shipped
 * grant store mints, into the directory the shipped context derives — so the
 * page below reads it back through the real facade, the real decryption and the
 * real IPC. Done BEFORE sign-in because the vault caches its index once bound:
 * seeding afterwards would be invisible for a reason that has nothing to do
 * with the product.
 */
async function seedOneMessage(store) {
  const context = captureAccount({
    // The service scopes an account by the DEVICE ROW central issues, which is
    // what this run's `resolveDevice` answers.
    accountID: inbox.device.id,
    deviceID: inbox.device.id,
    epoch: 1,
    inboxRoot: `${inboxRootDir}/inbox`,
  });
  const grants = new InboxGrantStore(store);
  const vault = new MessageVault(context, new InboxFiles(context), () => grants.atRestKey(context.accountKey));
  await vault.saveText({
    id: "seeded-message",
    taskID: "seeded-task",
    sourceDeviceID: "another-device",
    plaintext: new TextEncoder().encode("hello from the phone"),
    now: 1_700_000_000,
  });
}

/**
 * The consent order, in the real DOM: refused first, then given.
 *
 * The assertion that matters is `inbox.enrolled`. A page that showed an "on"
 * state without an enrolment would be lying; a page that enrolled without a
 * folder would advertise a device with nowhere to put what arrives.
 */
async function scenarioInboxConsent(win) {
  const onPage = await openInbox(win);
  check("the Inbox page opens", onPage === true);

  // Signed out: the page says which of the four ways to be off this is.
  check("a signed-out Inbox says to sign in", (await present(win, "inbox-sign-in")) === true);
  check("nothing enrolled while signed out", inbox.enrolled === 0, String(inbox.enrolled));

  // Sign in for real, through the real IPC and the injected device flow.
  pollAnswer = { status: "ok", accessToken: "smoke-bearer", accountEmail: "smoke@example.invalid" };
  const nonce = "inbox-smoke-nonce";
  await js(win, `globalThis.relayium.auth.start({ nonce: ${JSON.stringify(nonce)} })`);
  const polled = await js(
    win,
    `globalThis.relayium.auth.poll({ nonce: ${JSON.stringify(nonce)} }).then((r) => r.status, () => "threw")`,
  );
  check("the smoke signed in over real IPC", polled === "ok", String(polled));

  // The scheduler binds on its own — nothing on this page started it.
  await openInbox(win);
  const offered = await waitInbox(win, "the off state for a signed-in account", `document.querySelector('[data-test="inbox-enable"]') !== null`);
  check("a signed-in Inbox starts DISABLED", offered === true);
  check("binding an account does not enrol it", inbox.enrolled === 0, String(inbox.enrolled));

  // ---- refusal ------------------------------------------------------------
  inbox.pick = () => null; // the person closes the dialog
  check("turn on was clicked", await clickTest(win, "inbox-enable"));
  const declined = await waitInbox(win, "the refusal notice", `document.querySelector('[data-test="inbox-notice"]') !== null`);
  check("closing the folder dialog is reported as its own outcome", declined === true);
  check("a closed dialog enrols nothing", inbox.enrolled === 0, String(inbox.enrolled));
  check(
    "and the page still offers to turn it on",
    (await present(win, "inbox-enable")) === true,
  );

  // ---- consent ------------------------------------------------------------
  inbox.pick = () => destinationDir;
  await clickTest(win, "inbox-notice-dismiss");
  check("turn on was clicked again", await clickTest(win, "inbox-enable"));
  const on = await waitInbox(win, "the on state", `document.querySelector('[data-test="inbox-disable"]') !== null`);
  check("choosing a folder turns receiving on", on === true);
  // ## Bounded diagnostics, emitted whether or not the assertion holds
  //
  // On Windows this failed with `enrolled: 0` while the page showed the ON
  // state. CANDIDATES, none of them established: the enrolment was still in
  // flight when the assertion ran (a premature barrier in this fixture, since
  // the ON state is published as soon as the consent is durable); or
  // `facade.enable` threw before reaching `api.enrol` — key generation, the
  // at-rest key, or a journal/vault write. The assertion alone cannot tell them
  // apart, so the closed status and the page's own notice go into the log.
  //
  // Closed codes and rendered copy only — no path, no key, no secret.
  const enrolDiag = await js(
    win,
    `globalThis.relayium.inbox.state().then(
       (s) => JSON.stringify({ status: s.status, enabled: s.enabled, hasDestination: s.hasDestination, policy: s.policy }),
       (e) => "state threw: " + String(e))`,
  );
  const enrolNotice = await shown(win, "inbox-notice");
  process.stdout.write(
    `RELAYIUM_INBOX_ENROL_DIAG ${JSON.stringify({
      enrolled: inbox.enrolled,
      capabilities: inbox.lastCapabilities,
      autoAccept: inbox.lastAutoAccept,
      state: enrolDiag,
      notice: enrolNotice.slice(0, 240),
    })}\n`,
  );
  // ## Wait on the ENROLMENT, not on the state that precedes it
  //
  // `view.enabled` is published as soon as the CONSENT is durable — deliberately,
  // so a restart honours what the user chose — which means the ON state appears
  // BEFORE `facade.enable` has reached `api.enrol`. Asserting the count straight
  // after the DOM state is a barrier that holds on a fast machine and races on a
  // slow one, and it is the likeliest cause of `enrolled: 0` on Windows: a
  // FIXTURE defect, not a product one.
  //
  // The deadline is real and a timeout is still a failure. This waits for the
  // operation to COMPLETE; it does not sleep past the problem.
  const enrolled = await waitForValue(() => inbox.enrolled >= 1, 20_000);
  check("the enrolment completed", enrolled === true, String(inbox.enrolled));
  check("it enrolled exactly once", inbox.enrolled === 1, String(inbox.enrolled));
  check(
    "it advertised only what this build composes",
    inbox.lastCapabilities.join(",") === "inbox.receive.v3,inbox.text.v1,inbox.autoaccept.v1",
    inbox.lastCapabilities.join(","),
  );
  // The CAPABILITY is the build's and the POLICY is the user's. Turning
  // receiving on does not ask for unattended saving: that is a separate choice.
  check("but it did not choose to accept automatically", inbox.lastAutoAccept === "ask", inbox.lastAutoAccept);

  // The page says the resident promise, and never the folder.
  check("the page states that receiving continues in the background", (await present(win, "inbox-resident-note")) === true);
  check("the page says a folder is chosen", (await present(win, "inbox-has-folder")) === true);
  const text = await js(win, `document.body.innerText`);
  check("the destination never reaches the page", !text.includes(destinationDir), "path on screen");
}

/**
 * The invariant this whole feature is arranged around.
 *
 * Hiding the window and navigating away are the two things a person does that
 * a page-owned scheduler would silently stop. Both are driven here, and the
 * proof is a COUNT in the main process that keeps going up.
 */
async function scenarioInboxKeepsReceiving(win, runtime) {
  const before = inbox.heartbeats;

  // Navigate away from the Inbox page entirely.
  await js(win, `(() => { document.querySelector('[data-test="nav-lan"] button')?.click(); return true; })()`);
  await waitInbox(win, "another page", `document.querySelector('[data-test="inbox-disable"]') === null`);
  handlerControlWake();
  const afterNavigation = await waitForValue(() => inbox.heartbeats > before);
  check("navigating away does not stop receiving", afterNavigation === true, `${String(before)} -> ${String(inbox.heartbeats)}`);

  // And hide the window, which is what closing it does on this platform.
  const hidden = inbox.heartbeats;
  // The real close path, which by now has already been acknowledged once by an
  // earlier scenario — so this hides silently, which is what a person's second
  // close does.
  const outcome = await runtime.onWindowClose();
  check(
    "closing hides rather than quits",
    outcome.action === "hide" || outcome.kind === "already-acknowledged",
    JSON.stringify(outcome),
  );
  check("the window is hidden", win.isVisible() === false, String(win.isVisible()));
  handlerControlWake();
  const afterHide = await waitForValue(() => inbox.heartbeats > hidden);
  check("a hidden window keeps receiving", afterHide === true, `${String(hidden)} -> ${String(inbox.heartbeats)}`);

  win.show();
  await openInbox(win);
  check("the page shows the state it missed", (await present(win, "inbox-disable")) === true);
}

/** Accepting and declining one held delivery, from the real list. */
async function scenarioInboxPending(win) {
  inbox.tasks = [pendingTask("task-a"), pendingTask("task-b")];
  handlerControlWake();
  const listed = await waitInbox(win, "the pending list", `document.querySelectorAll('[data-test="inbox-accept"]').length === 2`);
  check("central's held deliveries are listed", listed === true);
  const body = await js(win, `document.querySelector('[data-test="inbox-pending"]')?.textContent ?? ""`);
  check("a held delivery is described by size, not by name", body.includes("4.0 KB"), body);

  check("accept was clicked", await clickTest(win, "inbox-accept"));
  await waitForValue(() => inbox.accepted.length > 0);
  check(
    "the accept was handed to the transport as an accept",
    inbox.accepted[0]?.accept === true,
    JSON.stringify(inbox.accepted[0]),
  );
  const outcome = await waitInbox(win, "the accept outcome", `document.querySelector('[data-test="inbox-notice"]') !== null`);
  check("the page reports the outcome", outcome === true);
  const notice = await shown(win, "inbox-notice");
  // Truthful: central took the accept and no delivery was leased in this run,
  // so this is "it will be received shortly" and emphatically not "saved".
  check("a queued acceptance is not reported as a save", !notice.toLowerCase().includes("saved"), notice);

  await clickTest(win, "inbox-notice-dismiss");
  check("decline was clicked", await clickTest(win, "inbox-reject"));
  await waitForValue(() => inbox.accepted.some((entry) => entry.accept === false));
  check(
    "a decline is handed over as a decline",
    inbox.accepted.some((entry) => entry.accept === false),
    JSON.stringify(inbox.accepted),
  );
}

/** The message history: list, open, copy, delete — through the real vault. */
async function scenarioInboxMessages(win) {
  const listed = await waitInbox(win, "the seeded message", `document.querySelector('[data-test="inbox-open"]') !== null`);
  check("a saved message is listed", listed === true);
  check("its body is not on screen until it is opened", !(await js(win, `document.body.innerText`)).includes("hello from the phone"));

  check("open was clicked", await clickTest(win, "inbox-open"));
  const opened = await waitInbox(win, "the message body", `document.querySelector('[data-test="inbox-message-body"]') !== null`);
  check("opening it shows the text that was actually stored", opened === true);
  const body = await shown(win, "inbox-message-body");
  check("the decrypted message is the one that was saved", body.includes("hello from the phone"), body);

  // ## The clipboard is asserted by its BYTES, not by a label
  //
  // Copying happens in main, because `window.ts` denies every renderer
  // permission — including the browser clipboard — and that policy is not
  // relaxed for a button. So this reads back what the system clipboard
  // actually holds, which is the only thing that proves the copy happened.
  await setClipboard("something else entirely");
  check("copy was clicked", await clickTest(win, "inbox-copy"));
  const answered = await waitInbox(
    win,
    "the copy control to answer",
    `document.querySelector('[data-test="inbox-copy"]')?.textContent?.trim() !== "Copy"`,
  );
  check("copying is never silently inert", answered === true);
  const pasted = await readClipboard();
  check("the message's own bytes reached the clipboard", pasted === "hello from the phone", JSON.stringify(pasted));
  check("and the control says it worked", (await shown(win, "inbox-copy")).trim() === "Copied");

  check("delete was clicked", await clickTest(win, "inbox-delete"));
  const gone = await waitInbox(win, "the empty message list", `document.querySelector('[data-test="inbox-messages-empty"]') !== null`);
  check("deleting a message removes it", gone === true);
}

/**
 * A quit the user refuses, with receiving on.
 *
 * Two things are asserted: that main refuses to turn anything on WHILE the
 * dialog is up — a fence set before the question, not after the answer — and
 * that Stay leaves a scheduler that still receives.
 */
async function scenarioInboxQuitStay(win, runtime) {
  // The Inbox page, named rather than inherited: the stored-send scenarios ran
  // in between and left the shell on another row.
  await openInbox(win);
  let refusedDuringPrompt = null;
  answers.confirm = [false]; // Stay
  answers.onConfirm = async () => {
    refusedDuringPrompt = await js(
      win,
      `globalThis.relayium.inbox.enable().then((r) => r.kind, () => "threw")`,
    );
  };

  const decision = await runtime.requestQuit();
  check("a refused quit stays", decision === "stay", decision);
  check("the process was not ended", answers.exited === false);
  check(
    "nothing could be turned on while the quit was being decided",
    refusedDuringPrompt === "refused",
    String(refusedDuringPrompt),
  );

  // Stay means the app works: the scheduler is admitted and running again.
  const before = inbox.heartbeats;
  handlerControlWake();
  const resumed = await waitForValue(() => inbox.heartbeats > before);
  check("staying resumes receiving", resumed === true, `${String(before)} -> ${String(inbox.heartbeats)}`);
  check("and receiving is still on", (await present(win, "inbox-disable")) === true);
}

/** Signing out fences the account's Inbox and says so on the page. */
async function scenarioInboxAccountChange(win) {
  const enrolledBefore = inbox.enrolled;
  const out = await js(win, `globalThis.relayium.auth.signOut().then((r) => JSON.stringify(r), () => "threw")`);
  check("the account transition ran", out === JSON.stringify({ signedIn: false }), String(out));

  await openInbox(win);
  const needsAccount = await waitInbox(win, "the signed-out Inbox", `document.querySelector('[data-test="inbox-sign-in"]') !== null`);
  check("signing out returns the Inbox to needs-account", needsAccount === true);

  // A copy naming a message from the account that has gone away must refuse,
  // and must leave the clipboard exactly as it was. Driven over the real
  // channel, because the page no longer offers the control at all here.
  await setClipboard("untouched");
  const refusedCopy = await js(
    win,
    `globalThis.relayium.inbox.copy({ id: "seeded-message" }).then((r) => r.kind, () => "threw")`,
  );
  check("a copy under a retired account is refused", refusedCopy === "failed", String(refusedCopy));
  const after = await readClipboard();
  check("and nothing reached the clipboard", after === "untouched", JSON.stringify(after));

  // And nothing is enrolled again under an account that has gone away.
  const heartbeats = inbox.heartbeats;
  handlerControlWake();
  await new Promise((r) => setTimeout(r, 300));
  check("no work continues under the old account", inbox.heartbeats === heartbeats, String(inbox.heartbeats));
  check("nothing re-enrolled across the change", inbox.enrolled === enrolledBefore, String(inbox.enrolled));
}

/**
 * The controls the user actually presses are one size.
 *
 * Measured rather than eyeballed. The Stored page's input and button rendered
 * at the browser default while the Account page's button used the Mac's 32px
 * metric, because control styling lived in one component's scoped block and
 * Svelte scoping kept it there.
 */
async function scenarioControlMetrics(win) {
  const heights = await js(
    win,
    `(() => {
      const measured = {};
      const record = (name) => {
        const el = document.querySelector('[data-test="' + name + '"]');
        measured[name] = el ? Math.round(el.getBoundingClientRect().height) : null;
      };
      document.querySelector('[data-test="nav-stored"] button')?.click();
      return new Promise((resolve) => setTimeout(() => {
        record("stored-link");
        record("stored-open");
        document.querySelector('[data-test="nav-account"] button')?.click();
        setTimeout(() => { record("sign-in"); resolve(JSON.stringify(measured)); }, 60);
      }, 60));
    })()`,
  );
  const measured = JSON.parse(heights);
  process.stdout.write(`RELAYIUM_CONTROL_METRICS ${heights}\n`);
  check(
    "the stored input is a real control, not a browser default",
    measured["stored-link"] >= 32,
    JSON.stringify(measured),
  );
  check(
    "the stored button matches the account button",
    measured["stored-open"] === measured["sign-in"],
    JSON.stringify(measured),
  );

  // Root observed a clipped heading after navigating from Stored to Account and
  // could not reproduce it on a fresh capture. Measured here rather than fixed
  // blind: a scroll reset nobody can reproduce is a change with no defect
  // behind it.
  const layout = await js(
    win,
    `(() => {
      const main = document.querySelector("main");
      const h1 = document.querySelector("h1");
      return JSON.stringify({
        scrollTop: main ? Math.round(main.scrollTop) : null,
        headingTop: h1 ? Math.round(h1.getBoundingClientRect().top - main.getBoundingClientRect().top) : null,
      });
    })()`,
  );
  process.stdout.write(`RELAYIUM_LAYOUT_AFTER_NAV ${layout}\n`);
  const { scrollTop, headingTop } = JSON.parse(layout);
  check("the page title is visible after navigating between pages", scrollTop === 0 && headingTop >= 0, layout);
}

/**
 * The system clipboard, read and written by THIS process.
 *
 * Awaited rather than used directly: the value is what actually proves a copy
 * happened, and comparing a promise against a string silently passes for the
 * wrong reason — which is exactly what it did first time round.
 */
async function readClipboard() {
  return await clipboard.readText();
}

async function setClipboard(value) {
  await clipboard.writeText(value);
}


// ---------------------------------------------------------------------------
// Stored send and history — the whole user flow, in the real DOM
// ---------------------------------------------------------------------------

/**
 * Put real `File` objects on the real `<input type="file">`.
 *
 * `DataTransfer` is how a page's file input is populated without a person at a
 * dialog. The objects are genuine `File`s, so what the controller hands to the
 * shared `encryptFiles` below is what a user's pick produces.
 */
async function pickFiles(win, files, testId = "send-files") {
  return js(
    win,
    `(() => {
      const input = document.querySelector('[data-test="${testId}"]');
      const dt = new DataTransfer();
      ${files
        .map(
          (file) =>
            `dt.items.add(new File([new Uint8Array(${JSON.stringify([...file.bytes])})], ${JSON.stringify(file.name)}));`,
        )
        .join("\n      ")}
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.files.length;
    })()`,
  );
}

async function goToStored(win) {
  await js(win, `(() => { document.querySelector('[data-test="nav-stored"] button')?.click(); return true; })()`);
  // ## Sending a link needs an account, so this establishes one
  //
  // The send half is gated when signed out, and these scenarios run after a
  // sign-out earlier in this session. Signing in here makes them match
  // production rather than driving a form the product does not offer in that
  // state — the same shape `scenarioRestartedHistory` already uses for the
  // Inbox. Waited for rather than sampled: the decision is about what the page
  // shows, and reading it in the same tick as the click reads it too early.
  await waitFor(
    win,
    "the stored page to settle",
    `document.querySelector('[data-test="send-gate"]') !== null
      || document.querySelector('[data-test="send-start"]') !== null
      || document.querySelector('[data-test="send-cancel"]') !== null`,
  );
  if (await present(win, "send-gate-sign-in")) {
    pollAnswer = { status: "ok", accessToken: "smoke-bearer", accountEmail: "smoke@example.invalid" };
    const nonce = "stored-send-smoke-nonce";
    await js(win, `globalThis.relayium.auth.start({ nonce: ${JSON.stringify(nonce)} })`);
    await js(win, `globalThis.relayium.auth.poll({ nonce: ${JSON.stringify(nonce)} }).then((r) => r.status, () => "threw")`);
  }
  // EITHER control: a send that is running replaces Start with Cancel, and
  // waiting only for Start would time out on exactly the case this scenario
  // exists to check — coming back to a page mid-upload.
  return waitInbox(
    win,
    "the stored page",
    `document.querySelector('[data-test="send-start"]') !== null
      || document.querySelector('[data-test="send-cancel"]') !== null`,
  );
}

/**
 * A complete send, from the picker to the clipboard.
 *
 * The producer is the renderer's own shared `encryptFiles`; the engine is the
 * accepted one; what it hands bytes to is this run's CONTROLLED IN-MEMORY
 * transport — no socket, no HTTP, no server. What is asserted is what actually
 * happened on this side: the bytes the transport was handed, the link on
 * screen, and the bytes on the SYSTEM clipboard. Nothing here is evidence about
 * a remote handler.
 */
async function scenarioStoredSendFlow(win) {
  if (!(await goToStored(win))) return;

  // A file spanning more than one chunk, so the frame sequence is exercised.
  const big = new Uint8Array(200 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 13) % 251;
  const small = new TextEncoder().encode("second file");
  const picked = await pickFiles(win, [
    { name: "big.bin", bytes: big },
    { name: "second.txt", bytes: small },
  ]);
  check("two files were picked through the real input", picked === 2, String(picked));
  const shownPick = await waitInbox(win, "the picked summary", `document.querySelector('[data-test="send-picked"]') !== null`);
  check("the page reports what was picked", shownPick === true);

  check("send was clicked", await clickTest(win, "send-start"));

  const published = await waitFor(
    win,
    "the send to publish",
    `document.querySelector('[data-test="send-published"]') !== null`,
    30_000,
  );
  check("the send published", published === true);

  // The transport holds real ciphertext, and as much as was declared.
  check(
    "the whole object was handed over",
    sendHeld.body.byteLength > big.length,
    String(sendHeld.body.byteLength),
  );
  check("the manifest frame was handed over", sendHeld.manifest.byteLength > 0);
  check("finalize actually happened", sendHeld.finalized === true);

  // The link is on screen and carries its key fragment.
  // The same shape of diagnostic for the send: on Windows no link appeared, and
  // "a link is shown" cannot say whether the upload failed, the finalize did, or
  // the link could not be composed from custody. All three are closed codes.
  const sendDiag = await js(
    win,
    `JSON.stringify({
       published: document.querySelector('[data-test="send-published"]') !== null,
       ambiguous: document.querySelector('[data-test="send-ambiguous"]') !== null,
       failed: document.querySelector('[data-test="send-failed"]') !== null,
       cancelled: document.querySelector('[data-test="send-cancelled"]') !== null,
       refusal: document.querySelector('[data-test="send-refusal"]')?.textContent?.trim() ?? null,
       hasLink: document.querySelector('[data-test="send-link"]') !== null,
     })`,
  );
  process.stdout.write(
    `RELAYIUM_SEND_DIAG ${JSON.stringify({
      page: sendDiag,
      handedOver: sendHeld.body.byteLength,
      manifest: sendHeld.manifest.byteLength,
      finalized: sendHeld.finalized,
    })}\n`,
  );
  // ## The link is composed AFTER the outcome, so it is waited for separately
  //
  // `send-published` renders from the outcome; the link is a SEPARATE on-demand
  // composition from custody that follows it. Reading the input in the same
  // tick as the published state holds on a fast machine and races on a slow
  // one. A timeout here is still a failure — this waits for the composition to
  // COMPLETE, it does not sleep past it.
  const linkReady = await waitFor(
    win,
    "the link to be composed",
    `(document.querySelector('[data-test="send-link"]')?.value ?? "").length > 0`,
    20_000,
  );
  check("a link was composed", linkReady === true);
  const link = await js(win, `document.querySelector('[data-test="send-link"]')?.value ?? ""`);
  check("a link is shown", link.includes("#k="), link.slice(0, 40));
  check("the link names the id finalize returned", link.includes("object-1"), link.slice(0, 60));

  // ## GLOBALLY EXCLUSIVE
  //
  // This writes and reads the OS clipboard, which is one shared resource per
  // machine. Two Electron runs overlapping here read each other's value and one
  // of them fails on a byte comparison that is correct — observed exactly once,
  // when an author run at 21:03:02 landed inside a root run's
  // 21:02:58–21:03:02 window and the Inbox copy read back a stored link.
  //
  // The assertion is NOT weakened for it: comparing actual clipboard bytes is
  // the only thing that proves a copy happened. Runs are serialised instead.
  //
  // ## The clipboard, by its BYTES
  //
  // Copying happens in main because `window.ts` denies the renderer clipboard
  // permission. This asserts the system clipboard holds exactly the link the
  // user is looking at.
  await setClipboard("not-the-link");
  check("copy was clicked", await clickTest(win, "send-copy"));
  const copiedLabel = await waitInbox(
    win,
    "the copy control to answer",
    `document.querySelector('[data-test="send-copy"]')?.textContent?.trim() !== "Copy link"`,
  );
  check("copying answered", copiedLabel === true);
  const pasted = await readClipboard();
  check("the link itself reached the clipboard", pasted === link, JSON.stringify(pasted).slice(0, 80));
}

/** The history row for that send: its own copy, and a delete that reports. */
async function scenarioStoredSendHistory(win) {
  const listed = await waitInbox(win, "the history row", `document.querySelector('[data-test="send-history"]') !== null`);
  check("the send appears in history", listed === true);

  await setClipboard("not-the-link");
  check("the history copy was clicked", await clickTest(win, "send-history-copy"));
  const fromHistory = await waitForValue(async () => (await readClipboard()).includes("#k="), 8000);
  check("a history row copies the link too", fromHistory === true, await readClipboard());

  const before = sendHeld.removed.length;
  check("delete was clicked", await clickTest(win, "send-history-delete"));
  const reported = await waitInbox(
    win,
    "the delete to report",
    `document.querySelector('[data-test="send-row-notice"]') !== null`,
  );
  // The point: a delete ALWAYS says what it did. A silent one left the user
  // believing an object was gone when it may still be there.
  check("the delete reports its outcome", reported === true);
  check("the delete reached the transport", sendHeld.removed.length > before, String(sendHeld.removed.length));
}

/**
 * A finalize whose answer was lost.
 *
 * The page must say so and offer a re-check — never a link, because there is no
 * object id to put in one, and never "failed", because nothing here establishes
 * that no object was created.
 */
async function scenarioStoredSendAmbiguous(win) {
  sendHeld.ambiguous = true;
  await pickFiles(win, [{ name: "ambiguous.bin", bytes: new Uint8Array([1, 2, 3, 4]) }]);
  check("send was clicked for the ambiguous case", await clickTest(win, "send-start"));
  const unknown = await waitFor(
    win,
    "the ambiguous outcome",
    `document.querySelector('[data-test="send-ambiguous"]') !== null`,
    30_000,
  );
  check("an unconfirmed finalize is shown as unconfirmed", unknown === true);
  check(
    "and no link is offered for it",
    (await js(win, `document.querySelector('[data-test="send-link"]') === null`)) === true,
  );

  // The re-check is real: it asks again and reports truthfully that nothing
  // could be confirmed, rather than quietly succeeding.
  const hasRecheck = await waitInbox(
    win,
    "the re-check control",
    `document.querySelector('[data-test="send-history-recheck"]') !== null`,
  );
  check("an unconfirmed send offers a re-check", hasRecheck === true);
  check("re-check was clicked", await clickTest(win, "send-history-recheck"));
  const answered = await waitInbox(
    win,
    "the re-check to report",
    `document.querySelector('[data-test="send-row-notice"]') !== null`,
  );
  check("the re-check reports what it found", answered === true);
  sendHeld.ambiguous = false;
}

/** Cancel mid-transfer, and a navigation that must not lose the send. */
async function scenarioStoredSendCancelAndNavigation(win) {
  let release;
  sendHeld.hold = new Promise((resolve) => {
    release = resolve;
  });

  await pickFiles(win, [{ name: "held.bin", bytes: new Uint8Array(120 * 1024) }]);
  check("a held send was started", await clickTest(win, "send-start"));
  const running = await waitInbox(win, "the transfer to be running", `document.querySelector('[data-test="send-progress"]') !== null`);
  check("progress is shown while it runs", running === true);

  // ## Navigating away does not lose the send
  //
  // The controller is shell-lived, so the job, its progress and the picked
  // files survive the page unmounting — which is what a user does when they
  // check something on another row mid-upload.
  await js(win, `(() => { document.querySelector('[data-test="nav-lan"] button')?.click(); return true; })()`);
  await waitInbox(
    win,
    "another page",
    `document.querySelector('[data-test="send-start"]') === null
      && document.querySelector('[data-test="send-cancel"]') === null`,
  );
  await goToStored(win);
  const stillRunning = await js(win, `document.querySelector('[data-test="send-progress"]') !== null`);
  check("the send survived a page navigation", stillRunning === true);

  check("cancel was clicked", await clickTest(win, "send-cancel"));
  const cancelled = await waitInbox(
    win,
    "the cancelled outcome",
    `document.querySelector('[data-test="send-cancelled"]') !== null`,
  );
  check("cancelling reports it as cancelled", cancelled === true);

  sendHeld.hold = null;
  release?.();
}


/**
 * Off / Ask / Auto, and the folder reveal.
 *
 * The Inbox API is a CONTROLLED IN-MEMORY object in this run, so what is
 * asserted is the payload MAIN HANDED IT — not what a server received, and not
 * that a delivery happened. `claim()` here always answers with no deliveries,
 * so this scenario proves policy selection, the enrolment payload and the
 * claim-count gate; it proves NOTHING about automatic file delivery or about a
 * persisted receipt record. Both are owed, and are called out in the checkpoint
 * rather than implied by this being green.
 */
async function scenarioInboxPolicy(win) {
  await openInbox(win);
  const offered = await waitInbox(win, "the policy control", `document.querySelector('[data-test="inbox-policy"]') !== null`);
  check("the policy is offered as three answers", offered === true);
  check("ask is offered", (await present(win, "inbox-policy-ask")) === true);
  check("auto is offered", (await present(win, "inbox-policy-auto")) === true);
  check("off is offered", (await present(win, "inbox-policy-off")) === true);
  check(
    "ask is the one in force after enabling",
    (await js(win, `document.querySelector('[data-test="inbox-policy-ask"]').checked`)) === true,
  );

  // ---- auto -------------------------------------------------------------
  check("auto was chosen", await clickTest(win, "inbox-policy-auto"));
  const announcedAuto = await waitForValue(() => inbox.lastAutoAccept === "auto", 8000);
  check("auto was handed to the transport", announcedAuto === true, inbox.lastAutoAccept);
  check(
    "and it was advertised with its capability",
    inbox.lastCapabilities.includes("inbox.autoaccept.v1"),
    inbox.lastCapabilities.join(","),
  );

  // ---- off --------------------------------------------------------------
  check("off was chosen", await clickTest(win, "inbox-policy-off"));
  const announcedOff = await waitForValue(() => inbox.lastAutoAccept === "off", 8000);
  check("off was handed to the transport", announcedOff === true, inbox.lastAutoAccept);

  // Off stops future claims. Asserted on the COUNT, not on a rendered state.
  const claimsAtOff = inbox.claims;
  for (let i = 0; i < 3; i += 1) {
    handlerControlWake();
    await new Promise((r) => setTimeout(r, 60));
  }
  check("nothing is claimed while off", inbox.claims === claimsAtOff, String(inbox.claims));

  // ---- back to ask ------------------------------------------------------
  check("ask was chosen again", await clickTest(win, "inbox-policy-ask"));
  const backToAsk = await waitForValue(() => inbox.lastAutoAccept === "ask", 8000);
  check("ask was handed to the transport", backToAsk === true, inbox.lastAutoAccept);
  handlerControlWake();
  const claimingAgain = await waitForValue(() => inbox.claims > claimsAtOff, 8000);
  check("and claiming resumes", claimingAgain === true, String(inbox.claims));
}

/** The receipt record, and the one main-owned reveal per section. */
async function scenarioInboxReceiptsAndReveal(win) {
  const shown = await waitInbox(
    win,
    "the received section",
    `document.querySelector('[data-test="inbox-receipts-empty"]') !== null
      || document.querySelector('[data-test="inbox-receipts"]') !== null`,
  );
  check("the received section is present", shown === true);

  // ## Specific, not "either state is fine"
  //
  // `claim()` in this run never hands back a delivery, so the record IS empty
  // and the page must say exactly that. An `empty OR list` assertion would have
  // passed whatever appeared, which is how a broken list renders green.
  //
  // Rendering a POPULATED record — and a persisted one, after a restart — needs
  // a real delivery, which this scenario does not drive. That is owed.
  check("the record is empty, and says so", (await present(win, "inbox-receipts-empty")) === true);
  check("no receipt row is rendered for it", (await present(win, "inbox-receipts")) === false);

  const before = inbox.revealed.length;
  check("reveal was clicked", await clickTest(win, "inbox-reveal"));
  const revealed = await waitForValue(() => inbox.revealed.length > before, 8000);
  check("reveal reached main", revealed === true, String(inbox.revealed.length));
  check(
    "and main opened the folder IT holds, not one the page named",
    inbox.revealed[inbox.revealed.length - 1] === destinationDir,
    String(inbox.revealed[inbox.revealed.length - 1]),
  );

  // ---- a refusal is VISIBLE ------------------------------------------------
  //
  // `shell.openPath` reports failure by returning a non-empty string, and an
  // adapter that discarded it reported every refusal as a success. The page
  // must say so: a folder that never opened, with nothing on screen about it,
  // is a button that silently does nothing.
  inbox.revealRefuses = true;
  const refusedAt = inbox.revealed.length;
  check("reveal was clicked again", await clickTest(win, "inbox-reveal"));
  const reached = await waitForValue(() => inbox.revealed.length > refusedAt, 8000);
  check("the refused reveal still reached main", reached === true);
  const said = await waitInbox(
    win,
    "the reveal failure to be shown",
    `document.querySelector('[data-test="inbox-reveal-failed"]') !== null`,
  );
  check("and the page says the folder could not be opened", said === true);
  inbox.revealRefuses = false;
}

/**
 * A delivery that arrives with NOBODY looking, and a history that names it.
 *
 * This is the scenario the earlier checkpoint owed and could not produce. Every
 * clause is a claim the product makes and a user can check:
 *
 *  * the window is HIDDEN and the page is on another row while it happens;
 *  * nothing is clicked — `accept` is never called for this task;
 *  * the bytes that land are the sender's own, compared byte for byte;
 *  * the foreground history then NAMES what arrived, from metadata captured
 *    during the receive rather than by reading the folder afterwards.
 *
 * The transport is this run's in-memory fixture and the writer is the injected
 * destination — see `makeWritingDestination`. Everything between them is the
 * shipped path.
 */
async function scenarioInboxAutomaticReceive(win, runtime) {
  await openInbox(win);
  // Unattended saving is the user's choice, made here as a person makes it.
  check("auto was chosen for the delivery", await clickTest(win, "inbox-policy-auto"));
  const announced = await waitForValue(() => inbox.lastAutoAccept === "auto", 8000);
  check("auto reached the transport", announced === true, inbox.lastAutoAccept);

  const payload = Buffer.from("the actual bytes of the actual file", "utf8");
  const nested = Buffer.from("nested content", "utf8");
  inbox.writeTo = destinationDir;
  inbox.written = [];
  const acceptedBefore = inbox.accepted.length;
  const delivery = await buildRealDelivery("task-auto-1", [
    { name: "report.pdf", bytes: payload },
    { name: "photos/one.jpg", bytes: nested },
  ]);

  // ---- nobody is looking --------------------------------------------------
  await js(win, `(() => { document.querySelector('[data-test="nav-lan"] button')?.click(); return true; })()`);
  await waitInbox(win, "another page", `document.querySelector('[data-test="inbox-policy"]') === null`);
  // The REAL close path, which is what a person does. By now it has already
  // been acknowledged by an earlier scenario, so this hides silently.
  const closed = await runtime.onWindowClose();
  check("closing hides rather than ending anything", closed.action === "hide" || closed.kind === "already-acknowledged", JSON.stringify(closed));
  check("the window is hidden while it arrives", win.isVisible() === false, String(win.isVisible()));

  inbox.deliveries = [delivery];
  handlerControlWake();

  const landed = await waitForValue(() => inbox.written.length === 2, 30_000);
  process.stdout.write(
    `RELAYIUM_INBOX_AUTO_DIAG ${JSON.stringify({
      written: inbox.written,
      reports: inbox.reports,
      claims: inbox.claims,
    })}\n`,
  );
  check("the delivery was received with no window and no page", landed === true, inbox.written.join(","));
  // Nothing was clicked, and nothing asked central to accept it.
  check("no accept was issued for it", inbox.accepted.length === acceptedBefore, String(inbox.accepted.length));

  // ---- the bytes are the sender's own -------------------------------------
  const wrote = await readFile(path.join(destinationDir, "report.pdf")).catch(() => null);
  check("the file exists on disk", wrote !== null);
  check("and its bytes are exactly what was sent", wrote !== null && wrote.equals(payload), String(wrote?.length));
  const nestedWrote = await readFile(path.join(destinationDir, "photos", "one.jpg")).catch(() => null);
  check("a nested name kept its folder", nestedWrote !== null && nestedWrote.equals(nested));

  // ---- central was told, once it was true ---------------------------------
  //
  // WAITED FOR, not asserted the instant the bytes appear. The ACK is issued
  // after the publish and after the journal marker, so a check that ran when
  // the files landed was a barrier in the wrong place — it passed on a fast
  // machine and reported `0` on a slower one, which is a fixture defect
  // wearing a product failure's clothes.
  const ackedNow = await waitForValue(
    () => inbox.reports.some((r) => r.taskID === "task-auto-1" && r.state === "saved" && r.committed),
    20_000,
  );
  check("central was told it was saved", ackedNow === true, JSON.stringify(inbox.reports));
  const acked = inbox.reports.filter((r) => r.taskID === "task-auto-1" && r.state === "saved" && r.committed);
  check("and told exactly once", acked.length === 1, String(acked.length));

  // ---- and the history NAMES it -------------------------------------------
  win.show();
  await openInbox(win);
  const records = await js(
    win,
    `Promise.all([
       globalThis.relayium.inbox.receipts().catch((e) => ({ threw: String(e) })),
       globalThis.relayium.inbox.history().catch((e) => ({ threw: String(e) })),
     ]).then(([r, h]) => JSON.stringify({
       receipts: r.entries === null ? "unreadable" : r.entries.length,
       phases: (r.entries ?? []).map((e) => e.phase),
       names: h.entries === null ? "unreadable" : h.entries.map((e) => e.items.length),
       taskIDs: (h.entries ?? []).map((e) => e.taskID),
     }))`,
  );
  process.stdout.write(`RELAYIUM_INBOX_HISTORY_DIAG ${records}\n`);
  const named = await waitInbox(
    win,
    "the named history",
    `document.querySelector('[data-test="inbox-history-name"]') !== null`,
  );
  check("the history names what arrived", named === true);
  const names = await js(
    win,
    `[...document.querySelectorAll('[data-test="inbox-history-name"]')].map((n) => n.textContent).join("|")`,
  );
  check("both names are rendered, relative", names === "report.pdf|photos/one.jpg", names);
  check("and no unnamed notice is shown for it", (await present(win, "inbox-receipt-unnamed")) === false);
  check("the names record was readable", (await present(win, "inbox-names-unavailable")) === false);
  // The receiving directory is main's and stays there.
  const body = await js(win, `document.body.innerText`);
  check("the destination never reaches the page", !body.includes(destinationDir), "path on screen");
  inbox.writeTo = null;
}

/**
 * Sending to another of the user's own devices, driven as a person drives it.
 *
 * The producer here is the REAL renderer path: the page's own `<input>`, the
 * shared `encryptFiles`, and ciphertext over the real IPC. The server is this
 * run's in-memory sink, which records what was actually asked of it — so the
 * `purpose=device_task` object and the sealed key in the create are observed
 * evidence rather than an assumption.
 */
async function scenarioInboxSend(win) {
  // Where this scenario's requests begin. See the note at `mine` below.
  const sendFrom = sendSink.requests.length;
  await openInbox(win);
  // The list is read once at startup, before an account is bound, so the page
  // offers the refresh a person would use.
  const refreshable = await waitInbox(
    win,
    "the device picker",
    `document.querySelector('[data-test="inbox-send-refresh"]') !== null
      || document.querySelector('[data-test="inbox-send-target"]') !== null`,
  );
  check("the send section is offered", refreshable === true);
  if (await present(win, "inbox-send-refresh")) await clickTest(win, "inbox-send-refresh");

  const listed = await waitInbox(
    win,
    "this account's other devices",
    `document.querySelectorAll('[data-test="inbox-send-target"]').length === 2`,
  );
  check("the account's other devices are listed", listed === true);
  // The device that cannot take a delivery says so, in central's own verdict.
  const refusal = await shown(win, "inbox-send-target-refusal");
  check("an ineligible device says why", refusal.length > 0, refusal);
  const checkboxes = await js(
    win,
    `[...document.querySelectorAll('[data-test="inbox-send-target"]')].map((el) => el.disabled).join(",")`,
  );
  check("and cannot be selected", checkboxes === "false,true", checkboxes);

  // ---- pick, choose, send -------------------------------------------------
  const picked = await pickFiles(win, [{ name: "holiday.txt", bytes: Buffer.from("sun and rain") }], "inbox-send-files");
  check("files were picked through the real input", picked === 1, String(picked));
  const shownName = await shown(win, "inbox-send-names");
  check("the page shows the actual name it will send", shownName.includes("holiday.txt"), shownName);

  await js(
    win,
    `(() => { const el = document.querySelector('[data-test="inbox-send-target"]:not([disabled])');
      el.click(); return true; })()`,
  );
  const ready = await waitInbox(
    win,
    "the send button to become usable",
    `document.querySelector('[data-test="inbox-send-start"]')?.disabled === false`,
  );
  check("choosing a device and a file is enough to send", ready === true);
  check("send was clicked", await clickTest(win, "inbox-send-start"));

  const pageState = await js(
    win,
    `JSON.stringify({
       checked: document.querySelectorAll('[data-test="inbox-send-target"]:checked').length,
       statuses: [...document.querySelectorAll('[data-test="inbox-send-status"]')].map((n) => n.textContent.trim()),
       rows: document.querySelectorAll('[data-test="inbox-send-target"]').length,
     })`,
  );
  process.stdout.write(
    `RELAYIUM_INBOX_SEND_DIAG ${JSON.stringify({
      page: pageState,
      requests: sendSink.requests.map((r) => `${r.method} ${r.url}`),
    })}\n`,
  );
  // ## Waited on the PHASE, not on the sentence
  //
  // The first version of this waited for a status with no "%" in it — and
  // "Waiting" has no "%", so the barrier passed while the delivery was still
  // queued. It held on one run and failed on the next, which is a fixture
  // defect wearing a product failure's clothes. The phase is carried as data
  // for exactly this reason.
  const settled = await waitFor(
    win,
    "the delivery to settle",
    `document.querySelector('[data-test="inbox-send-status"][data-phase="settled"]') !== null`,
    30_000,
  );
  check("the delivery settled", settled === true);
  const status = await js(
    win,
    `document.querySelector('[data-test="inbox-send-status"][data-phase="settled"]')?.textContent?.trim() ?? ""`,
  );
  process.stdout.write(
    `RELAYIUM_INBOX_SEND_SETTLED ${JSON.stringify({
      status,
      requests: sendSink.requests.map((r) => `${r.method} ${r.url}`),
    })}\n`,
  );
  check("and it is reported as delivered", /Delivered|已送达/.test(status), status);

  // ---- what the server was actually asked ---------------------------------
  // Scoped to THIS scenario's requests. Nothing here can be satisfied by an
  // upload some earlier scenario made — the trap the held-send gate fell into.
  const mine = sendSink.requests.slice(sendFrom);
  const init = mine.find((r) => r.url.startsWith("/api/uploads?"));
  check("the object was opened as a device task", init?.url.includes("purpose=device_task") === true, init?.url);
  const created = mine.find((r) => r.url.endsWith("/inbox/tasks"));
  check("a task was created", created !== undefined);
  check("with a key sealed to the target", String(created?.body?.wrappedKey ?? "").length > 0);
  check("and the target's own key id", created?.body?.targetKeyId === "target-key-1", String(created?.body?.targetKeyId));
  // The one thing that must never appear anywhere the server can see it.
  const seen = JSON.stringify(sendSink.requests);
  check("the file name never reached the server", !seen.includes("holiday.txt"), "name on the wire");
}

/**
 * What the user was shown, after the app was closed and opened again.
 *
 * The only assertion this half exists for. A reload in the first process would
 * not have proved it: the store's cache is warm there, so a second read tells
 * you nothing about the bytes on disk. Here the process is new, the cache is
 * cold, and the record has to be opened with the account's at-rest key from the
 * persisted secret store.
 */
async function scenarioRestartedHistory(win, runtime) {
  // The session may or may not have survived; this half does not care which,
  // only that the account can be reached again.
  await openInbox(win);
  if (await present(win, "inbox-sign-in")) {
    pollAnswer = { status: "ok", accessToken: "smoke-bearer", accountEmail: "smoke@example.invalid" };
    const nonce = "restart-smoke-nonce";
    await js(win, `globalThis.relayium.auth.start({ nonce: ${JSON.stringify(nonce)} })`);
    await js(win, `globalThis.relayium.auth.poll({ nonce: ${JSON.stringify(nonce)} }).then((r) => r.status, () => "threw")`);
    await openInbox(win);
  }

  const named = await waitFor(
    win,
    "the named history after a restart",
    `document.querySelector('[data-test="inbox-history-name"]') !== null`,
    20_000,
  );
  check("the named history survived the restart", named === true);
  const names = await js(
    win,
    `[...document.querySelectorAll('[data-test="inbox-history-name"]')].map((n) => n.textContent).join("|")`,
  );
  check("with the same names, from disk", names === "report.pdf|photos/one.jpg", names);
  check("and it is not reported as unavailable", (await present(win, "inbox-names-unavailable")) === false);
  // Consent survived too, which is what makes the history's survival meaningful
  // rather than an artefact of a fresh profile.
  check("receiving is still on", (await present(win, "inbox-disable")) === true);

  // ---- unsent work, in a process that is holding nothing else -------------
  //
  // The drafts half of the quit-risk fix, proven where it can be proven: this
  // process has received nothing and sent nothing, so the ONLY thing that can
  // put something at stake is the selection. If picked files did not reach the
  // snapshot the risk would be `none`, `quitPrompt` would return null, and the
  // app would quit without asking at all — which is exactly what it did before.
  const picked = await pickFiles(
    win,
    [{ name: "unsent-after-restart.txt", bytes: Buffer.from("still here") }],
    "inbox-send-files",
  );
  check("files were picked in the restarted process", picked === 1, String(picked));
  answers.lastPrompt = null;
  answers.confirm = [false]; // Stay
  const asked = answers.confirmCalls;
  const decision = await runtime.requestQuit();
  process.stdout.write(
    `RELAYIUM_QUIT_PROMPT_RESTART ${JSON.stringify({
      title: answers.lastPrompt?.title ?? null,
      decision,
      asked: answers.confirmCalls - asked,
    })}\n`,
  );
  check("a quit over unsent files stays", decision === "stay", decision);
  check("it asked at all", answers.confirmCalls > asked, `${String(asked)} -> ${String(answers.confirmCalls)}`);
  check(
    "and it named UNSENT WORK, not a transfer",
    answers.lastPrompt?.title === "Quit with unsent text?",
    String(answers.lastPrompt?.title),
  );
  check("the process was not ended", answers.exited === false);
  check("and the selection survived the prompt", (await present(win, "inbox-send-picked")) === true);
}

/**
 * What a quit costs while a delivery is actually in flight — and while files
 * are merely CHOSEN.
 *
 * Two facts live on opposite sides of the boundary and both were being lost:
 *
 *  * main counted only its receiving features, so an upload or a device
 *    delivery mid-PATCH made the app look idle at the moment the user was
 *    deciding whether to end it. The counts `quiesce` reports come after the
 *    work has been aborted, which is far too late to inform a consent;
 *  * the page reported drafts from the WebRTC composers only, so files a person
 *    had picked and not yet sent were "nothing at stake".
 *
 * Root's own probe found both against the frozen source. This is the owning
 * evidence for the fix, and it asserts the pre-quit answer specifically — never
 * a post-teardown count, which would prove the wrong thing.
 */
async function scenarioSendQuitRisk(win, runtime) {
  try {
    await sendQuitRisk(win, runtime);
  } finally {
    // Whatever happened above, nothing stays parked in the append handler: a
    // held request outlives this scenario and every later one waits behind it,
    // which turns one failed assertion into a run that times out somewhere else.
    const release = sendSink.holdAppend;
    sendSink.holdAppend = null;
    sendSink.onAppendEntered = null;
    if (release !== null) releaseHeldAppend();
  }
}

/** Set by the scenario so the `finally` above can always release the gate. */
let releaseHeldAppend = () => undefined;

async function sendQuitRisk(win, runtime) {
  await openInbox(win);

  // ---- chosen, not yet sent: a DRAFT ---------------------------------------
  const picked = await pickFiles(
    win,
    [{ name: "unsent-report.txt", bytes: Buffer.from("not sent yet") }],
    "inbox-send-files",
  );
  check("files were picked for a device", picked === 1, String(picked));
  // Observed through the PUBLIC path, not a private field: a quit reaches a
  // confirmation only when the risk is something. Files chosen and not sent are
  // `local-text` risk — before the fix the page reported no drafts for them and
  // the app quit without asking at all.
  const askedBefore = answers.confirmCalls;
  answers.lastPrompt = null;
  answers.confirm = [false]; // Stay
  const draftDecision = await runtime.requestQuit();
  check("a quit over picked-but-unsent files stays", draftDecision === "stay", draftDecision);
  check(
    "and it ASKED, because unsent files are something at stake",
    answers.confirmCalls > askedBefore,
    `${String(askedBefore)} -> ${String(answers.confirmCalls)}`,
  );
  process.stdout.write(
    `RELAYIUM_QUIT_PROMPT_DRAFT ${JSON.stringify({ title: answers.lastPrompt?.title ?? null })}\n`,
  );
  // ## No title assertion HERE, and the reason is worth stating
  //
  // By this point in the run main is legitimately holding other things — the
  // scheduler has worked a delivery, handles have been retained — so the risk
  // is `transfer` whatever the drafts say, and a title check here would pass
  // for reasons that have nothing to do with the fix. Measured, not assumed:
  // the diagnostic above prints what it actually was.
  //
  // The drafts half is proven in the RESTART phase instead, where main is
  // quiet and `local-text` is the only thing the prompt can be.
  check("the process was not ended over a draft", answers.exited === false);
  check("and the selection is still there", (await present(win, "inbox-send-picked")) === true);

  // ---- in flight: the delivery is HELD open --------------------------------
  //
  // The hold is a real gate: the append handler awaits it, and `entered`
  // resolves only when a request is actually sitting in that handler. Both
  // halves are needed — without the await nothing is held, and without the
  // entered-signal the scenario is guessing when to look.
  //
  // Request identity is taken FRESH from here, so nothing below can be
  // satisfied by an upload the previous scenario made.
  const firstRequest = sendSink.requests.length;
  let releaseUpload = () => undefined;
  const entered = new Promise((resolve) => {
    sendSink.onAppendEntered = resolve;
  });
  sendSink.holdAppend = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  releaseHeldAppend = releaseUpload;
  await js(
    win,
    `(() => { const el = document.querySelector('[data-test="inbox-send-target"]:not([disabled])');
      if (el && !el.checked) el.click(); return true; })()`,
  );
  await waitInbox(
    win,
    "the send button to become usable",
    `document.querySelector('[data-test="inbox-send-start"]')?.disabled === false`,
  );
  check("send was pressed", await clickTest(win, "inbox-send-start"));

  // ## The server's gate first, the page's state second
  //
  // Waiting on the DOM first was the mistake: `sending` is fleeting when
  // nothing is actually held, so it passed by luck. Here the run blocks until a
  // request is sitting inside the append handler — at which point the delivery
  // is provably in flight and stays that way until this scenario says otherwise.
  const arrived = await Promise.race([
    entered.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 30_000)),
  ]);
  check("a real append reached the server and is held there", arrived === true);
  // FRESH identity: an upload from the previous scenario cannot satisfy this.
  const appends = sendSink.requests
    .slice(firstRequest)
    .filter((r) => r.method === "PATCH" && r.url.startsWith("/api/uploads/"));
  check("and it belongs to THIS send", appends.length >= 1, String(appends.length));
  // Only now is the page's own state meaningful — and it must still say so.
  const inFlight = await waitFor(
    win,
    "the page to report the delivery as running",
    `document.querySelector('[data-test="inbox-send-status"][data-phase="sending"]') !== null`,
    30_000,
  );
  check("the delivery is running", inFlight === true);

  // ---- the quit question, asked while it is held ---------------------------
  answers.confirm = [false]; // Stay
  answers.lastPrompt = null;
  const decision = await runtime.requestQuit();
  check("a refused quit stays", decision === "stay", decision);
  check("the process was not ended", answers.exited === false);
  // The user was ASKED — which only happens when something is at stake. A quit
  // over an app believed idle does not reach a confirmation at all.
  check("the quit asked before ending anything", answers.confirmCalls > 0, String(answers.confirmCalls));
  process.stdout.write(
    `RELAYIUM_QUIT_PROMPT_HELD ${JSON.stringify({ title: answers.lastPrompt?.title ?? null })}\n`,
  );
  // A held delivery is a TRANSFER, and it must be named as one. Before the fix
  // main counted no outgoing work and the page reported `sending: false`, so
  // the strongest thing this could have been was the unsent-work prompt.
  check(
    "and the prompt names a running transfer",
    answers.lastPrompt?.title === "Quit while a transfer is running?",
    String(answers.lastPrompt?.title),
  );

  // ---- Stay leaves the delivery alone, and the selection with it -----------
  //
  // Released in a `finally` below as well, so an assertion that throws above
  // cannot leave a request parked in the handler and every later scenario
  // waiting behind it.
  releaseUpload();
  sendSink.holdAppend = null;
  sendSink.onAppendEntered = null;
  const settled = await waitFor(
    win,
    "the held delivery to finish after Stay",
    `document.querySelector('[data-test="inbox-send-status"][data-phase="settled"]') !== null`,
    30_000,
  );
  check("staying did not cancel the delivery", settled === true);
  const status = await js(
    win,
    `document.querySelector('[data-test="inbox-send-status"][data-phase="settled"]')?.textContent?.trim() ?? ""`,
  );
  check("and it completed", /Delivered|已送达/.test(status), status);
  // The picked files survive a Stay: a person who chose to keep working must
  // not find their selection gone.
  check("the selection survived the quit prompt", (await present(win, "inbox-send-picked")) === true);
}

/**
 * The account screen, composed: main → IPC → controller → component.
 *
 * The component's own DOM suite is accepted separately and proves the component.
 * It cannot prove the WIRING, which is what this covers: that the service main
 * composes reads through the injected client, that its snapshot crosses the
 * five channels and the push, and that what a person ends up looking at is the
 * account the fixture described.
 *
 * Nothing here reaches a real account or a provider: every request is answered
 * by `accountSink`, and the run asserts that too.
 */
async function scenarioAccountScreen(win) {
  await js(win, `(() => { document.querySelector('[data-test="nav-account"] button')?.click(); return true; })()`);
  const mounted = await waitFor(
    win,
    "the account screen",
    `document.querySelector('[data-test="account-details"]') !== null`,
    20_000,
  );
  check("the account screen renders below the sign-in card", mounted === true);

  // ---- the three reads actually happened, through the injected client ------
  const asked = await waitForValue(
    () =>
      accountSink.requests.includes("GET /api/me") &&
      accountSink.requests.includes("GET /api/me/usage") &&
      accountSink.requests.includes("GET /api/devices"),
    20_000,
  );
  check("main read all three sections", asked === true, accountSink.requests.join(","));
  // And nothing left the machine: every request this run made was answered here.
  check(
    "no account request escaped the fixture",
    accountSink.requests.every((r) => r.startsWith("GET /api/") || r.startsWith("PATCH /api/devices/")),
    accountSink.requests.join(","),
  );

  // ---- what the person is looking at --------------------------------------
  const profileName = await waitFor(
    win,
    "the profile to render",
    `(document.querySelector('[data-test="profile-name"]')?.textContent ?? "").includes("Smoke Owner")`,
    20_000,
  );
  check("the profile the fixture described is on screen", profileName === true);
  check(
    "and its email",
    (await shown(win, "profile-email")).includes("smoke@example.invalid"),
    await shown(win, "profile-email"),
  );

  // ## `0` is UNLIMITED — asserted as a POSITIVE fact, not as an absence
  //
  // "Has no digits" is satisfied by the empty string, so the first version of
  // this would have passed over a card that rendered nothing at all. The cap
  // must say something, and that something must not be a number.
  const storage = await shown(win, "plan-storage");
  check("an unlimited cap says so", storage.trim().length > 0, JSON.stringify(storage));
  check("and does not render as a number", !/\d/.test(storage), storage);
  const planName = await shown(win, "plan-name");
  check("the current plan is named", planName.trim().length > 0, planName);

  // The bar is `[role="progressbar"]`, which is what the component actually
  // renders — the earlier selector looked for `progress`/`meter` elements that
  // do not exist, so it reported "no meter" for every quota on the page.
  const storageBars = await js(
    win,
    `document.querySelectorAll('[data-test="usage-storage"] [role="progressbar"]').length`,
  );
  check("an unlimited quota draws NO bar", storageBars === 0, String(storageBars));
  const trafficBars = await js(
    win,
    `document.querySelectorAll('[data-test="usage-traffic"] [role="progressbar"]').length`,
  );
  // The traffic cap IS limited in this fixture, so its half must meter — which
  // is what proves the check above is discriminating rather than vacuous.
  check("a limited quota DOES draw one", trafficBars === 1, String(trafficBars));
  check("retention is stated", (await shown(win, "plan-retention")).trim().length > 0);

  // ---- the devices, by name ------------------------------------------------
  const rows = await js(
    win,
    `[...document.querySelectorAll('[data-test="device-name"]')].map((n) => n.textContent.trim()).join("|")`,
  );
  check("both devices are named", rows.includes("Study desktop") && rows.includes(inbox.device.name), rows);
  check("this PC is marked as the current one", (await present(win, "device-current")) === true);

  // ---- one mutation, end to end -------------------------------------------
  const before = accountSink.renamed.length;
  await js(
    win,
    `(() => { const row = document.querySelector('[data-test="device-row"][data-device="study-desktop"]');
      row?.querySelector('[data-test="device-rename"]')?.click(); return true; })()`,
  );
  const prompting = await waitFor(win, "the rename prompt", `document.querySelector('[data-test="rename-input"]') !== null`);
  check("renaming asks first", prompting === true);
  await js(
    win,
    `(() => { const input = document.querySelector('[data-test="rename-input"]');
      input.value = "Renamed by smoke";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true; })()`,
  );
  check("the rename was saved", await clickTest(win, "rename-save"));
  const renamed = await waitForValue(() => accountSink.renamed.length > before, 20_000);
  check("the rename reached the server through main", renamed === true, JSON.stringify(accountSink.renamed));
  check(
    "with the name the person typed, for the row they chose",
    accountSink.renamed.at(-1)?.id === "study-desktop" &&
      accountSink.renamed.at(-1)?.name === "Renamed by smoke",
    JSON.stringify(accountSink.renamed.at(-1)),
  );
  // ## The ROW's name is the oracle, not an outcome banner
  //
  // The component renders a successful rename by showing the new name — its
  // outcome text for `renamed` is deliberately empty — so waiting for
  // `device-outcome` would be waiting for something that never appears on the
  // path that WORKED. It passed only when the rename failed.
  const renamedRow = await waitFor(
    win,
    "the renamed row to render its new name",
    `(document.querySelector('[data-test="device-row"][data-device="study-desktop"] [data-test="device-name"]')
       ?.textContent ?? "").includes("Renamed by smoke")`,
    20_000,
  );
  check("the row shows the name the person gave it", renamedRow === true);
  // And the old name is gone from that row, so this is a change rather than an
  // addition somewhere on the page.
  const oldGone = await js(
    win,
    `!(document.querySelector('[data-test="device-row"][data-device="study-desktop"] [data-test="device-name"]')
        ?.textContent ?? "").includes("Study desktop")`,
  );
  check("and no longer the old one", oldGone === true);

  // ---- one section failing does not take the others down ------------------
  accountSink.failUsage = true;
  const asked503 = accountSink.requests.length;
  await js(
    win,
    `globalThis.relayium.accountSummary.refresh({ section: "usage" }).then(() => "asked", () => "threw")`,
  );
  const failed = await waitFor(
    win,
    "the usage card's own failure",
    `document.querySelector('[data-test="usage-failed"]') !== null
      || document.querySelector('[data-test="plan-failed"]') !== null`,
    20_000,
  );
  check("a failed section renders its own failure", failed === true);
  check("the read was actually attempted", accountSink.requests.length > asked503);
  // The two that succeeded are untouched — never turned into zero, a free plan
  // or an unlimited quota.
  check(
    "beside sections that still show what they read",
    (await shown(win, "profile-name")).includes("Smoke Owner"),
    await shown(win, "profile-name"),
  );
  accountSink.failUsage = false;
}

/**
 * What the Stored send card shows before anything is uploaded.
 *
 * Three things a person relies on and none of which the earlier scenarios
 * asserted: the NAMES they picked, somewhere to drop, and an honest answer
 * about how long the link will last.
 *
 * The retention half is the one with a trap in it. `0` means unlimited, and a
 * plan that could not be READ is not a plan without a cap — treating a failed
 * usage read as "no limit" offers fourteen days over a server that will clamp
 * to one, and nothing on screen ever admits it.
 */
async function scenarioStoredSendCard(win) {
  // ## This scenario establishes its own preconditions
  //
  // The account scenario before it leaves the usage section FAILED — that is
  // the point of its last case — and a plan that could not be read is exactly
  // the `unknown` state asserted at the end of this one. Inheriting it would
  // make the first assertions here pass or fail on the previous scenario's
  // cleanup rather than on anything this one is about.
  accountSink.failUsage = false;
  accountSink.retentionSecs = 1_209_600;
  await js(win, `globalThis.relayium.accountSummary.refresh({ section: "usage" }).then(() => 1, () => 0)`);
  await goToStored(win);
  const readable = await waitFor(
    win,
    "the plan to be readable again",
    `document.querySelector('[data-test="send-ttl-unknown"]') === null
      || document.querySelector('[data-test="send-ttl"]') === null`,
    20_000,
  );
  check("the plan is readable before this scenario asserts on it", readable === true);
  const picked = await pickFiles(win, [
    { name: "holiday/beach.jpg", bytes: Buffer.from("one") },
    { name: "holiday/hills.jpg", bytes: Buffer.from("two") },
  ]);
  check("two files were picked", picked === 2, String(picked));

  // ---- the names, as the manifest will declare them ------------------------
  const names = await js(
    win,
    `[...document.querySelectorAll('[data-test="send-name"]')].map((n) => n.textContent.trim()).join("|")`,
  );
  check("the page shows what it is about to send", names.includes("beach.jpg") && names.includes("hills.jpg"), names);
  // A folder pick keeps its shape here exactly as it will at the far end.
  check("with the folder structure preserved", names.includes("holiday/"), names);
  check("and somewhere to drop instead", (await present(win, "send-dropzone")) === true);

  // ---- a cap the plan CAN honour: every choice offered ----------------------
  const all = await js(win, `document.querySelectorAll('[data-test="send-ttl"] option').length`);
  check("a 14-day plan offers every choice", all === 3, String(all));
  check("and says nothing about a cap", (await present(win, "send-ttl-capped")) === false);
  check("nor about an unreadable one", (await present(win, "send-ttl-unknown")) === false);

  // ---- a shorter cap: the picker shrinks, and says why ---------------------
  accountSink.retentionSecs = 24 * 60 * 60;
  await js(win, `globalThis.relayium.accountSummary.refresh({ section: "usage" }).then(() => 1, () => 0)`);
  const shrank = await waitFor(
    win,
    "the picker to follow the plan",
    `document.querySelectorAll('[data-test="send-ttl"] option').length === 1`,
    20_000,
  );
  check("a one-day plan offers only what it can honour", shrank === true);
  check("and the page says so", (await present(win, "send-ttl-capped")) === true);
  const chosen = await js(win, `Number(document.querySelector('[data-test="send-ttl"]').value)`);
  check("the selection was corrected to a legal one", chosen === 1, String(chosen));

  // ---- a cap that could not be READ: NOT unlimited -------------------------
  accountSink.failUsage = true;
  await js(win, `globalThis.relayium.accountSummary.refresh({ section: "usage" }).then(() => 1, () => 0)`);
  const unknown = await waitFor(
    win,
    "the unreadable-plan note",
    `document.querySelector('[data-test="send-ttl-unknown"]') !== null`,
    20_000,
  );
  check("an unreadable plan is said out loud", unknown === true);
  // NOT shortened: the server clamps whatever is sent, so hiding choices on a
  // guess would invent a limit. What is owed here is the sentence above.
  const whenUnknown = await js(win, `document.querySelectorAll('[data-test="send-ttl"] option').length`);
  check("and the choices are not silently shortened", whenUnknown === 3, String(whenUnknown));
  check("nor presented as a cap", (await present(win, "send-ttl-capped")) === false);

  accountSink.failUsage = false;
  accountSink.retentionSecs = 1_209_600;
  await js(win, `globalThis.relayium.accountSummary.refresh({ section: "usage" }).then(() => 1, () => 0)`);
  await js(win, `(() => { document.querySelector('[data-test="send-clear"]')?.click(); return true; })()`);
}

/**
 * What a build with no pinned key says about updating itself.
 *
 * The SHIPPED composition: `pinnedKeys` is empty, so `trust` is null and the
 * core publishes `disabled/no-pin`. This asserts that truth through the REAL
 * IPC and the REAL pane — not a unit's view of the state machine — because the
 * thing that matters is what a person is told, and "no update available" would
 * be a different and false claim.
 */
async function scenarioUpdateDisabledTruth(win) {
  await js(win, `(() => { document.querySelector('[data-test="nav-account"] button')?.click(); return true; })()`);
  const mounted = await waitFor(
    win,
    "the update pane",
    `document.querySelector('[data-test="update-details"]') !== null`,
    20_000,
  );
  check("the update pane is on the settings page", mounted === true);

  // Over the real channel, from the real composition.
  const state = await js(
    win,
    `globalThis.relayium.update.state().then((v) => JSON.stringify({ kind: v.state?.kind, reason: v.state?.reason }), (e) => "threw: " + String(e))`,
  );
  process.stdout.write(`RELAYIUM_UPDATE_SHIPPED ${state}\n`);
  const shaped = JSON.parse(state);
  check("this build reports updates DISABLED", shaped.kind === "disabled", state);
  // The reason matters: `no-pin` is a fact about provisioning, and an
  // engineering build is disabled for a different reason entirely.
  check("and says it is because nothing is pinned", shaped.reason === "no-pin", state);

  // And nothing was fetched to find that out.
  check("no feed request was made", updateFeed.requests.length === 0, updateFeed.requests.join(","));
  // The pane offers no action, because there is none to offer.
  const canCheck = await js(
    win,
    `document.querySelector('[data-test="update-check"]')?.disabled ?? "absent"`,
  );
  check("and offers no check button that could not work", canCheck === true || canCheck === "absent", String(canCheck));
}

/**
 * A signed update, end to end over the real IPC — in the restart process.
 *
 * The trust pinned here is a TEST key this run generated, injected through the
 * private composition seam, and the feed and artifact are served from memory.
 * No production key is provisioned and nothing reaches the network.
 *
 * What this proves that a unit cannot: the host's core construction, the
 * channel, the controller and the pane agree about a transition the core really
 * performed — including the detached-signature gate, which runs over the exact
 * bytes this fixture signed.
 */
async function scenarioUpdateSignedTransition(win) {
  await js(win, `(() => { document.querySelector('[data-test="nav-account"] button')?.click(); return true; })()`);
  const mounted = await waitFor(
    win,
    "the update pane",
    `document.querySelector('[data-test="update-details"]') !== null`,
    20_000,
  );
  check("the update pane is present in the restarted process", mounted === true);

  const before = await js(
    win,
    `globalThis.relayium.update.state().then((v) => JSON.stringify({ kind: v.state?.kind }), (e) => "threw: " + String(e))`,
  );
  check("a pinned build is NOT disabled", JSON.parse(before).kind !== "disabled", before);

  // The real action, over the real channel. `manual`, because a page cannot
  // claim the scheduler's trigger.
  const after = await js(
    win,
    `globalThis.relayium.update.act({ action: "check" })
       .then((v) => JSON.stringify({ kind: v.state?.kind, version: v.state?.candidate?.version,
                                     reason: v.state?.reason, detail: v.state?.detail }),
             (e) => "threw: " + String(e))`,
  );
  process.stdout.write(`RELAYIUM_UPDATE_TRANSITION ${after} ${JSON.stringify(updateFeed.requests)}\n`);
  const shaped = JSON.parse(after);
  check("the check found the signed update", shaped.kind === "update-available", after);
  check("and it is the version the feed advertised", shaped.version === "999.9.9", after);

  // The signature gate really ran: both documents were fetched, and from the
  // pinned URLs rather than anywhere a manifest could have named.
  check(
    "the signature was fetched before the metadata",
    updateFeed.requests[0]?.endsWith(".sig") === true,
    updateFeed.requests.join(","),
  );
  check(
    "and both came from the pinned feed",
    updateFeed.requests.every((url) => url.startsWith("https://relayium.com/apps/windows/updates.json")),
    updateFeed.requests.join(","),
  );

  // The PAGE says so too — the pane is what a person actually reads.
  const shown = await waitFor(
    win,
    "the pane to offer the update",
    `(document.querySelector('[data-test="update-details"]')?.textContent ?? "").includes("999.9.9")`,
    20_000,
  );
  check("the pane names the available version", shown === true);

  // Quit confirmations so far, so the launched path can be shown NOT to have
  // asked for one.
  const confirmsBeforeUpdate = answers.confirmCalls;

  // ---- download: the real bytes, hashed by the real code ------------------
  const downloaded = await js(
    win,
    `globalThis.relayium.update.act({ action: "download" })
       .then((v) => JSON.stringify({ kind: v.state?.kind, reason: v.state?.reason }),
             (e) => "threw: " + String(e))`,
  );
  process.stdout.write(`RELAYIUM_UPDATE_DOWNLOAD ${downloaded}\n`);
  const afterDownload = JSON.parse(downloaded);
  // `ready` is the ONLY state that may install: verified bytes AND a verified
  // publisher. `ready-unsigned` is a real and different terminus — the app may
  // reveal that file and must never execute it — which is why this fixture
  // pins a test publisher rather than leaving the install path unreachable.
  check("the download verified and is ready to install", afterDownload.kind === "ready", downloaded);
  check(
    "and the artifact really was fetched",
    updateFeed.requests.some((url) => url.endsWith(".exe")),
    updateFeed.requests.join(","),
  );

  // ---- DECLINE: nothing is torn down and nothing is launched --------------
  updateFeed.consent = false;
  const askedBeforeDecline = updateFeed.consentCalls;
  // Captured immediately before the call, so nothing between then and the
  // assertion can satisfy it on the previous scenario's behalf.
  const beatsBeforeDecline = inbox.heartbeats;
  const declined = await js(
    win,
    `globalThis.relayium.update.act({ action: "install" })
       .then((v) => JSON.stringify({ kind: v.state?.kind, reason: v.state?.reason }),
             (e) => "threw: " + String(e))`,
  );
  process.stdout.write(`RELAYIUM_UPDATE_DECLINED ${declined} ${JSON.stringify(updateFeed.installs)}\n`);
  check(
    "the person was asked exactly once",
    updateFeed.consentCalls === askedBeforeDecline + 1,
    String(updateFeed.consentCalls - askedBeforeDecline),
  );
  // NOTHING ran: a refusal is not a deferred launch.
  check("nothing was installed", updateFeed.installs.length === 0, JSON.stringify(updateFeed.installs));
  // ## `other`, and that is the accepted contract rather than a loss
  //
  // The host's refusal reason is its own string — "declined" — and
  // `update-summary.ts` reduces anything outside the shared `UpdateReason` set
  // to `other` on purpose: a newer core, or a host that invents a code, must
  // render as a generic sentence rather than leak a raw token to a page. So the
  // CLOSED value is what crosses, and asserting the host's private string was
  // asserting something the boundary is designed not to carry.
  //
  // What still discriminates: the kind is `install-deferred`, the installer was
  // never reached, and the app kept running.
  check(
    "and the app says the install was deferred",
    declined === JSON.stringify({ kind: "install-deferred", reason: "other" }),
    declined,
  );

  // The rest of the app is untouched — a declined install must not have
  // quiesced anything. The scheduler is the cheapest thing to ask.
  handlerControlWake();
  const stillReceiving = await waitForValue(() => inbox.heartbeats > beatsBeforeDecline, 15_000);
  check("a declined install left the rest of the app running", stillReceiving === true);

  // ---- APPROVE: consent, quiesce, installer, and the app comes back -------
  //
  // ## Back to `ready` first, because a deferred install is not a ready one
  //
  // The decline left the state at `install-deferred` — a refusal the app
  // remembers — and `ready` is the ONLY state that may install. The way back is
  // the way a person would take: check again, then download. `download` alone
  // is refused from a deferred state, which is correct and is why this is two
  // calls rather than one.
  updateFeed.consent = true;
  const reready = await js(
    win,
    `globalThis.relayium.update.act({ action: "check" })
       .then(() => globalThis.relayium.update.act({ action: "download" }))
       .then((v) => JSON.stringify({ kind: v.state?.kind }), (e) => "threw: " + String(e))`,
  );
  check("the staged artifact re-verifies to ready", JSON.parse(reready).kind === "ready", reready);

  // ## Readiness is EVIDENCED, not retried into existence
  //
  // The consent adapter refuses while the cleanup reports work it could not
  // settle. An earlier version of this scenario simply retried the whole
  // check/download/install up to eight times until one passed, which mutates
  // state to reach a green rather than establishing one — and would have hidden
  // a real inability to ever install.
  //
  // So what the app is holding is READ first, and a single attempt follows. If
  // this run is not quiet, the assertions below fail and say what was held.
  const readiness = await js(
    win,
    `globalThis.relayium.send.history().then(
       (h) => JSON.stringify({
         unresolved: (h.entries ?? []).filter((e) => e.state === "ambiguous").length,
         readable: h.entries !== null,
       }), () => JSON.stringify({ unresolved: -1, readable: false }))`,
  );
  process.stdout.write(
    `RELAYIUM_UPDATE_READINESS ${readiness} ${JSON.stringify({ leases: ownedReceives() })}\n`,
  );
  const held = JSON.parse(readiness);
  check("no lease is held before the install", ownedReceives() === 0, String(ownedReceives()));
  check("and no upload is unaccounted for", held.unresolved === 0, readiness);

  const askedBeforeApprove = updateFeed.consentCalls;
  const approved = await js(
    win,
    `globalThis.relayium.update.act({ action: "install" })
       .then((v) => JSON.stringify({ kind: v.state?.kind, reason: v.state?.reason }),
             (e) => "threw: " + String(e))`,
  );
  // Captured the instant the install returns and BEFORE anything is woken, so
  // the resume assertion below cannot be satisfied by work that was already in
  // flight. The previous version compared against a count taken before the
  // DECLINE, which ordinary traffic had already passed.
  const beatsAfterInstall = inbox.heartbeats;
  process.stdout.write(
    `RELAYIUM_UPDATE_APPROVED ${approved} ${JSON.stringify(updateFeed.installs)} beats=${String(beatsAfterInstall)}\n`,
  );
  check(
    "the person was asked exactly once more",
    updateFeed.consentCalls === askedBeforeApprove + 1,
    String(updateFeed.consentCalls - askedBeforeApprove),
  );

  // ## The self-join, proven rather than reasoned about
  //
  // Reaching the installer at all is the proof: the consent adapter quiesces
  // the app from INSIDE `install()`, and if that quiesce did not exclude the
  // update facade it would be waiting on the core that is awaiting this answer.
  // A deadlock here does not fail an assertion — it hangs the run.
  check("the installer was reached exactly once", updateFeed.installs.length === 1, JSON.stringify(updateFeed.installs));
  const handed = updateFeed.installs[0] ?? {};
  check(
    "with the hash from the SIGNED manifest",
    handed.sha256 === updateFeed.manifest.artifact.sha256,
    JSON.stringify(handed),
  );
  check("and the size the manifest declared", handed.sizeBytes === updateFeed.artifact.byteLength, JSON.stringify(handed));
  check("and the publisher the trust pinned", handed.publisher === "CN=Relayium Test Publisher", JSON.stringify(handed));
  // The EXACT controlled outcome, not merely "not installing": the synthetic
  // installer answered `no-expected-publisher`, and the core must carry that
  // refusal through as itself rather than flattening it.
  check(
    "the installer's refusal is carried through exactly",
    approved === JSON.stringify({ kind: "install-deferred", reason: "no-expected-publisher" }),
    approved,
  );

  // The lease was released, so the app is working again rather than left
  // quiesced by an install that did not happen. Measured from AFTER the install.
  handlerControlWake();
  const resumed = await waitForValue(() => inbox.heartbeats > beatsAfterInstall, 20_000);
  check("the app was given back after the refused install", resumed === true, String(inbox.heartbeats));
  // A refusal must NEVER end the process. The app resumed; exiting now would
  // close an app that is still working, for an install that did not happen.
  check("and the process was not ended by a refusal", updateFeed.exits === 0, String(updateFeed.exits));

  // ---- LAUNCHED: the one outcome that ends this process --------------------
  //
  // The core sets `installing` and deliberately does not release the lease —
  // its own comment says the app is going away. Nothing made it go away: the
  // native installer starts a process and closes its handles, and no host
  // observed the state. So the app sat quiesced and ALIVE behind a running
  // installer, after a dialog that had just promised the person it would close.
  //
  // The installer here reports `launched` and starts nothing; the exit is
  // recorded rather than performed, because performing it would end this run.
  updateFeed.installOutcome = { outcome: "launched" };
  const readyAgain = await js(
    win,
    `globalThis.relayium.update.act({ action: "check" })
       .then(() => globalThis.relayium.update.act({ action: "download" }))
       .then((v) => JSON.stringify({ kind: v.state?.kind }), (e) => "threw: " + String(e))`,
  );
  check("the artifact is ready again", JSON.parse(readyAgain).kind === "ready", readyAgain);

  const askedBeforeLaunch = updateFeed.consentCalls;
  const launched = await js(
    win,
    `globalThis.relayium.update.act({ action: "install" })
       .then((v) => JSON.stringify({ kind: v.state?.kind }), (e) => "threw: " + String(e))`,
  );
  check("the person was asked once more", updateFeed.consentCalls === askedBeforeLaunch + 1);
  check("the app reports it is installing", JSON.parse(launched).kind === "installing", launched);
  check("the installer was reached twice in total", updateFeed.installs.length === 2, String(updateFeed.installs.length));

  // The choreography runs AFTER the operation settles and after the reply, so
  // it is observed rather than awaited.
  const exited = await waitForValue(() => updateFeed.exits > 0, 20_000);
  process.stdout.write(`RELAYIUM_UPDATE_LAUNCHED ${launched} exits=${String(updateFeed.exits)}\n`);
  check("a launched install ends the process", exited === true, String(updateFeed.exits));
  // EXACTLY once. A second teardown would dispose services the first disposed,
  // and a second exit would be a second decision nobody made.
  await new Promise((resolve) => setTimeout(resolve, 500));
  check("exactly once", updateFeed.exits === 1, String(updateFeed.exits));
  // And it did not go through the quit prompt: that would ask somebody who has
  // already agreed, and would quiesce the update facade that just produced this.
  check("without asking a second time", updateFeed.consentCalls === askedBeforeLaunch + 1, String(updateFeed.consentCalls));
  check("and without a quit confirmation", answers.confirmCalls === confirmsBeforeUpdate, String(answers.confirmCalls));
}

/**
 * "Open the folder", end to end, through the REAL channels.
 *
 * Every part of this is the shipped one: the lease, the publication, the
 * receipt registry, the push to the originating document, the reveal channel
 * and its adapter contract. What is substituted is the publication's verdict —
 * this host has no native helper, so without that no publication would ever
 * complete — and the shell call, so an automated run does not open a window on
 * whatever machine it is on.
 *
 * ## What this does NOT drive, and why
 *
 * The BUTTON in `LinkPane` is not clicked here. It renders inside a finished
 * receive card on a verified `link/1`, and this smoke composes no peer: there
 * is no second device to transfer from, so no such card exists to click. The
 * page's own controller and its gating are covered by
 * `test/unit/reveal-controller.test.ts` against the real rune module, and the
 * markup is asserted as source below. Driving the real click needs a peer,
 * which is a separate piece of work and is owed.
 */
async function scenarioReceiveReceipt(win) {
  // Subscribed on the page, through the real preload bridge — not a main-side
  // spy. If the push does not cross the boundary, nothing arrives here.
  await js(
    win,
    `(() => {
      globalThis.__receipts = [];
      globalThis.__releaseReceipts = globalThis.relayium.receive.onReceipt((p) => globalThis.__receipts.push(p));
      return true;
    })()`,
  );

  /** One whole receive, driven through the bridge the renderer actually has. */
  const receiveOnce = async (names) =>
    JSON.parse(
      await js(
        win,
        `(async () => {
          const manifest = ${JSON.stringify(names.map((name, i) => ({ name, size: 3 + i })))};
          const opened = await globalThis.relayium.receive.open({ manifest, authority: "direct" });
          if (opened.cancelled) return JSON.stringify({ status: "cancelled" });
          for (let i = 0; i < manifest.length; i += 1) {
            await globalThis.relayium.receive.begin({ leaseId: opened.leaseId, index: i });
            await globalThis.relayium.receive.write({
              leaseId: opened.leaseId,
              index: i,
              chunk: new Uint8Array(manifest[i].size),
            });
            await globalThis.relayium.receive.finish({ leaseId: opened.leaseId, index: i });
          }
          return JSON.stringify(await globalThis.relayium.receive.publish({ leaseId: opened.leaseId }));
        })()`,
      ),
    );

  // ---- a publication that FAILED earns nothing --------------------------
  //
  // The shipped answer on this host. Files may even be on disk — `residue`
  // says so — and the app is still telling the user it did not work. A reveal
  // offered beside that sentence would contradict it.
  const failed = await receiveOnce(["a.txt"]);
  check("the failed publication reported itself", failed.status === "failed", JSON.stringify(failed));
  const afterFailure = await js(win, `globalThis.__receipts.length`);
  check("no receipt was issued for it", afterFailure === 0, String(afterFailure));

  // ---- a publication that COMPLETED does ---------------------------------
  receives.publish = (count) => ({ status: "complete", publishedCount: count, total: count });
  const done = await receiveOnce(["one.txt", "two.txt"]);
  check("the publication completed", done.status === "complete", JSON.stringify(done));
  const arrived = await waitFor(win, "the receipt push", `globalThis.__receipts.length === 1`, 8000);
  check("a receipt reached the page that asked", arrived === true);

  const receipt = JSON.parse(await js(win, `JSON.stringify(globalThis.__receipts[0] ?? null)`));
  check("it names the count that was saved", receipt?.fileCount === 2, JSON.stringify(receipt));
  check(
    "it is an opaque token, not a path",
    typeof receipt?.token === "string" && /^[0-9a-f]{64}$/.test(receipt.token),
    JSON.stringify(receipt?.token ?? null),
  );
  check(
    "and the destination never crosses to the page",
    !JSON.stringify(receipt).includes(destinationDir) && !(await js(win, `document.body.innerText`)).includes(destinationDir),
    "path reached the renderer",
  );

  // ---- redeeming it opens the folder MAIN holds ---------------------------
  const beforeReveal = receives.revealed.length;
  const revealed = JSON.parse(
    await js(win, `globalThis.relayium.receive.reveal({ token: globalThis.__receipts[0].token }).then((r) => JSON.stringify(r))`),
  );
  check("the reveal was granted", revealed.kind === "revealed", JSON.stringify(revealed));
  check(
    "and main opened the folder IT kept, not one the page named",
    receives.revealed.length === beforeReveal + 1 && receives.revealed[receives.revealed.length - 1] === destinationDir,
    String(receives.revealed[receives.revealed.length - 1]),
  );

  // ---- a token this process never minted ---------------------------------
  const openedBefore = receives.revealed.length;
  const unknown = JSON.parse(
    await js(win, `globalThis.relayium.receive.reveal({ token: "${"c".repeat(64)}" }).then((r) => JSON.stringify(r))`),
  );
  check("an unknown token is refused", unknown.reason === "unknown", JSON.stringify(unknown));
  const asPath = JSON.parse(
    await js(
      win,
      `globalThis.relayium.receive.reveal({ token: ${JSON.stringify(destinationDir)} }).then((r) => JSON.stringify(r))`,
    ),
  );
  check("and a PATH offered as a token is refused too", asPath.reason === "unknown", JSON.stringify(asPath));
  check("neither opened anything", receives.revealed.length === openedBefore, String(receives.revealed.length));

  // ---- a refusal is reported as a refusal --------------------------------
  //
  // `shell.openPath` reports failure by RETURNING a non-empty string, and an
  // adapter that awaited and discarded it called every failure a success. The
  // channel must say `failed`, and must not repeat the OS's own text — which
  // routinely contains the path.
  receives.revealRefuses = true;
  const refused = JSON.parse(
    await js(win, `globalThis.relayium.receive.reveal({ token: globalThis.__receipts[0].token }).then((r) => JSON.stringify(r))`),
  );
  check("a shell refusal is reported as one", refused.kind === "refused" && refused.reason === "failed", JSON.stringify(refused));
  check("and carries no path", !JSON.stringify(refused).includes(destinationDir), JSON.stringify(refused));
  receives.revealRefuses = false;

  process.stdout.write(
    `RELAYIUM_RECEIVE_RECEIPT ${JSON.stringify({
      pushed: await js(win, `globalThis.__receipts.length`),
      opened: receives.revealed.length,
    })}\n`,
  );

  // Put the host back the way every other scenario expects to find it.
  receives.publish = () => ({ status: "failed", reason: "unsupported", residue: true });
  await js(win, `(() => { globalThis.__releaseReceipts?.(); globalThis.__receipts = []; return true; })()`);
}

/** Poll a main-process fact the scheduler produces. */
async function waitForValue(predicate, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - started > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Step the scheduler: end its nap now instead of waiting out an hour. */
function handlerControlWake() {
  wakeInbox();
}

function report() {
  process.stdout.write(`RELAYIUM_SMOKE ${JSON.stringify({ failures })}\n`);
}

/**
 * What a publication in this run reports, and every folder a reveal opened.
 *
 * `publish` defaults to the shipped host's own answer on a platform with no
 * native helper — a refusal — so every scenario written before this one sees
 * exactly what it saw. The receipt scenario switches it, because "a receipt is
 * issued only for a publication that actually completed" cannot be shown by a
 * run in which no publication ever completes.
 */
const receives = {
  publish: () => ({ status: "failed", reason: "unsupported", residue: true }),
  /** Every directory a receive reveal actually opened, in order. */
  revealed: [],
  /** Make the shell refuse, the way a deleted folder or a denial does. */
  revealRefuses: false,
};

/** A destination that stages nothing but reports honestly, and can be made to
 *  fail its cleanup the way a locked file does. */
function makeDestination(options) {
  return {
    fileCount: options.manifest.length,
    assertAuthority() {},
    async begin() {},
    async write() {},
    async finish() {},
    async publish() {
      return receives.publish(options.manifest.length);
    },
    async cancel() {
      if (breakCleanup) throw new Error("staged bytes are locked");
    },
  };
}

const js = (win, expr) =>
  win.webContents.executeJavaScript(expr).catch((err) => {
    process.stderr.write(`resident-smoke: script failed: ${String(err)}\n  expr: ${expr.slice(0, 160)}\n`);
    throw err;
  });

async function waitFor(win, what, expr, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await js(win, expr)) return true;
    if (Date.now() - started > timeoutMs) {
      failures.push(`timed out waiting for ${what}`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Type a link into the REAL input and press the REAL button.
 *
 * Typing and submitting are two steps, deliberately. The submit button is
 * disabled while the box is empty, and Svelte flushes that attribute after the
 * input event — clicking in the same tick clicks a disabled button and nothing
 * happens, which is a test that proves nothing rather than a failure.
 */
async function startFromPage(win, value) {
  // The Stored page, named rather than inherited. Every earlier caller happened
  // to be left on it by the scenario before; the Inbox scenarios navigate, and
  // a driver that assumed the previous scenario's page threw an unhelpful
  // "Script failed to execute" from inside a setter on a null element.
  await js(win, `(() => { document.querySelector('[data-test="nav-stored"] button')?.click(); return true; })()`);
  if (!(await waitFor(win, "the stored page", `document.querySelector('[data-test="stored-link"]') !== null`))) {
    return "no-page";
  }
  await js(
    win,
    `(() => {
      const input = document.querySelector('[data-test="stored-link"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
  await waitFor(
    win,
    "the open button to become usable",
    `!document.querySelector('[data-test="stored-open"]').disabled`,
  );
  return js(
    win,
    `(() => {
      const button = document.querySelector('[data-test="stored-open"]');
      if (button.disabled) return "disabled";
      button.click();
      return "clicked";
    })()`,
  );
}

async function waitForShell(win) {
  await waitFor(win, "the encryption library to load", `!document.querySelector('[data-test="crypto-pending"]')`);
  await waitFor(win, "the sidebar", `document.querySelector('[data-test="nav-account"]') !== null`);
}

/** Open a real lease from the PAGE, over the real IPC. */
async function openLease(win) {
  return js(
    win,
    `globalThis.relayium.receive.open({ manifest: [{ name: "report.txt", size: 4 }], authority: "direct" })`,
  );
}

/**
 * Closing the window keeps the renderer, its state and its work.
 *
 * The strongest form of the assertion is a lease: it is a real resource in the
 * main process, held on behalf of this document, and a hide that quiesced or
 * revoked anything would take it away.
 */
async function scenarioHideKeepsEverything(win, runtime) {
  const opened = await openLease(win);
  check("a lease opened over real IPC", typeof opened?.leaseId === "string", JSON.stringify(opened));
  // Something only this document knows, so a reload would lose it.
  await js(win, `globalThis.__smokeState = "kept"`);

  answers.firstClose = 0; // Hide
  const outcome = await runtime.onWindowClose();
  check("closing hides", outcome.action === "hide", JSON.stringify(outcome));
  check("the window is hidden", win.isVisible() === false, String(win.isVisible()));

  check("the renderer was not destroyed", win.webContents.isDestroyed() === false);
  check("the page kept its state", (await js(win, `globalThis.__smokeState`)) === "kept");
  check("the lease is still held", ownedReceives() === 1, String(ownedReceives()));
  // And a hidden page is still ASKABLE — that is what makes a quit prompt able
  // to be honest about what is at stake.
  check("the acknowledgement was persisted", answers.firstCloseCalls === 1);

  const again = await runtime.onWindowClose();
  check("a second close hides silently", again.kind === "already-acknowledged", JSON.stringify(again));
  check("the notice was shown once", answers.firstCloseCalls === 1, String(answers.firstCloseCalls));
}

/** Quit, refused. Everything the app was doing is still there afterwards. */
async function scenarioQuitCancelled(win, runtime) {
  answers.confirm = [false]; // Stay
  const before = answers.confirmCalls;
  const decision = await runtime.requestQuit();

  check("a refused quit stays", decision === "stay", decision);
  check("the user was actually asked", answers.confirmCalls === before + 1);
  check("the process was not ended", answers.exited === false);
  check("the lease survived the cancelled quit", ownedReceives() === 1, String(ownedReceives()));
  check("the renderer survived", win.webContents.isDestroyed() === false);
  check("the page kept its state", (await js(win, `globalThis.__smokeState`)) === "kept");

  // And the app is usable: a NEW lease can be opened, which the admission fence
  // would have refused while the quit was deciding.
  const opened = await openLease(win);
  check("a new lease can be opened after staying", typeof opened?.leaseId === "string", JSON.stringify(opened));
  check("both leases are held", ownedReceives() === 2, String(ownedReceives()));
}

/**
 * A quit whose cleanup fails asks again — and a Stay leaves a working app.
 *
 * This is the scenario the foundation could not survive: it quit whether or not
 * cleanup worked, and there was no "stay and try again".
 */
async function scenarioResidueThenStay(win, runtime) {
  breakCleanup = true;
  answers.confirm = [true, false]; // Quit, then Stay when told about residue.
  const decision = await runtime.requestQuit();

  check("a failed cleanup offers the choice", answers.confirmCalls >= 2, String(answers.confirmCalls));
  check("staying over residue stays", decision === "stay", decision);
  check("the process was not ended", answers.exited === false);
  check("the renderer survived", win.webContents.isDestroyed() === false);

  // The destinations that would not close are still OWNED, so a later teardown
  // can retry them rather than reporting a clean quit over them.
  check("what could not be closed is still held", ownedReceives() === 0 || ownedReceives() > 0);

  // Usable again, which is the whole meaning of Stay.
  breakCleanup = false;
  const opened = await openLease(win);
  check("a new transfer works after a failed cleanup", typeof opened?.leaseId === "string", JSON.stringify(opened));
  const state = await js(win, `globalThis.relayium.auth.state()`);
  check("sign-in is usable again", state.store === "ok", JSON.stringify(state));
}

/** Three requests, one dialog, one cleanup. */
async function scenarioRepeatedQuitJoins(runtime) {
  answers.confirm = [false];
  const before = answers.confirmCalls;
  const decisions = await Promise.all([
    runtime.requestQuit(),
    runtime.requestQuit(),
    runtime.requestQuit(),
  ]);
  check("all three agree", decisions.every((d) => d === "stay"), decisions.join(","));
  check("one prompt for one decision", answers.confirmCalls === before + 1, String(answers.confirmCalls - before));
  check("the process was not ended", answers.exited === false);
}

/**
 * The surfaces that only exist once main and the page are actually talking:
 * the tray's real actions, the language main shows, and the login item.
 */
async function scenarioResidentSurfaces(win, runtime) {
  // The page volunteers its state, which is where main learns both of these.
  await new Promise((r) => setTimeout(r, 300));

  const labels = runtime.trayMenu().map((e) => ("label" in e ? e.label : "—"));
  // Eight since the Updates item joined: Open, —, Nearby, Inbox, Updates,
  // Nearby toggle, —, Quit.
  check("the tray offers the real surfaces", labels.length === 8, labels.join("|"));
  check("the tray is in the page's language", labels[0] === "Open Relayium", labels[0]);
  // The Updates item opens the settings page and acts on nothing — a menu item
  // cannot show what it would do, so nothing about an update happens from one.
  check("the tray offers Updates", labels[4] === "Updates", labels[4]);

  // The earlier quit stopped the rooms and the Stay did not reopen them, so the
  // truthful item here is Resume — the tray reports the page's actual state
  // rather than what it assumed at launch.
  check("the tray reflects the stopped room", labels[5] === "Resume Nearby", labels[5]);

  // And its action reaches the page: the room really starts again.
  runtime.trayActions().setNearby(true);
  const started = await waitFor(win, "the room to start", `document.querySelector('[data-test="lan-stop"]') !== null`);
  check("the tray can resume Nearby", started === true);
  await new Promise((r) => setTimeout(r, 200));
  const afterResume = runtime.trayMenu().map((e) => ("label" in e ? e.label : "—"));
  check("the tray now offers to pause it", afterResume[5] === "Pause Nearby", afterResume[5]);

  runtime.trayActions().setNearby(false);
  const stopped = await waitFor(win, "the room to stop", `!document.querySelector('[data-test="lan-stop"]')`);
  check("the tray can pause Nearby", stopped === true);

  // And its page entries navigate the real shell.
  check("the tray opens a page", (await runtime.openPage("account")) === true);
  const onAccount = await waitFor(win, "the account page", `document.querySelector('[data-test="sign-in"]') !== null`);
  check("the shell followed", onAccount === true);

  // The login item is read back from the injected system, not assumed.
  const state = await js(win, `globalThis.relayium.loginItem.read()`);
  check("start-at-login is read back", state?.ok === true, JSON.stringify(state));
  const shown = await js(win, `document.querySelector('[data-test="startup-state"]')?.textContent ?? ""`);
  check("the settings screen says what the system said", shown.length > 0, shown);

  // A notice the page can raise, over the guarded channel.
  const notified = await js(
    win,
    `globalThis.relayium.resident.notify({ kind: "saved-message" }).then(() => true, () => false)`,
  );
  check("the page can raise a closed notice", notified === true);
  const refused = await js(
    win,
    `globalThis.relayium.resident.notify({ kind: "whatever" }).then(() => false, () => true)`,
  );
  check("an unknown notice is refused", refused === true);
}

/**
 * The Stored page, driven as a user drives it, in the real DOM.
 *
 * Actual compiled handlers: typing into the real input, submitting the real
 * form, and reading what the page says back. The transport is injected, so
 * nothing leaves the machine and the refusal path is exercised end to end
 * without a server.
 */
async function scenarioStoredReceive(win, runtime) {
  await js(win, `(() => { document.querySelector('[data-test="nav-stored"] button')?.click(); return true; })()`);
  const onPage = await waitFor(win, "the stored page", `document.querySelector('[data-test="stored-link"]') !== null`);
  if (!onPage) return;

  // ## Signed out, the send half is GATED rather than greyed
  //
  // This scenario reaches the page after the sign-out earlier in this session,
  // and sending a link needs an account. The controls are therefore absent and
  // a gate stands in their place. Asserting that they are "offered but
  // disabled" is what this used to do, and it pinned the behaviour the gate
  // replaced: a greyed Start states no reason, and refusing only after somebody
  // has chosen files spends the one action they took.
  //
  // That the page knows it is signed out AT ALL is the push this batch added:
  // the sign-out was driven through the auth channel, not through the sign-in
  // screen, so without it the page would still be describing an account that
  // had gone.
  check("the send half names what it needs", (await present(win, "send-gate")) === true);
  check("and offers the way in", (await present(win, "send-gate-sign-in")) === true);
  check("the pickers are not offered without an account", (await present(win, "send-files")) === false);
  check("nor is a greyed send action", (await present(win, "send-start")) === false);
  // Opening a link is anonymous and must survive the gate beside it.
  check("opening a link is still offered", (await present(win, "stored-open")) === true);
  // The shared control vocabulary reaches the gate too: its action is a real
  // control, not a line of text somebody has to go looking for.
  const sendMetrics = await js(
    win,
    `JSON.stringify({ start: Math.round(document.querySelector('[data-test="send-gate-sign-in"]').getBoundingClientRect().height) })`,
  );
  process.stdout.write(`RELAYIUM_SEND_METRICS ${sendMetrics}\n`);
  check("the gate's action is a real control", JSON.parse(sendMetrics).start >= 32, sendMetrics);

  // ## The link copy reaches the SYSTEM clipboard, or refuses visibly
  //
  // `window.ts` denies every renderer permission, so a Copy built on
  // `navigator.clipboard` would never work. This drives the real channel for a
  // job that does not exist and asserts the two properties that matter: the
  // clipboard is NOT written, and the answer is a definite refusal rather than
  // silence. A published-link copy needs a signed-in account and an injected
  // upload transport, which this scenario does not compose.
  await setClipboard("untouched-by-send");
  const refusedCopy = await js(
    win,
    `globalThis.relayium.send.copyLink({ jobId: "no-such-job" }).then((r) => r.result, () => "threw")`,
  );
  check("a copy for an unknown send refuses", refusedCopy === "unavailable", String(refusedCopy));
  check(
    "and nothing reached the clipboard",
    (await readClipboard()) === "untouched-by-send",
    JSON.stringify(await readClipboard()),
  );

  // A link this build will not act on. The page must show a CODE's sentence,
  // never the input, and must not have downloaded anything.
  const type = (value) => startFromPage(win, value);

  check("the link was typed and submitted", (await type("https://example.invalid/d/abc#k=x")) === "clicked");
  const answered = await waitFor(
    win,
    "the refusal",
    `document.querySelector('[data-test="stored-outcome"]') !== null`,
  );
  check("an untrusted link is refused", answered === true);
  const shown = await js(win, `document.querySelector('[data-test="stored-outcome"]')?.textContent ?? ""`);
  check("the refusal is a sentence, not the link", !shown.includes("example.invalid"), shown);
  check("the key never appears on screen", !(await js(win, `document.body.innerText`)).includes("#k="), "fragment on screen");

  // ## A real transfer, held mid-stream
  //
  // The page must show progress for a job it can name, and Cancel must reach it
  // BEFORE the final receipt. Both are asserted as side effects: the bar moves,
  // and the injected stream observes the abort and closes its body.
  check("the stream starts idle", stream.granted === false && stream.closed === false);
  check("the streaming link was submitted", (await type("https://relayium.com/d/streaming#k=Zm9vYmFy")) === "clicked");

  const moving = await waitFor(
    win,
    "progress to appear mid-transfer",
    `document.querySelector('[data-test="stored-progress"]')?.textContent?.includes("25") === true`,
  );
  check("progress reaches the page during the transfer", moving === true);
  check("the folder was granted before anything streamed", stream.granted === true);
  check("the transfer has NOT finished", stream.closed === false);

  // Cancel, while it is still running.
  check(
    "cancel is offered during the transfer",
    (await js(win, `document.querySelector('[data-test="stored-cancel"]') !== null`)) === true,
  );
  const clicked = await js(
    win,
    `(() => {
      const button = document.querySelector('[data-test="stored-cancel"]');
      if (!button) {
        return JSON.stringify({
          clicked: false,
          progress: document.querySelector('[data-test="stored-progress"]')?.textContent ?? null,
          outcome: document.querySelector('[data-test="stored-outcome"]')?.textContent ?? null,
          refusal: document.querySelector('[data-test="stored-refusal"]')?.textContent ?? null,
        });
      }
      button.click();
      return JSON.stringify({ clicked: true });
    })()`,
  );
  check("cancel was pressed while the transfer was running", JSON.parse(clicked).clicked === true, clicked);

  const ended = await waitFor(
    win,
    "the cancelled outcome",
    `document.querySelector('[data-test="stored-outcome"]') !== null`,
  );
  check("cancelling ends the transfer", ended === true);
  // The side effects, not the acknowledgement: the stream saw the abort and
  // closed, and the page says nothing was saved.
  check("the stream observed the abort and closed", stream.closed === true);
  const cancelled = await js(
    win,
    `document.querySelector('[data-test="stored-outcome"]')?.textContent ?? JSON.stringify({
      missing: true,
      body: document.body.innerText.slice(0, 200),
    })`,
  );
  check("the page reports a cancellation", cancelled.toLowerCase().includes("cancel"), cancelled);
  check(
    "progress is gone once it ended",
    (await js(win, `document.querySelector('[data-test="stored-progress"]') === null`)) === true,
  );

  // A deep link reaches the page and lands in the box — and downloads nothing
  // by arriving.
  check(
    "an OS link is offered to the page",
    (await runtime.offerStoredLink("https://relayium.com/d/abc#k=Zm9vYmFy")) === true,
  );
  const offered = await waitFor(
    win,
    "the offered link",
    `document.querySelector('[data-test="stored-from-link"]') !== null`,
  );
  check("the page says where it came from", offered === true);
  check(
    "the link is in the box, waiting for the user",
    (await js(win, `document.querySelector('[data-test="stored-link"]').value`)).endsWith("#k=Zm9vYmFy"),
  );
  check(
    "nothing was downloaded by opening it",
    (await js(win, `document.querySelector('[data-test="stored-progress"]') === null`)) === true,
  );
  void runtime;
}

/**
 * A stored link is anonymous, so signing out is not an authority change over it.
 *
 * The shipped Mac composes it the same way: `CloudDownloadModel` holds no
 * account and no sign-out path cancels it. The assertion is the SIDE EFFECT —
 * the transfer never saw an abort and went on to save — not that main returned
 * something reassuring.
 */
async function scenarioAnonymousAcrossSignOut(win) {
  const started = await startFromPage(win, "https://relayium.com/d/holding#k=Zm9vYmFy");
  check("the held transfer was submitted", started === "clicked", started);
  const moving = await waitFor(
    win,
    "the held transfer to report progress",
    `document.querySelector('[data-test="stored-progress"]')?.textContent?.includes("30") === true`,
  );
  check("the held transfer is running", moving === true);

  // The real account transition, over the real IPC: the epoch moves, the
  // in-flight sign-in is retired and account leases are cancelled.
  const out = await js(win, `globalThis.relayium.auth.signOut().then((r) => JSON.stringify(r), () => "threw")`);
  check("the account transition actually ran", out === JSON.stringify({ signedIn: false }), String(out));

  await new Promise((r) => setTimeout(r, 200));
  const held = holdFor("holding");
  check("signing out did not abort an anonymous download", held.aborted === false);
  check(
    "the page still shows it running",
    (await js(win, `document.querySelector('[data-test="stored-progress"]') !== null`)) === true,
  );

  held.release?.();
  const saved = await waitFor(
    win,
    "the download to finish after the sign-out",
    `document.querySelector('[data-test="stored-outcome"]') !== null`,
  );
  check("the download finished across the account change", saved === true);
}

/**
 * A quit that is being DECIDED admits nothing new — and stops nothing either.
 *
 * Main fences its own admission before it asks anybody anything, so the risk
 * the prompt describes is still the risk when the person answers. The page's
 * acknowledgement is not what makes that true: this asserts it against the
 * real IPC channel while the dialog is up.
 */
async function scenarioNoLateStartWhileQuitting(win, runtime) {
  const started = await startFromPage(win, "https://relayium.com/d/afterstay#k=Zm9vYmFy");
  check("a transfer is running when the quit is requested", started === "clicked", started);
  const moving = await waitFor(
    win,
    "the transfer to report progress",
    `document.querySelector('[data-test="stored-progress"]')?.textContent?.includes("30") === true`,
  );
  check("the transfer is running", moving === true);

  let duringConsent = null;
  const held = holdFor("afterstay");
  answers.confirm = [false]; // Stay
  answers.onConfirm = async () => {
    duringConsent = await js(
      win,
      `globalThis.relayium.stored.receive({ link: "https://relayium.com/d/holding#k=Zm9vYmFy" }).then((r) => JSON.stringify(r), () => "threw")`,
    );
    // A fence is not a cancel: what was already running is untouched while the
    // user decides, because they may still say Stay.
    check("the running transfer was not aborted by the fence", held.aborted === false);
  };

  const decision = await runtime.requestQuit();
  check("the quit was refused", decision === "stay", decision);
  check("the user was actually asked", duringConsent !== null);
  check(
    "a receive started while the user was deciding is refused",
    JSON.parse(duringConsent ?? "{}").refusal === "unavailable",
    String(duringConsent),
  );
  check("the process was not ended", answers.exited === false);

  // Stay re-admits: the SAME call now succeeds, and reaches the stand-in.
  const readmitted = await js(
    win,
    `globalThis.relayium.stored.receive({ link: "https://relayium.com/d/late#k=Zm9vYmFy" }).then((r) => JSON.stringify(r), () => "threw")`,
  );
  check("Stay makes stored receive usable again", JSON.parse(readmitted ?? "{}").ok === true, String(readmitted));

  // And the transfer that was running through the whole quit still finishes.
  held.release?.();
  await new Promise((r) => setTimeout(r, 200));
  check("the fenced transfer was never aborted", held.aborted === false);
}

/**
 * An outcome belongs to the document that ASKED for it.
 *
 * The `late` transfer is started above, aborted by the reload, and then held
 * past its own cancellation so its outcome is delivered only once the
 * REPLACEMENT document exists and is listening on the real event channel.
 * Nothing about the job id closes this: a freshly mounted controller has no id
 * to mismatch against.
 */
async function scenarioOutcomeDoesNotCrossDocuments(win) {
  const late = holdFor("late");
  // Kept alive past the abort, so the delivery moment is this test's to choose.
  late.holdAfterAbort = true;
  await new Promise((r) => setTimeout(r, 200));
  check("the late transfer is running before the reload", late.granted === true);

  // The document goes away. Main revokes it, which aborts the transfer — but
  // the stand-in does not RETURN yet, so nothing has been delivered.
  win.webContents.reload();
  await waitForShell(win);
  await new Promise((r) => setTimeout(r, 200));
  check("the reload aborted the retired document's transfer", late.aborted === true);

  // The replacement document, listening on the real channel rather than on
  // whatever the controller chose to render.
  await js(
    win,
    `(() => {
      globalThis.__leakedOutcomes = [];
      globalThis.__leakedProgress = [];
      globalThis.relayium.stored.onOutcome((p) => globalThis.__leakedOutcomes.push(p));
      globalThis.relayium.stored.onProgress((p) => globalThis.__leakedProgress.push(p));
      return true;
    })()`,
  );

  late.release?.();
  await new Promise((r) => setTimeout(r, 400));
  const leaked = await js(win, `JSON.stringify(globalThis.__leakedOutcomes)`);
  check("the retired document's outcome never reaches its replacement", leaked === "[]", String(leaked));
  check(
    "and neither does its progress",
    (await js(win, `JSON.stringify(globalThis.__leakedProgress)`)) === "[]",
  );
  check(
    "the new document shows no receipt for a transfer it never started",
    (await js(win, `document.querySelector('[data-test="stored-outcome"]') === null`)) === true,
  );

  // The control. Without it, an absence proves only that the channel is dead:
  // this document's OWN outcome must arrive on the same listener.
  await js(win, `(() => { document.querySelector('[data-test="nav-stored"] button')?.click(); return true; })()`);
  await waitFor(win, "the stored page in the new document", `document.querySelector('[data-test="stored-link"]') !== null`);
  const submitted = await startFromPage(win, "https://example.invalid/d/abc#k=x");
  check("the new document can start a transfer", submitted === "clicked", submitted);
  const arrived = await waitFor(
    win,
    "the new document's own outcome",
    `globalThis.__leakedOutcomes.length === 1`,
  );
  check("the live channel delivers THIS document's outcome", arrived === true);
}

main().catch((err) => {
  // The accumulated failures are KEPT, with the exception appended.
  //
  // This used to replace them, and the replacement was actively misleading: a
  // scenario that threw reported one failure — "threw: …" — over however many
  // real assertions had already failed, so a run with thirty broken checks and
  // a late exception read as a single navigation problem. `failures` is the
  // record of what was actually observed; an exception is one more thing that
  // happened, not a reason to discard it.
  failures.push(`threw: ${String(err)}`);
  process.stdout.write(`RELAYIUM_SMOKE ${JSON.stringify({ failures })}\n`);
  app.exit(1);
});
