// Owning tests for the composed sender.
//
// SCOPE. These are NOT mocked-API tests dressed up as interop, and they are not
// a real-server run either. What is REAL here: the durable `SendPlanStore` and
// its at-rest crypto, the `SendTransport`'s URL composition/strict parsing over
// a scripted `fetch`, the accepted `UploadEngine` and its frame schedule, and
// the `DeviceTaskByteTransport`'s own `init` request. What is faked: the server
// behind that `fetch`, and the byte sink behind the engine.
//
// Every assertion below is on an OBSERVED side effect — what was persisted, what
// left over the wire byte for byte, whether a release was issued — rather than
// on a returned value alone. A coordinator that reported the right outcome while
// deleting a live delivery's ciphertext would pass a return-value test.
import { describe, expect, it } from "vitest";

import { captureAccount } from "../../src/main/inbox/account.js";
import { newAtRestKeyBytes } from "../../src/main/inbox/atrest.js";
import { SendPlanStore, type PlanFiles, type SendPlanRecord } from "../../src/main/inbox/send-plan.js";
import { SendTransport } from "../../src/main/inbox/send-transport.js";
import {
  MAX_REVOKED_DOCUMENTS,
  SendCoordinator,
  type SendOutcome,
} from "../../src/main/inbox/send-coordinator.js";
import { DeviceTaskByteTransport } from "../../src/main/inbox/send-bytes.js";
import { UploadEngine } from "../../src/main/stored/upload/engine.js";
import type { Fence, UploadAuthority } from "../../src/main/stored/upload/authority.js";
import { planUpload, type UploadPlan } from "../../src/main/stored/upload/plan.js";
import type {
  AppendReceipt,
  FinalizeReceipt,
  InitReceipt,
  UploadByteTransport,
  UploadRetention,
} from "../../src/main/stored/upload/transport.js";
import type { StoredRuntime } from "../../src/main/stored/runtime-contract.js";

const ORIGIN = "https://central.invalid";
const BEARER = "sender-bearer";
const DEVICE = "dev-target";
const SELF = "dev-self";
const ACCOUNT = "person@example.invalid";
const DOCUMENT = "doc-1";

const GEOMETRY = { storeChunkSize: 64, frameOverhead: 20 } as const;
const SEALED_BOX_BYTES = 80;
/** Unpadded base64url of an 80-byte sealed box: what the plan store validates. */
const sealedBox = (letter: string): string => letter.repeat(Math.ceil((4 * SEALED_BOX_BYTES) / 3));

const CAPS = { receiveV3: "inbox.receive.v3", textV1: "inbox.text.v1", keyAlgorithm: "x25519-sealedbox-v1" };
const RETENTION: UploadRetention = { burnAfterRead: false, ttlSeconds: 3600 };

const CONTEXT = captureAccount({ accountID: ACCOUNT, deviceID: SELF, epoch: 1, inboxRoot: "/profile/inbox" });

const AUTHORITY = {
  accountId: ACCOUNT,
  deviceId: SELF,
  documentId: DOCUMENT,
  origin: ORIGIN,
  bearer: BEARER,
};

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A plan file that records every write, and can be made to stall on one. */
class RecordingFiles implements PlanFiles {
  readonly files = new Map<string, Uint8Array>();
  readonly writes: number[] = [];
  /** Resolves before the Nth write completes, so a test can act mid-persist. */
  stallAt: number | null = null;
  private stallGate: (() => void) | null = null;
  readonly stalled: Promise<void>;
  private announceStalled!: () => void;

  constructor() {
    this.stalled = new Promise((resolve) => {
      this.announceStalled = resolve;
    });
  }

  readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    return value === undefined ? Promise.reject(fsError("ENOENT")) : Promise.resolve(value);
  }

  async writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    this.writes.push(this.writes.length + 1);
    if (this.stallAt !== null && this.writes.length === this.stallAt) {
      await new Promise<void>((resolve) => {
        this.stallGate = resolve;
        this.announceStalled();
      });
    }
    this.files.set(path, bytes.slice());
  }

  releaseStall(): void {
    this.stallGate?.();
    this.stallGate = null;
  }

  mkdirp(): Promise<void> {
    return Promise.resolve();
  }
}

interface KeyRow {
  readonly ID: string;
  readonly Generation: number;
  readonly PublicKey: string;
  readonly Algorithm: string;
}

interface TaskRow {
  ID: string;
  TargetDeviceID: string;
  SourceDeviceID: string;
  IdempotencyKey: string;
  StoredFileID: string;
  State: string;
  ErrorCode: string;
  CiphertextBytes: number;
  WrapAlgorithm: string;
  TargetKeyID: string;
  TargetKeyGeneration: number;
  CreatedAt: number;
  ExpiresAt: number;
  SavedAt: number;
  Terminal: boolean;
}

type CreateStep = (body: Record<string, unknown>) => Response | Promise<Response>;

/** The scripted server the real `SendTransport` talks to. */
class FakeCentral {
  autoAccept = "ask";
  revoked = false;
  capabilities: string[] = [CAPS.receiveV3, CAPS.textV1];
  keys: KeyRow[] = [{ ID: "key-1", Generation: 1, PublicKey: "pk-1", Algorithm: CAPS.keyAlgorithm }];
  readonly tasks = new Map<string, TaskRow>();
  /** Every create body, verbatim, in order. Duplicate-retry evidence. */
  readonly createBodies: Record<string, unknown>[] = [];
  readonly log: string[] = [];
  /** Consumed in order; when empty, creates are served idempotently. */
  createScript: CreateStep[] = [];
  deletedTasks: string[] = [];
  /** A create currently held open, so a test can cancel mid-await. */
  onCreateEntered: (() => void) | null = null;
  holdCreate: Promise<void> | null = null;
  onDevicesEntered: (() => void) | null = null;
  holdDevices: Promise<void> | null = null;

  view(row: TaskRow): Record<string, unknown> {
    return { ...row };
  }

  seed(row: Partial<TaskRow> & { ID: string; IdempotencyKey: string; StoredFileID: string }): TaskRow {
    const full: TaskRow = {
      TargetDeviceID: DEVICE,
      SourceDeviceID: SELF,
      State: "queued",
      ErrorCode: "",
      CiphertextBytes: 0,
      WrapAlgorithm: CAPS.keyAlgorithm,
      TargetKeyID: "key-1",
      TargetKeyGeneration: 1,
      CreatedAt: 10,
      ExpiresAt: 1000,
      SavedAt: 0,
      Terminal: false,
      ...row,
    };
    this.tasks.set(full.ID, full);
    return full;
  }

