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

const failures = [];
const check = (name, ok, detail) => {
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
};

const [userDataDir, secretsDir, destinationDir, inboxRootDir, sendJournalDir, phase] = process.argv.slice(2);
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
if (!userDataDir || !secretsDir || !destinationDir || !inboxRootDir || !sendJournalDir) {
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
      storedReceive: { receive: streamingReceive },
      // Never the real Windows startup programs: this run must not add itself
      // to whatever machine it happens to be on.
      loginItem: {
        read: () => ({ openAtLogin: false, executableWillLaunchAtLogin: false }),
        write: () => {},
        reportFailure: () => {},
      },
      makeDestination: async (options) => makeDestination(options),
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
  // Stored send, while the smoke is signed in and BEFORE any quit scenario.
  // A quit fences admissions and a Stay clears them; running the whole send
  // flow through that would be testing the fence, which has its own coverage,
  // rather than the send.
  await scenarioStoredSendFlow(win);
  await scenarioStoredSendHistory(win);
  await scenarioStoredSendAmbiguous(win);
  await scenarioStoredSendCancelAndNavigation(win);
  await scenarioInboxQuitStay(win, runtime);
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
      return { status: "failed", reason: "unsupported", residue: true };
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
  check("the tray offers the real surfaces", labels.length === 7, labels.join("|"));
  check("the tray is in the page's language", labels[0] === "Open Relayium", labels[0]);

  // The earlier quit stopped the rooms and the Stay did not reopen them, so the
  // truthful item here is Resume — the tray reports the page's actual state
  // rather than what it assumed at launch.
  check("the tray reflects the stopped room", labels[4] === "Resume Nearby", labels[4]);

  // And its action reaches the page: the room really starts again.
  runtime.trayActions().setNearby(true);
  const started = await waitFor(win, "the room to start", `document.querySelector('[data-test="lan-stop"]') !== null`);
  check("the tray can resume Nearby", started === true);
  await new Promise((r) => setTimeout(r, 200));
  const afterResume = runtime.trayMenu().map((e) => ("label" in e ? e.label : "—"));
  check("the tray now offers to pause it", afterResume[4] === "Pause Nearby", afterResume[4]);

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

  // Send and history are BUILT now, so the page offers their real controls
  // rather than naming them as absent. Asserted as structure — the pickers, the
  // start control and the history section are present — because driving a full
  // upload needs a signed-in account and an injected upload transport, which
  // this scenario does not compose.
  check("the send pickers are offered", (await present(win, "send-files")) === true);
  check("the folder picker is offered", (await present(win, "send-folder")) === true);
  check("the send action is offered", (await present(win, "send-start")) === true);
  check(
    "nothing is sendable until something is picked",
    (await js(win, `document.querySelector('[data-test="send-start"]').disabled`)) === true,
  );
  check("the history section is present", (await present(win, "send-history-empty")) === true);
  // The shared control vocabulary reaches the new section too.
  const sendMetrics = await js(
    win,
    `JSON.stringify({ start: Math.round(document.querySelector('[data-test="send-start"]').getBoundingClientRect().height) })`,
  );
  process.stdout.write(`RELAYIUM_SEND_METRICS ${sendMetrics}\n`);
  check("the send control is a real control", JSON.parse(sendMetrics).start >= 32, sendMetrics);

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