  private commitCreate(body: Record<string, unknown>): Response {
    const key = String(body["idempotencyKey"]);
    for (const row of this.tasks.values()) {
      if (row.IdempotencyKey === key) {
        // The server checks the idempotent replay FIRST, before every refusal.
        return json(200, { task: this.view(row), created: false });
      }
    }
    const row = this.seed({
      ID: `task-${this.tasks.size + 1}`,
      IdempotencyKey: key,
      StoredFileID: String(body["storedFileId"]),
      TargetKeyID: String(body["targetKeyId"]),
      TargetKeyGeneration: Number(body["targetKeyGeneration"]),
    });
    return json(201, { task: this.view(row), created: true });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const signal = init?.signal ?? null;
    this.log.push(`${method} ${url.pathname}${url.search}`);
    if (signal?.aborted === true) throw abortError();

    if (method === "GET" && url.pathname === "/api/devices") {
      if (this.onDevicesEntered !== null) {
        this.onDevicesEntered();
        this.onDevicesEntered = null;
      }
      if (this.holdDevices !== null) await raceAbort(this.holdDevices, signal);
      return json(200, {
        devices: [
          {
            ID: DEVICE,
            Inbox: {
              Capabilities: this.capabilities,
              AutoAccept: this.autoAccept,
              Presence: "offline",
              ProtocolVersion: 3,
              Revoked: this.revoked,
            },
          },
        ],
      });
    }
    if (method === "GET" && url.pathname === `/api/devices/${DEVICE}/inbox/keys`) {
      return json(200, { keys: this.keys });
    }
    if (method === "POST" && url.pathname === `/api/devices/${DEVICE}/inbox/tasks`) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      this.createBodies.push(body);
      if (this.onCreateEntered !== null) {
        this.onCreateEntered();
        this.onCreateEntered = null;
      }
      if (this.holdCreate !== null) await raceAbort(this.holdCreate, signal);
      const step = this.createScript.shift();
      return step === undefined ? this.commitCreate(body) : step(body);
    }
    if (method === "GET" && url.pathname === `/api/devices/${DEVICE}/inbox/tasks`) {
      return json(200, { tasks: [...this.tasks.values()].map((t) => this.view(t)) });
    }
    const single = url.pathname.match(new RegExp(`^/api/devices/${DEVICE}/inbox/tasks/(.+)$`));
    if (single !== null) {
      const row = this.tasks.get(decodeURIComponent(single[1]!));
      if (row === undefined) return json(404, { error: "not_found" });
      if (method === "DELETE") {
        // The real `DeleteInboxTask` refuses only `downloading`/`verifying` —
        // a terminal row IS deletable — and answers `{status:"ok"}` with no
        // task. Both are what the coordinator's cancel path has to handle.
        if (row.State === "downloading" || row.State === "verifying") {
          return json(409, { error: "invalid_transition" });
        }
        this.deletedTasks.push(row.ID);
        this.tasks.delete(row.ID);
        return json(200, { status: "ok" });
      }
      return json(200, { task: this.view(row) });
    }
    return json(404, { error: "not_found" });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function timeoutError(): Error {
  return Object.assign(new Error("timed out"), { name: "TimeoutError" });
}

/** Await `held`, but surface the caller's abort as an abort. */
async function raceAbort(held: Promise<void>, signal: AbortSignal | null): Promise<void> {
  if (signal === null) return held;
  await Promise.race([
    held,
    new Promise<never>((_, reject) => {
      if (signal.aborted) reject(abortError());
      signal.addEventListener("abort", () => reject(abortError()), { once: true });
    }),
  ]);
}

/**
 * The byte sink behind the engine.
 *
 * `init` is deliberately NOT here: the real `DeviceTaskByteTransport` owns that
 * one request and delegates the rest, so the adapter's own `init` is exercised
 * through the harness's fake `fetch` and this class would only be reached if the
 * adapter wrongly delegated it.
 */
class FakeBytes implements UploadByteTransport {
  readonly appends: { from: number; bytes: number }[] = [];
  delegatedInits = 0;
  finalizeCalls = 0;
  received = 0;
  objectId = "obj-1";
  failFinalize: "ambiguous" | null = null;

  async init(): Promise<InitReceipt> {
    this.delegatedInits += 1;
    throw new Error("the device-task adapter must never delegate init");
  }

  async append(
    _uploadId: string,
    from: number,
    _total: number,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<AppendReceipt> {
    if (signal?.aborted === true) throw abortError();
    this.appends.push({ from, bytes: bytes.byteLength });
    this.received = from + bytes.byteLength;
    return { outcome: "committed", received: this.received };
  }

  async status(): Promise<{ received: number } | "gone"> {
    return { received: this.received };
  }

  async finalize(): Promise<FinalizeReceipt> {
    this.finalizeCalls += 1;
    if (this.failFinalize === "ambiguous") return { outcome: "already-finalized" };
    return { outcome: "finalized", id: this.objectId, expiresAt: 9999 };
  }
}

const RUNTIME = {
  constants: { storeChunkSize: GEOMETRY.storeChunkSize, frameOverhead: GEOMETRY.frameOverhead },
} as unknown as StoredRuntime;

/** One ciphertext frame of exactly `total` bytes, prefix declaring `total - 4`. */
function frame(total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  new DataView(bytes.buffer).setUint32(0, total - 4, false);
  bytes.fill(0x5a, 4);
  return bytes;
}

async function feedAll(engine: UploadEngine): Promise<void> {
  for (;;) {
    const next = engine.expects;
    if (next === null) return;
    await engine.feed({ fileIndex: next.fileIndex, seq: next.seq, bytes: frame(next.bytes) });
  }
}

function planFor(sizes: readonly number[]): UploadPlan {
  const result = planUpload(
    sizes.map((size, i) => ({ path: `f${i}.bin`, size })),
    GEOMETRY,
  );
  if (!result.ok) throw new Error(`plan refused: ${JSON.stringify(result.refusal)}`);
  return result.plan;
}

interface Harness {
  readonly coordinator: SendCoordinator;
  readonly central: FakeCentral;
  readonly bytes: FakeBytes;
  readonly files: RecordingFiles;
  readonly plans: SendPlanStore;
  readonly releases: string[];
  /** Every release's ORIGINAL captured authority, so a test can check whose. */
  readonly releaseAuthorities: string[];
  readonly seals: string[];
  /** The sealed boxes `sealToTarget` will hand out, in order. */
  sealQueue: string[];
  releaseFails: boolean;
  /** Held open so a test can inspect the registry while a release is in flight. */
  holdRelease: Promise<void> | null;
  auxiliaryCount(jobID: string): number;
  /** Observe the session recorder `engineFor` is handed. */
  captureRecorder: ((fn: (uploadID: string) => Promise<void>) => void) | null;
  bytesForCalls: number;
  /** The query string of every `POST /api/uploads` the adapter composed. */
  readonly initRequests: string[];
  holdInit: Promise<void> | null;
  onInitEntered: (() => void) | null;
  plan(jobID: string): Promise<SendPlanRecord | null>;
}

async function harness(sizes: readonly number[] = [128]): Promise<Harness> {
  const central = new FakeCentral();
  const bytes = new FakeBytes();
  const files = new RecordingFiles();
  const plans = new SendPlanStore(CONTEXT, files, () => Promise.resolve(KEY_BYTES), SEALED_BOX_BYTES);
  const tasks = new SendTransport({
    context: { origin: ORIGIN, bearer: BEARER, epoch: 1 },
    fetchImpl: central.fetch,
  });
  const uploadPlan = planFor(sizes);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(32), { name: "AES-GCM" }, false, ["encrypt"]);

  const state = {
    releases: [] as string[],
    releaseAuthorities: [] as string[],
    seals: [] as string[],
    sealQueue: [sealedBox("A"), sealedBox("B"), sealedBox("C")],
    releaseFails: false,
    holdRelease: null as Promise<void> | null,
    captureRecorder: null as ((fn: (uploadID: string) => Promise<void>) => void) | null,
    bytesForCalls: 0,
    initRequests: [] as string[],
    holdInit: null as Promise<void> | null,
    onInitEntered: null as (() => void) | null,
  };

  const coordinator: SendCoordinator = new SendCoordinator({
    accountId: ACCOUNT,
    deviceId: SELF,
    // Short, so a test that deliberately hangs an operation still finishes.
    invalidationDrainMs: 60,
    plans,
    tasks,
    bytesFor: () => {
      state.bytesForCalls += 1;
      // The REAL adapter, over the fake sink. Its own `init` request goes
      // through this `fetch`, so the query it composes is observed evidence.
      return new DeviceTaskByteTransport(bytes, ORIGIN, BEARER, {
        fetchImpl: async (input, init) => {
          state.initRequests.push(new URL(String(input)).search);
          if (init?.signal?.aborted === true) throw abortError();
          if (state.holdInit !== null) {
            state.onInitEntered?.();
            state.onInitEntered = null;
            await raceAbort(state.holdInit, init?.signal ?? null);
          }
          return json(200, { uploadId: "up-1", chunkSize: 64 * 1024 });
        },
      });
    },
    engineFor: (
      _jobID: string,
      byteTransport: UploadByteTransport,
      fence: Fence,
      onSession: (uploadID: string) => Promise<void>,
    ): Promise<UploadEngine> => {
      state.captureRecorder?.(onSession);
      return UploadEngine.open({
        runtime: RUNTIME,
        key,
        sealedManifest: new Uint8Array([1, 2, 3]),
        plan: uploadPlan,
        retention: RETENTION,
        transport: byteTransport,
        fence,
        hooks: { onSession },
      });
    },
    sealToTarget: (_jobID, target) => {
      const sealed = state.sealQueue.shift() ?? sealedBox("Z");
      state.seals.push(`${target.key.keyID}#${target.key.generation}`);
      return Promise.resolve(sealed);
    },
    releaseObject: async (objectID: string, authority: UploadAuthority, signal: AbortSignal) => {
      if (signal.aborted) throw abortError();
      if (state.holdRelease !== null) await raceAbort(state.holdRelease, signal);
      if (state.releaseFails) throw new Error("node offline");
      state.releases.push(objectID);
      state.releaseAuthorities.push(`${authority.accountId}/${authority.deviceId}`);
    },
    runtimeCaps: CAPS,
    protocolVersion: 3,
    retention: RETENTION,
    now: () => 1_000,
  });

  return {
    coordinator,
    central,
    bytes,
    files,
    plans,
    get releases() {
      return state.releases;
    },
    get releaseAuthorities() {
      return state.releaseAuthorities;
    },
    get seals() {
      return state.seals;
    },
    get sealQueue() {
      return state.sealQueue;
    },
    set sealQueue(next: string[]) {
      state.sealQueue = next;
    },
    get releaseFails() {
      return state.releaseFails;
    },
    set releaseFails(next: boolean) {
      state.releaseFails = next;
    },
    get holdRelease() {
      return state.holdRelease;
    },
    set holdRelease(next: Promise<void> | null) {
      state.holdRelease = next;
    },
    get captureRecorder() {
      return state.captureRecorder;
    },
    set captureRecorder(next: ((fn: (uploadID: string) => Promise<void>) => void) | null) {
      state.captureRecorder = next;
    },
    auxiliaryCount: (jobID: string) =>
      ((coordinator as unknown as { jobs: Map<string, { auxiliary: Map<string, unknown> }> }).jobs.get(jobID)
        ?.auxiliary.size ?? 0),
    get bytesForCalls() {
      return state.bytesForCalls;
    },
    get initRequests() {
      return state.initRequests;
    },
    get holdInit() {
      return state.holdInit;
    },
    set holdInit(next: Promise<void> | null) {
      state.holdInit = next;
    },
    get onInitEntered() {
      return state.onInitEntered;
    },
    set onInitEntered(next: (() => void) | null) {
      state.onInitEntered = next;
    },
    plan: (jobID) => plans.find(jobID),
  } as Harness;
}

const KEY_BYTES = newAtRestKeyBytes();

const JOB = {
  jobID: "job-1",
  targetDeviceID: DEVICE,
  kind: "file" as const,
  idempotencyKey: "idem-1",
  manifestDigest: "digest-1",
  authority: AUTHORITY,
};

/** Let the event loop turn, so an in-flight await can actually be in flight. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("send coordinator — the composed workflow", () => {
  it("checks eligibility BEFORE a byte is encrypted, and stages nothing when it refuses", async () => {
    const h = await harness();
    h.central.autoAccept = "off";

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({ kind: "refused", reason: "auto_receive_disabled", retryable: true });
    // The observable point: no byte transport was ever constructed, no init was
    // sent, and no plan reached disk.
    expect(h.bytesForCalls).toBe(0);
    expect(h.initRequests).toEqual([]);
    expect(h.files.writes).toHaveLength(0);
    expect(await h.plan("job-1")).toBeNull();
  });

  it("drives a delivery in the accepted order and records the task before releasing anything", async () => {
    const h = await harness();

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({ kind: "delivered", created: true });
    const plan = await h.plan("job-1");
    expect(plan).toMatchObject({
      phase: "created",
      taskID: "task-1",
      storedObjectID: "obj-1",
      uploadID: "up-1",
      manifestDigest: "digest-1",
      wrappedKey: sealedBox("A"),
    });
    // Eligibility ran twice: once before the bytes, once for the key the seal
    // used. The seal is the LAST step before the durable request.
    expect(h.central.log.filter((line) => line.startsWith("GET /api/devices?"))).toHaveLength(0);
    expect(h.central.log.filter((line) => line === "GET /api/devices")).toHaveLength(2);
    expect(h.initRequests).toEqual(["?purpose=device_task&burnAfterRead=0&ttl=3600&size=168"]);
    expect(h.bytes.delegatedInits).toBe(0);
    expect(h.bytes.finalizeCalls).toBe(1);
    expect(h.releases).toEqual([]);
    // The create carried exactly the declared fields, and the persisted box.
    expect(h.central.createBodies[0]).toEqual({
      idempotencyKey: "idem-1",
      storedFileId: "obj-1",
      protocolVersion: 3,
      wrapAlgorithm: CAPS.keyAlgorithm,
      wrappedKey: sealedBox("A"),
      targetKeyId: "key-1",
      targetKeyGeneration: 1,
    });
  });

  it("delivers a selection in which every item is empty", async () => {
    const h = await harness([0, 0, 0]);

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({ kind: "delivered", created: true });
    // A zero-byte file owes no frames, so the object is the manifest alone —
    // and it is still a real object that a real task binds.
    expect(h.bytes.appends).toEqual([]);
    expect(h.initRequests).toEqual(["?purpose=device_task&burnAfterRead=0&ttl=3600&size=0"]);
    expect(h.bytes.finalizeCalls).toBe(1);
    expect(await h.plan("job-1")).toMatchObject({ phase: "created", storedObjectID: "obj-1" });
  });

  it("refuses to re-run a job whose selection changed under its content key", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;
    h.coordinator.release("job-1");

    // Same job id, same key, DIFFERENT document.
    const second = h.coordinator.deliver({ ...JOB, manifestDigest: "digest-2" }, feedAll);
    await expect(second.done).resolves.toMatchObject({ kind: "unknown" });
    expect(h.initRequests).toHaveLength(1);
  });
});

describe("send coordinator — a lost create response", () => {
  it("converges on the task central already holds, and releases nothing", async () => {
    const h = await harness();
    // Three answers nobody can read. The row is committed on the first one.
    h.central.createScript = [
      (body) => {
        h.central.seed({
          ID: "task-live",
          IdempotencyKey: String(body["idempotencyKey"]),
          StoredFileID: String(body["storedFileId"]),
        });
        throw timeoutError();
      },
      () => {
        throw timeoutError();
      },
      () => {
        throw timeoutError();
      },
    ];

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({ kind: "delivered", created: false });
    expect((outcome as { task: { ID: string } }).task.ID).toBe("task-live");
    expect(await h.plan("job-1")).toMatchObject({ phase: "created", taskID: "task-live" });
    // The whole point: a timed-out create is NOT a refusal.
    expect(h.releases).toEqual([]);
    expect(h.central.createBodies).toHaveLength(3);
  });

  it("repeats the SAME request byte for byte, never a re-sealed one", async () => {
    const h = await harness();
    h.central.createScript = [
      () => {
        throw timeoutError();
      },
      () => {
        throw timeoutError();
      },
    ];

    await h.coordinator.deliver(JOB, feedAll).done;

    expect(h.central.createBodies).toHaveLength(3);
    expect(h.central.createBodies[1]).toEqual(h.central.createBodies[0]);
    expect(h.central.createBodies[2]).toEqual(h.central.createBodies[0]);
    // One seal, because `sameInboxTaskRequest` compares the wrapped key.
    expect(h.seals).toEqual(["key-1#1"]);
  });

  it("reports an honest unknown when the bounded page does not name it", async () => {
    const h = await harness();
    h.central.createScript = [3, 2, 1].map(() => () => {
      throw timeoutError();
    });

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toEqual({ kind: "unknown", reason: "not-in-recent-window" });
    // Absence in a bounded page is not proof, so nothing is released and the
    // exact request survives for the next attempt.
    expect(h.releases).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({
      phase: "creating",
      wrappedKey: sealedBox("A"),
      storedObjectID: "obj-1",
      taskID: "",
    });
  });

  it("never adopts a row that shares the key but names another object", async () => {
    const h = await harness();
    h.central.createScript = [1, 2, 3].map(() => () => {
      throw timeoutError();
    });
    // Same idempotency key, a DIFFERENT stored object: central would have
    // refused this as `idempotency_key_conflict`, so it is not our delivery.
    h.central.seed({ ID: "task-other", IdempotencyKey: "idem-1", StoredFileID: "obj-somebody-else" });

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toEqual({ kind: "unknown", reason: "not-in-recent-window" });
    expect(await h.plan("job-1")).toMatchObject({ taskID: "" });
  });
});

describe("send coordinator — a resumed create", () => {
  /** Leave a plan exactly where a process that died mid-create left it. */
  async function leaveAtCreating(h: Harness): Promise<void> {
    await h.plans.stage({
      jobID: "job-1",
      targetDeviceID: DEVICE,
      kind: "file",
      idempotencyKey: "idem-1",
      targetKeyID: "key-1",
      targetKeyGeneration: 1,
      now: 1,
    });
    await h.plans.advance("job-1", "uploading", { manifestDigest: "digest-1" }, 2);
    await h.plans.advance("job-1", "uploaded", { storedObjectID: "obj-1" }, 3);
    await h.plans.advance(
      "job-1",
      "creating",
      { wrappedKey: sealedBox("A"), protocolVersion: 3, wrapAlgorithm: CAPS.keyAlgorithm },
      4,
    );
  }

  it("converges on the server-held task even though the target has rotated, resealing nothing and releasing nothing", async () => {
    const h = await harness();
    await leaveAtCreating(h);
    // The earlier attempt DID commit; its answer was lost.
    h.central.seed({ ID: "task-live", IdempotencyKey: "idem-1", StoredFileID: "obj-1" });
    // And the target rotated in the meantime.
    h.central.keys = [{ ID: "key-2", Generation: 2, PublicKey: "pk-2", Algorithm: CAPS.keyAlgorithm }];

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toMatchObject({ kind: "delivered", created: false });
    expect((outcome as { task: { ID: string } }).task.ID).toBe("task-live");
    // A rotation is not evidence about the earlier attempt. Nothing was
    // re-sealed, no changed request went out, and the ciphertext a live task
    // owns was not touched.
    expect(h.seals).toEqual([]);
    expect(h.central.createBodies).toEqual([]);
    expect(h.releases).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "created", taskID: "task-live", wrappedKey: sealedBox("A") });
  });

  it("repeats the persisted request first, and reseals only after central refuses it", async () => {
    const h = await harness();
    await leaveAtCreating(h);
    h.central.keys = [{ ID: "key-2", Generation: 2, PublicKey: "pk-2", Algorithm: CAPS.keyAlgorithm }];
    // No row exists, so the identical retry reaches a refusal — which PROVES the
    // earlier attempt committed nothing, because the replay check runs first.
    h.central.createScript = [() => json(409, { error: "stale_target_key" })];
    h.sealQueue = [sealedBox("B")];

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toMatchObject({ kind: "delivered", created: true });
    expect(h.central.createBodies).toHaveLength(2);
    // The FIRST request out is byte-identical to what was persisted.
    expect(h.central.createBodies[0]).toMatchObject({ wrappedKey: sealedBox("A"), targetKeyId: "key-1" });
    // Only the second follows the rotation.
    expect(h.central.createBodies[1]).toMatchObject({ wrappedKey: sealedBox("B"), targetKeyId: "key-2" });
    expect(h.releases).toEqual([]);
  });

  it("does not release an object when the identical retry is merely unanswered", async () => {
    const h = await harness();
    await leaveAtCreating(h);
    h.central.keys = [{ ID: "key-9", Generation: 9, PublicKey: "pk-9", Algorithm: CAPS.keyAlgorithm }];
    h.central.createScript = [1, 2, 3].map(() => () => {
      throw Object.assign(new Error("socket"), { name: "TypeError" });
    });

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toEqual({ kind: "unknown", reason: "not-in-recent-window" });
    expect(h.releases).toEqual([]);
    expect(h.seals).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "creating", wrappedKey: sealedBox("A") });
  });

  it("reads the recorded task rather than creating a second one", async () => {
    const h = await harness();
    await leaveAtCreating(h);
    const row = h.central.seed({ ID: "task-live", IdempotencyKey: "idem-1", StoredFileID: "obj-1" });
    await h.plans.advance("job-1", "created", { taskID: row.ID }, 5);

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toMatchObject({ kind: "delivered", created: false });
    expect(h.central.createBodies).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "settled" });
  });
});

describe("send coordinator — key rotation", () => {
  it("follows one rotation discovered before the create", async () => {
    const h = await harness();
    const delivery = h.coordinator.deliver(JOB, feedAll);
    // Rotate while the ciphertext is on the wire: the post-upload read sees it.
    h.central.keys = [{ ID: "key-2", Generation: 2, PublicKey: "pk-2", Algorithm: CAPS.keyAlgorithm }];

    const outcome = await delivery.done;

    expect(outcome).toMatchObject({ kind: "delivered" });
    expect(h.central.createBodies[0]).toMatchObject({ targetKeyId: "key-2", targetKeyGeneration: 2 });
    expect(await h.plan("job-1")).toMatchObject({ resealed: false, targetKeyID: "key-2" });
  });

  it("stops at a second rotation and releases an object nothing can bind", async () => {
    const h = await harness();
    // Stage a plan that already followed one rotation and has NOT attempted a
    // create — so the object is provably unbound.
    await h.plans.stage({
      jobID: "job-1",
      targetDeviceID: DEVICE,
      kind: "file",
      idempotencyKey: "idem-1",
      targetKeyID: "key-2",
      targetKeyGeneration: 2,
      now: 1,
    });
    await h.plans.advance("job-1", "uploading", { manifestDigest: "digest-1" }, 2);
    await h.plans.advance(
      "job-1",
      "uploaded",
      {
        storedObjectID: "obj-1",
        wrappedKey: sealedBox("A"),
        protocolVersion: 3,
        wrapAlgorithm: CAPS.keyAlgorithm,
        resealed: true,
      },
      3,
    );
    h.central.keys = [{ ID: "key-3", Generation: 3, PublicKey: "pk-3", Algorithm: CAPS.keyAlgorithm }];

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: "stale-target-key",
      releasedObject: true,
      orphanedObject: false,
    });
    expect(h.central.createBodies).toEqual([]);
    expect(h.releases).toEqual(["obj-1"]);
    // `abandoned`, not `settled`, and the id cleared only because the release
    // was OBSERVED to succeed.
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned", storedObjectID: "" });
  });

  it("answers a server stale_target_key with one reseal that does not spend the ambiguous budget", async () => {
    const h = await harness();
    h.central.createScript = [
      () => json(409, { error: "stale_target_key" }),
      () => {
        throw timeoutError();
      },
      () => {
        throw timeoutError();
      },
    ];

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    // Reseal, then two ambiguous answers, then the third attempt commits: the
    // reseal did not consume one of the three.
    expect(outcome).toMatchObject({ kind: "delivered" });
    expect(h.central.createBodies).toHaveLength(4);
    expect(h.seals).toEqual(["key-1#1", "key-1#1"]);
    expect(h.releases).toEqual([]);
  });
});

describe("send coordinator — cancellation and account change", () => {
  it("aborts and JOINS an init that is still in flight, and never claims nothing exists", async () => {
    const h = await harness();
    h.holdInit = new Promise<void>(() => undefined); // never resolves
    const entered = new Promise<void>((resolve) => {
      h.onInitEntered = resolve;
    });

    const delivery = h.coordinator.deliver(JOB, feedAll);
    await entered;

    const cancelled = await h.coordinator.cancel("job-1");
    const outcome = await delivery.done;

    expect(delivery.fence.valid).toBe(false);
    expect(delivery.fence.reason).toBe("cancelled");
    // The upload was initiated, so the plan may not claim nothing exists.
    const plan = await h.plan("job-1");
    expect(plan?.phase === "uploading" || plan?.phase === "upload-unknown").toBe(true);
    expect(h.releases).toEqual([]);
    expect(cancelled).toMatchObject({ kind: "unknown" });
    expect(outcome.kind === "cancelled" || outcome.kind === "unknown").toBe(true);
    // Joined: no append followed the cancellation.
    await tick();
    expect(h.bytes.appends).toEqual([]);
  });

  it("reaches a job registered in the same tick, before its first request", async () => {
    const h = await harness();
    const delivery = h.coordinator.deliver(JOB, feedAll);
    // No await in between: synchronous admission is what makes this reachable.
    h.coordinator.invalidateDocument(DOCUMENT);

    const outcome = await delivery.done;

    expect(delivery.fence.reason).toBe("document-revoked");
    expect(outcome).toEqual({ kind: "unknown", reason: "revoked:document-revoked" });
    expect(h.central.log).toEqual([]);
    expect(await h.plan("job-1")).toBeNull();
  });

  it("revokes a job whose account changed while the eligibility read was in flight", async () => {
    const h = await harness();
    const released = { resolve: (): void => undefined };
    h.central.holdDevices = new Promise<void>((resolve) => {
      released.resolve = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      h.central.onDevicesEntered = resolve;
    });

    const delivery = h.coordinator.deliver(JOB, feedAll);
    await entered;
    h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });
    released.resolve();

    const outcome = await delivery.done;

    expect(delivery.fence.reason).toBe("account-changed");
    expect(outcome).toEqual({ kind: "unknown", reason: "revoked:account-changed" });
    // Nothing was staged under an authority that had already been replaced.
    expect(await h.plan("job-1")).toBeNull();
    expect(h.bytesForCalls).toBe(0);
  });

  it("revokes a job whose account changed while the plan was being persisted", async () => {
    const h = await harness();
    h.files.stallAt = 1;

    const delivery = h.coordinator.deliver(JOB, feedAll);
    await h.files.stalled;
    h.coordinator.invalidateAccount({ accountId: ACCOUNT, deviceId: "another-device" });
    h.files.releaseStall();

    const outcome = await delivery.done;

    expect(outcome).toEqual({ kind: "unknown", reason: "revoked:account-changed" });
    // The write DID land. A staged plan is safe — nothing was attempted — and
    // pretending it had not been written would be the lie.
    expect(await h.plan("job-1")).toMatchObject({ phase: "staged" });
    expect(h.initRequests).toEqual([]);
  });

  it("leaves an in-flight create unresolved rather than releasing its object", async () => {
    const h = await harness();
    const gate = new Promise<void>(() => undefined);
    h.central.holdCreate = gate;
    const entered = new Promise<void>((resolve) => {
      h.central.onCreateEntered = resolve;
    });

    const delivery = h.coordinator.deliver(JOB, feedAll);
    await entered;
    const cancelled = await h.coordinator.cancel("job-1");
    const outcome = await delivery.done;

    expect(cancelled).toEqual({ kind: "unknown", reason: "create-outcome-unresolved" });
    expect(outcome.kind).toBe("unknown");
    // The exact request survives, and the ciphertext with it.
    expect(await h.plan("job-1")).toMatchObject({
      phase: "creating",
      wrappedKey: sealedBox("A"),
      storedObjectID: "obj-1",
    });
    expect(h.releases).toEqual([]);
  });

  it("cancels a created task through central, and reports a race to terminal truthfully", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;

    const cancelled = await h.coordinator.cancel("job-1");

    expect(cancelled).toEqual({ kind: "cancelled", task: null });
    expect(h.central.deletedTasks).toEqual(["task-1"]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "settled" });
  });

  it("does not call a delivery cancelled when the receiver already saved it", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;
    const row = h.central.tasks.get("task-1")!;
    row.State = "saved";
    row.Terminal = true;

    const cancelled = await h.coordinator.cancel("job-1");

    // Central would happily DELETE a terminal row — it refuses only a live
    // lease — so reading the state first is the ONLY thing standing between the
    // user and "your transfer was cancelled" about files already on the far
    // device. The row is left alone.
    expect(cancelled).toMatchObject({ kind: "delivered", created: false });
    expect((cancelled as { task: { State: string } }).task.State).toBe("saved");
    expect(h.central.deletedTasks).toEqual([]);
    expect(h.central.tasks.has("task-1")).toBe(true);
  });

  it("reports a live receiver lease as a refusal to retry, not a failure", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;
    h.central.tasks.get("task-1")!.State = "downloading";

    const cancelled = await h.coordinator.cancel("job-1");

    // `DeleteInboxTask`: "once a receiver holds a live lease, neither its task
    // nor its ciphertext is removed underneath it."
    expect(cancelled).toMatchObject({ kind: "refused", reason: "task_in_progress", retryable: true });
    expect(h.central.deletedTasks).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "created", taskID: "task-1" });
  });

  it("releases a finalized object no create has been attempted against", async () => {
    const h = await harness();
    await h.plans.stage({
      jobID: "job-1",
      targetDeviceID: DEVICE,
      kind: "file",
      idempotencyKey: "idem-1",
      targetKeyID: "key-1",
      targetKeyGeneration: 1,
      now: 1,
    });
    await h.plans.advance("job-1", "uploading", { manifestDigest: "digest-1" }, 2);
    await h.plans.advance("job-1", "uploaded", { storedObjectID: "obj-1" }, 3);

    // Not live in this process: the authority is required, never inferred.
    expect(() => h.coordinator.cancel("job-1")).toThrow(/no authority/);
    const cancelled = await h.coordinator.cancel("job-1", AUTHORITY);

    expect(cancelled).toMatchObject({ kind: "refused", releasedObject: true, orphanedObject: false });
    expect(h.releases).toEqual(["obj-1"]);
    // Released under the job's own captured authority, never an ambient one.
    expect(h.releaseAuthorities).toEqual([`${ACCOUNT}/${SELF}`]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned", storedObjectID: "" });
  });
});

describe("send coordinator — finality and cleanup", () => {
  it("releases the object a POST-REPLAY refusal proves nothing can bind", async () => {
    const h = await harness();
    h.central.createScript = [() => json(409, { error: "device_inbox_revoked" })];

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: "device_inbox_revoked",
      releasedObject: true,
      orphanedObject: false,
      retryable: false,
    });
    expect(h.releases).toEqual(["obj-1"]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned", storedObjectID: "" });
  });

  it("keeps naming ciphertext it could not release, and never claims it did", async () => {
    const h = await harness();
    h.central.createScript = [() => json(409, { error: "device_inbox_revoked" })];
    h.releaseFails = true;

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({ kind: "refused", releasedObject: false, orphanedObject: true });
    // The object is still named, so a host can report what was left — and the
    // plan is `abandoned`, which `safeToDrop` refuses.
    const stuck = await h.plan("job-1");
    expect(stuck).toMatchObject({ phase: "abandoned", storedObjectID: "obj-1" });
    await expect(h.plans.forget("job-1")).rejects.toMatchObject({ code: "illegal-transition" });

    h.releaseFails = false;
    expect(await h.coordinator.cleanup("job-1")).toEqual({ released: true, supported: true });
    expect(h.releases).toEqual(["obj-1"]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned", storedObjectID: "" });
    expect(await h.plans.forget("job-1")).toBe(true);
  });

  it("retains everything when the target's queue is full, and the retry is the same request", async () => {
    const h = await harness();
    h.central.createScript = [() => json(429, { error: "inbox_queue_full", maxPendingTasks: 256 })];

    const first = await h.coordinator.deliver(JOB, feedAll).done;

    expect(first).toMatchObject({
      kind: "refused",
      reason: "inbox_queue_full",
      releasedObject: false,
      retryable: true,
    });
    expect(h.releases).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "creating", wrappedKey: sealedBox("A") });

    h.coordinator.release("job-1");
    const second = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(second).toMatchObject({ kind: "delivered", created: true });
    expect(h.central.createBodies[1]).toEqual(h.central.createBodies[0]);
    expect(h.seals).toEqual(["key-1#1"]);
  });

  it("keeps the object when central says another task already owns it", async () => {
    const h = await harness();
    h.central.createScript = [() => json(409, { error: "stored_object_already_bound" })];

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: "stored_object_already_bound",
      releasedObject: false,
    });
    expect(h.releases).toEqual([]);
  });

  it("refuses to create against an unresolved finalize, and discard is the only exit", async () => {
    const h = await harness();
    h.bytes.failFinalize = "ambiguous";

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({ kind: "unknown" });
    expect(await h.plan("job-1")).toMatchObject({ phase: "upload-unknown", storedObjectID: "" });
    expect(h.central.createBodies).toEqual([]);

    const discarded = await h.coordinator.discard("job-1");
    expect(discarded).toMatchObject({
      kind: "refused",
      reason: "upload-outcome-unresolved",
      releasedObject: false,
    });
    // Nothing was released, because nothing could be named.
    expect(h.releases).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned" });
  });

  it("settles a delivery central no longer holds without claiming a release", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;
    h.central.tasks.clear();
    expect(h.coordinator.release("job-1")).toBe(true);

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toMatchObject({ kind: "refused", reason: "no-task", releasedObject: false });
    expect(h.releases).toEqual([]);
  });
});

describe("send coordinator — the lifecycle a host can await", () => {
  it("bounds live jobs BEFORE any eligibility read", async () => {
    const h = await harness();
    const small = new SendCoordinator({
      accountId: ACCOUNT,
      deviceId: SELF,
      plans: h.plans,
      tasks: new SendTransport({ context: { origin: ORIGIN, bearer: BEARER, epoch: 1 }, fetchImpl: h.central.fetch }),
      bytesFor: () => {
        throw new Error("unreachable");
      },
      engineFor: (): Promise<UploadEngine> => {
        throw new Error("unreachable");
      },
      sealToTarget: () => Promise.resolve(sealedBox("A")),
      releaseObject: () => Promise.resolve(),
      runtimeCaps: CAPS,
      protocolVersion: 3,
      retention: RETENTION,
      maxLiveJobs: 1,
      now: () => 1_000,
    });
    h.central.holdDevices = new Promise<void>(() => undefined);
    const entered = new Promise<void>((resolve) => {
      h.central.onDevicesEntered = resolve;
    });

    const first = small.deliver(JOB, feedAll);
    await entered;
    expect(() => small.deliver({ ...JOB, jobID: "job-2", idempotencyKey: "idem-2" }, feedAll)).toThrow(
      /too many live jobs/,
    );
    // The refusal cost no request at all: the second job never reached the wire,
    // so the bound is enforced before the IO rather than after a plan exists.
    await tick();
    expect(h.central.log.filter((line) => line === "GET /api/devices")).toHaveLength(1);
    expect(small.isLive("job-2")).toBe(false);
    await small.dispose();
    await first.done;
  });

  it("refuses a job for another account before anything is captured", async () => {
    const h = await harness();
    expect(() =>
      h.coordinator.deliver({ ...JOB, authority: { ...AUTHORITY, accountId: "other@example.invalid" } }, feedAll),
    ).toThrow(/another identity/);
    expect(h.coordinator.isLive("job-1")).toBe(false);
    expect(h.central.log).toEqual([]);
  });

  it("blocks a job id from being reopened underneath its own owners", async () => {
    const h = await harness();
    h.central.holdDevices = new Promise<void>(() => undefined);

    const first = h.coordinator.deliver(JOB, feedAll);
    expect(() => h.coordinator.deliver(JOB, feedAll)).toThrow(/already live/);
    // Nor may it be forgotten while its work runs.
    expect(h.coordinator.isBusy("job-1")).toBe(true);
    expect(h.coordinator.release("job-1")).toBe(false);

    await h.coordinator.dispose();
    await first.done;
    expect(h.coordinator.isLive("job-1")).toBe(false);
  });

  it("joins the work an account change interrupted before it resolves", async () => {
    const h = await harness();
    let releaseDevices = (): void => undefined;
    h.central.holdDevices = new Promise<void>((resolve) => {
      releaseDevices = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      h.central.onDevicesEntered = resolve;
    });

    const delivery = h.coordinator.deliver(JOB, feedAll);
    await entered;

    const drained = h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });
    // The revocation is synchronous; the JOIN is what the returned promise is.
    expect(delivery.fence.reason).toBe("account-changed");
    expect(h.coordinator.isBusy("job-1")).toBe(true);
    releaseDevices();
    await drained;

    // Nothing is still running by the time a host may sign the next account in.
    expect(h.coordinator.isBusy("job-1")).toBe(false);
    await expect(delivery.done).resolves.toMatchObject({ kind: "unknown" });
  });

  it("preserves a failed cleanup that dispose interrupts", async () => {
    const h = await harness();
    h.central.createScript = [() => json(409, { error: "device_inbox_revoked" })];
    h.releaseFails = true;
    await h.coordinator.deliver(JOB, feedAll).done;
    h.releaseFails = false;

    // `dispose` aborts the teardown controller, so the release in flight ends —
    // and because only an OBSERVED release is recorded, the orphan stays named.
    await h.coordinator.dispose();
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned", storedObjectID: "obj-1" });
    expect(() => h.coordinator.cleanup("job-1", AUTHORITY)).toThrow(/disposed/);
  });

  it("quiesces without revoking anything", async () => {
    const h = await harness();
    const delivery = h.coordinator.deliver(JOB, feedAll);

    await h.coordinator.quiesce();

    expect(h.coordinator.isBusy("job-1")).toBe(false);
    expect(delivery.fence.valid).toBe(true);
    await expect(delivery.done).resolves.toMatchObject({ kind: "delivered" });
    expect(await h.coordinator.retire("job-1")).toBe(true);
  });

  it("refuses to start new work once disposed", async () => {
    const h = await harness();
    await h.coordinator.dispose();
    expect(() => h.coordinator.deliver(JOB, feedAll)).toThrow(/disposed/);
    expect(() => h.coordinator.resume("job-1", AUTHORITY)).toThrow(/disposed/);
    expect(h.central.log).toEqual([]);
  });
});

describe("send coordinator — reclamation is central's", () => {
  /**
   * The server refuses a client-side delete of a task-purpose object.
   *
   * `handleDeleteFile` fails closed on any purpose but `share`, with its own
   * reason: "a concurrent task create could bind it between that read and blob
   * removal". So a host with no release hook at all is the ORDINARY case, and
   * the coordinator must report the object it left rather than claim one.
   */
  async function withoutReleaseHook(): Promise<Harness> {
    const h = await harness();
    (h.coordinator as unknown as { options: { releaseObject?: unknown } }).options.releaseObject = undefined;
    return h;
  }

  it("reports the object it left when no release is possible", async () => {
    const h = await withoutReleaseHook();
    h.central.createScript = [() => json(409, { error: "device_inbox_revoked" })];

    const outcome = await h.coordinator.deliver(JOB, feedAll).done;

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: "device_inbox_revoked",
      releasedObject: false,
      orphanedObject: true,
    });
    expect(h.releases).toEqual([]);
    // Named, so a host can say what was left for central's collector.
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned", storedObjectID: "obj-1" });
    // A host must not build a retry button on an action that answers false
    // forever: `supported` says so outright.
    expect(await h.coordinator.cleanup("job-1")).toEqual({ released: false, supported: false });
  });

  it("lets a host close its own record without claiming the object is gone", async () => {
    const h = await withoutReleaseHook();
    h.central.createScript = [() => json(409, { error: "device_inbox_revoked" })];
    await h.coordinator.deliver(JOB, feedAll).done;

    // Refused by default: this record is the only trace of that ciphertext.
    await expect(h.plans.forget("job-1")).rejects.toMatchObject({ code: "illegal-transition" });
    // And forgettable only when the caller states the decision.
    expect(await h.plans.forget("job-1", { acceptOrphan: true })).toBe(true);
    expect(await h.plan("job-1")).toBeNull();
  });
});

describe("send coordinator — review findings from this pass", () => {
  it("resolves a resume that cannot proceed instead of rejecting", async () => {
    const h = await harness();
    // No plan on disk at all: `runCreate` throws, and a caller must still get an
    // outcome rather than a rejected promise it has to classify itself.
    await expect(h.coordinator.resume("job-absent", AUTHORITY).done).resolves.toEqual({
      kind: "unknown",
      reason: "resume-failed",
    });
  });

  it("treats a task central no longer holds as already cancelled", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;
    // Deleted from under us — by another client, or by a cancel whose answer was
    // lost. Its ciphertext went with the row.
    h.central.tasks.clear();

    const cancelled = await h.coordinator.cancel("job-1");

    expect(cancelled).toEqual({ kind: "cancelled", task: null });
    expect(h.central.deletedTasks).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({ phase: "settled" });
  });
});

describe("send coordinator — admissions, drain and coalescing (root probe)", () => {
  /** Leave a plan abandoned with an object still named, so `cleanup` has work. */
  async function abandonedWithObject(h: Harness): Promise<void> {
    h.central.createScript = [() => json(409, { error: "device_inbox_revoked" })];
    h.releaseFails = true;
    await h.coordinator.deliver(JOB, feedAll).done;
    h.releaseFails = false;
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned", storedObjectID: "obj-1" });
  }

  it("coalesces repeated cleanups instead of admitting one per ask", async () => {
    const h = await harness();
    await abandonedWithObject(h);

    // Root's probe: twenty asks for the same job. One release, one operation.
    const asked = Array.from({ length: 20 }, () => h.coordinator.cleanup("job-1"));
    expect(new Set(asked).size).toBe(1);
    const results = await Promise.all(asked);

    expect(results.every((r) => r.released && r.supported)).toBe(true);
    expect(h.releases).toEqual(["obj-1"]);
    expect(h.coordinator.isBusy("job-1")).toBe(false);
  });

  it("cannot walk past the job bound by asking the same question repeatedly", async () => {
    const h = await harness();
    await abandonedWithObject(h);
    let releaseGate = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    h.holdRelease = held;

    const first = h.coordinator.cleanup("job-1");
    for (let i = 0; i < 19; i += 1) void h.coordinator.cleanup("job-1");
    // Three kinds is the per-job ceiling, and only one kind is in flight.
    expect(h.auxiliaryCount("job-1")).toBe(1);

    releaseGate();
    await first;
    expect(h.releases).toEqual(["obj-1"]);
  });

  it("quiesce fences first, so work admitted while it runs cannot outlive it", async () => {
    const h = await harness();
    await abandonedWithObject(h);
    let releaseGate = (): void => undefined;
    h.holdRelease = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const running = h.coordinator.cleanup("job-1");
    const draining = h.coordinator.quiesce();
    // The gate is shut synchronously, before the drain awaits anything.
    expect(h.coordinator.admitting).toBe(false);
    let refusedAfterQuiesce = 0;
    for (let i = 0; i < 20; i += 1) {
      try {
        void h.coordinator.cleanup("job-1");
      } catch {
        refusedAfterQuiesce += 1;
      }
    }
    releaseGate();
    await draining;

    expect(refusedAfterQuiesce).toBe(20);
    // And when it returns, it is actually true.
    expect(h.coordinator.quiet).toBe(true);
    expect(h.coordinator.isBusy("job-1")).toBe(false);
    await running;
  });

  it("fences without cancelling, and an explicit Stay resumes", async () => {
    const h = await harness();

    h.coordinator.fence();

    // Nothing was revoked: a user who has not consented to quitting has not had
    // a delivery cancelled on their behalf.
    expect(() => h.coordinator.deliver(JOB, feedAll)).toThrow(/admissions are closed/);
    expect(() => h.coordinator.cancel("job-1", AUTHORITY)).toThrow(/admissions are closed/);
    expect(h.coordinator.isLive("job-1")).toBe(false);
    expect(h.central.log).toEqual([]);

    h.coordinator.resumeAdmissions();
    await expect(h.coordinator.deliver(JOB, feedAll).done).resolves.toMatchObject({ kind: "delivered" });
  });

  it("refuses a cancel before it revokes, never the other way round", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;
    const fence = h.coordinator.fenceOf("job-1");
    h.coordinator.fence();

    expect(() => h.coordinator.cancel("job-1")).toThrow(/admissions are closed/);

    // The refusal came first: the delivery is untouched and still cancellable
    // once the host resumes.
    expect(fence.valid).toBe(true);
    expect(h.central.deletedTasks).toEqual([]);
  });

  it("dispose is terminal and cannot be resumed", async () => {
    const h = await harness();
    await h.coordinator.dispose();
    expect(() => h.coordinator.resumeAdmissions()).toThrow(/disposed/);
    expect(() => h.coordinator.adoptDocument(DOCUMENT)).toThrow(/disposed/);
    expect(h.coordinator.admitting).toBe(false);
  });

  it("joins jobs a PREVIOUS invalidation revoked, not only this call's", async () => {
    const h = await harness();
    let releaseDevices = (): void => undefined;
    h.central.holdDevices = new Promise<void>((resolve) => {
      releaseDevices = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      h.central.onDevicesEntered = resolve;
    });
    const delivery = h.coordinator.deliver(JOB, feedAll);
    await entered;

    // First call revokes. Second call must NOT report quiet just because it was
    // not the one that did the revoking — that is exactly when a host calls
    // twice, and the old `wasValid` filter made the second return instantly.
    void h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });
    const second = h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });
    expect(h.coordinator.isBusy("job-1")).toBe(true);

    releaseDevices();
    await second;
    expect(h.coordinator.isBusy("job-1")).toBe(false);
    await delivery.done;
  });

  it("closes the coordinator permanently when the identity changes", async () => {
    const h = await harness();
    const { quiet } = await h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });

    expect(quiet).toBe(true);
    // `tasks` carries one captured bearer, so there is no state in which this
    // coordinator may serve another identity — and none in which it should
    // resume for the same one, because a fresh sign-in is a fresh bearer.
    expect(h.coordinator.admitting).toBe(false);
    expect(() => h.coordinator.deliver(JOB, feedAll)).toThrow(/identity is closed/);
    expect(() => h.coordinator.resumeAdmissions()).not.toThrow();
    // Even re-opening admissions does not bring it back: the host builds a new
    // coordinator, and there is no flag here for it to get wrong.
    expect(h.coordinator.admitting).toBe(false);
    expect(() => h.coordinator.deliver(JOB, feedAll)).toThrow(/identity is closed/);
  });

  it("refuses a NEW teardown requested after the authority was withdrawn", async () => {
    const h = await harness();
    await abandonedWithObject(h);
    await h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });

    // Holding a record is not authorization. A cleanup asked for AFTER the user
    // signed out is a new external request under a credential they revoked, not
    // the already-authorized teardown that was in flight when it happened.
    expect(() => h.coordinator.cleanup("job-1")).toThrow(/identity is closed|authority was withdrawn/);
    expect(() => h.coordinator.cancel("job-1")).toThrow(/identity is closed|authority was withdrawn/);
    expect(h.releases).toEqual([]);
    // And the record is untouched, so nothing was lost by refusing.
    expect(await h.plan("job-1")).toMatchObject({ phase: "abandoned", storedObjectID: "obj-1" });
  });

  it("refuses a new teardown for a job whose DOCUMENT was revoked, while the coordinator stays open", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;

    // A document revocation is per-job, not coordinator-wide — so this isolates
    // the per-job gate: the coordinator is still admitting, and the refusal is
    // about this job's withdrawn standing.
    expect(await h.coordinator.invalidateDocument(DOCUMENT)).toEqual({ quiet: true, remembered: true });
    expect(h.coordinator.admitting).toBe(true);

    expect(() => h.coordinator.cancel("job-1")).toThrow(/authority was withdrawn \(document-revoked\)/);
    expect(() => h.coordinator.cleanup("job-1")).toThrow(/authority was withdrawn/);
    expect(h.central.deletedTasks).toEqual([]);
    // Another document's work is unaffected.
    const other = { ...JOB, jobID: "job-9", idempotencyKey: "idem-9", authority: { ...AUTHORITY, documentId: "doc-9" } };
    await expect(h.coordinator.deliver(other, feedAll).done).resolves.toMatchObject({ kind: "delivered" });
  });

  it("drains teardown that was ALREADY in flight, under its original authority", async () => {
    const h = await harness();
    await abandonedWithObject(h);
    let releaseGate = (): void => undefined;
    h.holdRelease = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    // Authorized BEFORE the sign-out, and in flight when it lands.
    const running = h.coordinator.cleanup("job-1");
    const invalidated = h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });
    expect(h.coordinator.isBusy("job-1")).toBe(true);
    releaseGate();

    expect(await invalidated).toEqual({ quiet: true });
    expect(await running).toEqual({ released: true, supported: true });
    // Issued under the ORIGINAL captured authority, which is the only correct
    // one for the object it names.
    expect(h.releaseAuthorities).toEqual([`${ACCOUNT}/${SELF}`]);
  });

  it("reports honestly when a bounded drain does not reach quiet", async () => {
    const h = await harness();
    await abandonedWithObject(h);
    // A release that never returns: the bounded join cannot finish, and saying
    // it did is what the discarded boolean used to do.
    h.holdRelease = new Promise<void>(() => undefined);
    void h.coordinator.cleanup("job-1");

    const result = await h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });

    expect(result).toEqual({ quiet: false });
    expect(h.coordinator.isBusy("job-1")).toBe(true);
    await h.coordinator.dispose();
  });

  it("remembers a revoked document instead of re-admitting a job into it", async () => {
    const h = await harness();
    expect(await h.coordinator.invalidateDocument(DOCUMENT)).toEqual({ quiet: true, remembered: true });

    // A reloaded document gets a NEW id, so a job under the revoked one means
    // the host reused an id it should not have.
    expect(() => h.coordinator.deliver({ ...JOB, jobID: "job-2" }, feedAll)).toThrow(/document was revoked/);
    // Another document is unaffected: this is not a coordinator-wide close.
    const other = { ...JOB, jobID: "job-3", idempotencyKey: "idem-3", authority: { ...AUTHORITY, documentId: "doc-2" } };
    await expect(h.coordinator.deliver(other, feedAll).done).resolves.toMatchObject({ kind: "delivered" });

    // And the id comes back only when the host says it names a new document.
    h.coordinator.adoptDocument(DOCUMENT);
    expect(() =>
      h.coordinator.deliver({ ...JOB, jobID: "job-4", idempotencyKey: "idem-4" }, feedAll),
    ).not.toThrow();
  });

  it("keeps upload-session persistence inside the tracked delivery", async () => {
    const h = await harness();
    // The recorder reaches the host ONLY as an argument to `engineFor`, for the
    // duration of one upload, and it is fenced. So durable persistence cannot
    // happen outside work that `quiesce` and `dispose` join — which is what a
    // public method on the coordinator allowed.
    let recorder: ((uploadID: string) => Promise<void>) | null = null;
    h.captureRecorder = (fn) => {
      recorder = fn;
    };
    await h.coordinator.deliver(JOB, feedAll).done;
    expect(await h.plan("job-1")).toMatchObject({ uploadID: "up-1" });

    // The delivery is over and its fence spent; the recorder cannot be used to
    // write to the plan afterwards.
    expect(recorder).not.toBeNull();
    await expect((recorder as unknown as (id: string) => Promise<void>)("up-2")).rejects.toMatchObject({
      name: "AuthorityRevoked",
    });
    expect(await h.plan("job-1")).toMatchObject({ uploadID: "up-1" });
  });
});

describe("send coordinator — the exact request survives a config change", () => {
  /** A plan left exactly where a process that died mid-create left it. */
  async function creatingPlan(h: Harness, patch: Record<string, unknown> = {}): Promise<void> {
    await h.plans.stage({
      jobID: "job-1",
      targetDeviceID: DEVICE,
      kind: "file",
      idempotencyKey: "idem-1",
      targetKeyID: "key-1",
      targetKeyGeneration: 1,
      now: 1,
    });
    await h.plans.advance("job-1", "uploading", { manifestDigest: "digest-1" }, 2);
    await h.plans.advance("job-1", "uploaded", { storedObjectID: "obj-1" }, 3);
    await h.plans.advance(
      "job-1",
      "creating",
      { wrappedKey: sealedBox("A"), protocolVersion: 3, wrapAlgorithm: CAPS.keyAlgorithm, ...patch },
      4,
    );
  }

  it("repeats the RECORDED version and algorithm, not this build's", async () => {
    // A build whose negotiated protocol and algorithm have both moved on.
    const h = await harness();
    (h.coordinator as unknown as { options: { protocolVersion: number; runtimeCaps: { keyAlgorithm: string } } })
      .options.protocolVersion = 4;
    (h.coordinator as unknown as { options: { runtimeCaps: { keyAlgorithm: string } } })
      .options.runtimeCaps.keyAlgorithm = "x25519-sealedbox-v2";
    await creatingPlan(h);

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toMatchObject({ kind: "delivered" });
    // Byte-identical to what was persisted. Composing it from the CURRENT
    // options would have sent protocolVersion 4 under an idempotency key whose
    // outcome was unknown — and the handler validates the version BEFORE the
    // idempotent replay, so central would have refused without ever being asked
    // whether the first attempt had already succeeded.
    expect(h.central.createBodies[0]).toEqual({
      idempotencyKey: "idem-1",
      storedFileId: "obj-1",
      protocolVersion: 3,
      wrapAlgorithm: CAPS.keyAlgorithm,
      wrappedKey: sealedBox("A"),
      targetKeyId: "key-1",
      targetKeyGeneration: 1,
    });
  });

  it("refuses a plan whose recorded request is incomplete, altering nothing", async () => {
    const h = await harness();
    // A plan from a build that recorded the sealed box but not the rest.
    await creatingPlan(h, { protocolVersion: 0, wrapAlgorithm: "" });
    const before = await h.plan("job-1");

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toEqual({ kind: "unknown", reason: "incomplete-recorded-request" });
    // Never guessed, never dropped: re-deriving the missing fields from THIS
    // build would compose a different request under a key whose outcome nobody
    // knows.
    expect(h.central.createBodies).toEqual([]);
    expect(h.releases).toEqual([]);
    expect(await h.plan("job-1")).toEqual(before);
  });

  it("treats a PRE-REPLAY refusal as proof of nothing", async () => {
    const h = await harness();
    await creatingPlan(h);
    // `unsupported_protocol_version` is checked before `CreateInboxTask` runs,
    // so the idempotent replay was never consulted: an earlier attempt under
    // this key may be queued on the target right now.
    h.central.createScript = [
      () => json(409, { error: "unsupported_protocol_version", supportedProtocols: [4] }),
    ];

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toMatchObject({
      kind: "refused",
      reason: "unsupported_protocol_version",
      releasedObject: false,
      orphanedObject: false,
      retryable: true,
    });
    // Nothing released, and the exact request kept for a build that can carry it.
    expect(h.releases).toEqual([]);
    expect(await h.plan("job-1")).toMatchObject({
      phase: "creating",
      wrappedKey: sealedBox("A"),
      protocolVersion: 3,
      storedObjectID: "obj-1",
    });
  });

  it("still releases on a refusal that comes from PAST the replay check", async () => {
    const h = await harness();
    await creatingPlan(h);
    // `device_inbox_revoked` is raised inside `CreateInboxTask`, which checks
    // the idempotent replay first — so reaching it proves no row exists.
    h.central.createScript = [() => json(409, { error: "device_inbox_revoked" })];

    const outcome = await h.coordinator.resume("job-1", AUTHORITY).done;

    expect(outcome).toMatchObject({ kind: "refused", reason: "device_inbox_revoked", releasedObject: true });
    expect(h.releases).toEqual(["obj-1"]);
  });
});

describe("send coordinator — cancellation before revocation (root probe)", () => {
  it("still refuses teardown when the document is revoked AFTER a cancel", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;

    // The cancel lands first, so the fence's FIRST reason is `cancelled` — and
    // `Fence.revoke` keeps it, deliberately. A later document revocation can
    // therefore never appear in `fence.reason`.
    await h.coordinator.cancel("job-1");
    expect(h.coordinator.fenceOf("job-1").reason).toBe("cancelled");

    expect(await h.coordinator.invalidateDocument(DOCUMENT)).toEqual({ quiet: true, remembered: true });

    // Asking the fence answered "authority intact" and admitted this. Asking the
    // registry does not.
    expect(() => h.coordinator.cleanup("job-1")).toThrow(/authority was withdrawn \(document-revoked\)/);
    expect(() => h.coordinator.cancel("job-1")).toThrow(/authority was withdrawn \(document-revoked\)/);
    expect(() => h.coordinator.discard("job-1")).toThrow(/authority was withdrawn \(document-revoked\)/);
    expect(h.releases).toEqual([]);
  });

  it("positive control: the same job is admitted while its document stands", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;
    await h.coordinator.cancel("job-1");
    expect(h.coordinator.fenceOf("job-1").reason).toBe("cancelled");

    // Cancelled, but its document is intact — so a further teardown is a legal
    // ask, and the refusal above is about the revocation rather than the cancel.
    expect(await h.coordinator.cleanup("job-1")).toEqual({ released: false, supported: true });
  });

  it("still refuses teardown when the ACCOUNT changed after a cancel", async () => {
    const h = await harness();
    await h.coordinator.deliver(JOB, feedAll).done;
    await h.coordinator.cancel("job-1");

    await h.coordinator.invalidateAccount({ accountId: "someone-else", deviceId: SELF });

    expect(() => h.coordinator.cleanup("job-1")).toThrow(/authority was withdrawn \(account-changed\)/);
    expect(h.releases).toEqual([]);
  });

  it("bounds the revoked set at the ADD, never by evicting a past revocation", async () => {
    const h = await harness();
    const ids = Array.from({ length: MAX_REVOKED_DOCUMENTS }, (_, i) => `doc-${i}`);
    for (const id of ids) {
      expect(await h.coordinator.invalidateDocument(id)).toEqual({ quiet: true, remembered: true });
    }
    expect(h.coordinator.admitting).toBe(true);

    // One more than it can hold.
    const overflow = await h.coordinator.invalidateDocument("doc-overflow");

    expect(overflow).toEqual({ quiet: true, remembered: false });
    // Fail closed rather than forget: every earlier revocation still holds, and
    // the coordinator is done.
    expect(h.coordinator.admitting).toBe(false);
    expect(() =>
      h.coordinator.deliver({ ...JOB, authority: { ...AUTHORITY, documentId: "doc-fresh" } }, feedAll),
    ).toThrow(/too many revoked documents/);
    for (const id of ids) {
      const stale = { ...JOB, jobID: `j-${id}`, authority: { ...AUTHORITY, documentId: id } };
      expect(() => h.coordinator.deliver(stale, feedAll)).toThrow(/too many revoked documents/);
    }
    // Re-invalidating an id it ALREADY holds needs no room, so it still works.
    expect(await h.coordinator.invalidateDocument(ids[0]!)).toEqual({ quiet: true, remembered: true });
  });
});
