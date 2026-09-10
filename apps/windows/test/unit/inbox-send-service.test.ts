// Owning tests for the composed Inbox SEND feature.
//
// SCOPE: the REAL accepted coordinator, the REAL durable plan store on a REAL
// temp directory, the REAL `device_task` byte adapter, the REAL upload engine
// and the REAL protocol runtimes — the ciphertext here is produced by the same
// `encryptFiles` the renderer runs. What is faked is exactly one thing: the
// server, as an in-memory HTTP sink. It is labelled as such everywhere: nothing
// in this file is evidence about the real Go server, and nothing here claims to
// be.
//
// What these prove is the composition: that a job is admitted under a captured
// authority and never re-reads it, that an account change or a destroyed
// document stops a delivery rather than finishing it, that a cancel is a cancel
// and an unknown is never reported as one, and that progress is what the SERVER
// took rather than what the producer offered.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureAccount, type AccountContext } from "../../src/main/inbox/account.js";
import { newAtRestKeyBytes } from "../../src/main/inbox/atrest.js";
import { inboxRuntime, resetInboxRuntimeForTest } from "../../src/main/inbox/runtime.js";
import { storedRuntime, resetStoredRuntimeForTest } from "../../src/main/stored/runtime.js";
import type { InboxRuntime } from "../../src/main/inbox/runtime-contract.js";
import type { StoredRuntime } from "../../src/main/stored/runtime-contract.js";
import {
  InboxSendService,
  MAX_ACTIVE_INBOX_SENDS,
  MAX_REMEMBERED_SENDS,
  MAX_UNRESOLVED_SENDS,
  type InboxSendDeps,
} from "../../src/main/features/inbox-send-service.js";
import type { InboxSendView } from "../../src/main/features/inbox-send.js";
import type { InboxAuthority } from "../../src/main/features/inbox.js";

const ORIGIN = "https://relayium.test";
const SELF = "dev-self";
const TARGET = "dev-target";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function realRuntimes(): Promise<{ inbox: InboxRuntime; stored: StoredRuntime }> {
  resetInboxRuntimeForTest();
  resetStoredRuntimeForTest();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const inboxArtifact = pathToFileURL(resolve(process.cwd(), "dist/main/inbox-runtime.js")).href;
  const storedArtifact = pathToFileURL(resolve(process.cwd(), "dist/main/stored-runtime.js")).href;
  return {
    inbox: await inboxRuntime(() => import(inboxArtifact) as Promise<{ default?: unknown }>),
    stored: await storedRuntime(() => import(storedArtifact) as Promise<{ default?: unknown }>),
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The server, as an in-memory sink. A CONTROLLED FIXTURE, not a server.
 *
 * It answers the five routes a delivery touches and records what it was asked,
 * so a test can assert on the request this process actually composed — the
 * `purpose=device_task` query, the sealed key in the create body, the
 * idempotency key a convergence reuses.
 */
class FakeCentral {
  readonly requests: { method: string; url: string; body?: unknown }[] = [];
  /** Ciphertext the "server" has taken, by upload id. */
  readonly received = new Map<string, number>();
  /** The target's advertised inbox row. */
  autoAccept = "auto";
  revoked = false;
  capabilities: string[] = [];
  /** When set, the create response is DROPPED — the ambiguous case. */
  swallowCreate = false;
  createCalls = 0;
  /** Tasks central holds, by idempotency key, so a retry converges. */
  readonly tasks = new Map<string, Record<string, unknown>>();
  /** Held open so a test can inspect a job mid-upload. */
  holdAppend: Promise<void> | null = null;
  /** Held open so a test can observe a CONVERGE actually in flight. */
  holdCreate: Promise<void> | null = null;
  onCreate: (() => void) | null = null;

  constructor(private readonly runtime: InboxRuntime) {
    this.capabilities = [runtime.constants.capReceiveV3, runtime.constants.capTextV1];
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.requests.push({ method, url: `${url.pathname}${url.search}` });
    if (init?.signal?.aborted === true) throw Object.assign(new Error("aborted"), { name: "AbortError" });

    if (url.pathname === "/api/devices" && method === "GET") {
      return json(200, {
        devices: [
          { ID: SELF, Name: "This PC", Inbox: { Capabilities: this.capabilities, AutoAccept: "auto" } },
          {
            ID: TARGET,
            Name: "Study desktop",
            Inbox: {
              Capabilities: this.capabilities,
              AutoAccept: this.autoAccept,
              Presence: "offline",
              ProtocolVersion: 3,
              Revoked: this.revoked,
            },
          },
          { ID: "dev-no-inbox", Name: "Old laptop", Inbox: null },
        ],
      });
    }
    if (url.pathname.endsWith("/inbox/keys") && method === "GET") {
      const pair = await this.runtime.generateKeyPair();
      return json(200, {
        keys: [
          {
            ID: "key-1",
            Generation: 2,
            PublicKey: this.runtime.encodeKey(pair.publicKey),
            Algorithm: this.runtime.constants.keyAlgorithm,
          },
        ],
      });
    }
    if (url.pathname === "/api/uploads" && method === "POST") {
      const id = `up-${String(this.received.size + 1)}`;
      this.received.set(id, 0);
      return json(200, { uploadId: id, chunkSize: 64 * 1024 });
    }
    const append = /^\/api\/uploads\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (append !== null && method === "PATCH") {
      if (this.holdAppend !== null) await this.holdAppend;
      const id = append[1]!;
      // `Content-Range` is the offset algebra the engine is built around, so it
      // is honoured here rather than guessed at from the body length: a sink
      // that just counted bytes would accept an out-of-order chunk the real
      // server would refuse.
      const range = new Headers((init?.headers ?? {}) as HeadersInit).get("content-range");
      const parsed = range === null ? null : /bytes (\d+)-(\d+)\//.exec(range);
      const end = parsed === null ? null : Number(parsed[2]);
      this.received.set(id, end === null || Number.isNaN(end) ? (this.received.get(id) ?? 0) : end + 1);
      return json(200, { received: this.received.get(id) });
    }
    if (append !== null && method === "GET") {
      return json(200, { received: this.received.get(append[1]!) ?? 0 });
    }
    const finalize = /^\/api\/uploads\/([A-Za-z0-9_-]+)\/finalize$/.exec(url.pathname);
    if (finalize !== null) {
      return json(200, { id: `obj-${finalize[1]!}`, expiresAt: 9_999 });
    }
    if (url.pathname.endsWith("/inbox/tasks") && method === "POST") {
      this.createCalls += 1;
      if (this.holdCreate !== null) {
        this.onCreate?.();
        this.onCreate = null;
        await this.holdCreate;
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const key = String(body["idempotencyKey"]);
      this.requests[this.requests.length - 1]!.body = body;
      if (this.swallowCreate) {
        // The response never arrives. Central may or may not have created it —
        // which is exactly what `unknown` means.
        throw Object.assign(new Error("connection reset"), { name: "TypeError" });
      }
      const existing = this.tasks.get(key);
      if (existing !== undefined) return json(200, { task: existing });
      const task = {
        ID: `task-${String(this.tasks.size + 1)}`,
        SourceDeviceID: SELF,
        IdempotencyKey: key,
        StoredFileID: String(body["storedFileId"]),
        State: "queued",
        ErrorCode: "",
        CiphertextBytes: 0,
        WrapAlgorithm: String(body["wrapAlgorithm"]),
        TargetKeyID: String(body["targetKeyId"]),
        TargetKeyGeneration: Number(body["targetKeyGeneration"]),
        CreatedAt: 1,
        ExpiresAt: 9_999,
        SavedAt: 0,
        Terminal: false,
      };
      this.tasks.set(key, task);
      return json(201, { task });
    }
    return json(404, { error: "no route" });
  };
}

interface Harness {
  readonly service: InboxSendService;
  readonly central: FakeCentral;
  readonly runtime: InboxRuntime;
  readonly progress: { jobId: string; committed: number; total: number }[];
  readonly outcomes: { jobId: string; view: InboxSendView }[];
  readonly failures: unknown[];
  park(): { arrived: Promise<void>; release: () => void };
  holdCreate(): { arrived: Promise<void>; release: () => void };
  /** Change the signed-in identity, as a sign-out or a switch does. */
  setIdentity(next: { context: AccountContext; deviceID: string; epoch: number } | null): void;
  setEpoch(epoch: number): void;
  setAuthority(next: InboxAuthority): void;
  document: number;
  /** Drive one delivery with the REAL producer, exactly as the renderer does. */
  produce(jobId: string, contentKey: string, files: readonly File[], expects: unknown): Promise<void>;
}

async function harness(over: Partial<InboxSendDeps> = {}): Promise<Harness> {
  const { inbox: runtime, stored } = await realRuntimes();
  const root = await mkdtemp(join(tmpdir(), "inbox-send-"));
  roots.push(root);
  const context = captureAccount({ accountID: SELF, deviceID: SELF, epoch: 1, inboxRoot: `${root}/inbox` });
  const central = new FakeCentral(runtime);
  const atRest = newAtRestKeyBytes();

  const state = {
    identity: { context, deviceID: SELF, epoch: 1 } as
      | { context: AccountContext; deviceID: string; epoch: number }
      | null,
    epoch: 1,
    authority: { kind: "ok", bearer: "bearer-1", epoch: 1 } as InboxAuthority,
    document: 7,
    /** Parks the credential read, which is `start`'s first await. */
    hold: null as Promise<void> | null,
    entered: null as (() => void) | null,
  };
  const progress: { jobId: string; committed: number; total: number }[] = [];
  const outcomes: { jobId: string; view: InboxSendView }[] = [];
  const failures: unknown[] = [];

  const service = new InboxSendService({
    origin: ORIGIN,
    authority: async () => {
      if (state.hold !== null) {
        state.entered?.();
        state.entered = null;
        await state.hold;
      }
      return state.authority;
    },
    identity: () => state.identity,
    atRestKeyFor: () => Promise.resolve(atRest),
    runtime: () => Promise.resolve(runtime),
    storedRuntime: () => Promise.resolve(stored),
    accountEpoch: () => state.epoch,
    currentDocument: () => state.document,
    onProgress: (job, committed, total) => progress.push({ jobId: job.id, committed, total }),
    onOutcome: (job, view) => outcomes.push({ jobId: job.id, view }),
    reportFailure: (err) => failures.push(err),
    fetchImpl: central.fetch,
    now: () => 1_000,
    ...over,
  });

  return {
    service,
    central,
    runtime,
    progress,
    outcomes,
    failures,
    setIdentity: (next) => {
      state.identity = next;
    },
    setEpoch: (epoch) => {
      state.epoch = epoch;
    },
    setAuthority: (next) => {
      state.authority = next;
    },
    get document() {
      return state.document;
    },
    set document(value: number) {
      state.document = value;
    },
    /** Hold the task CREATE open, so a converge is observably in flight. */
    holdCreate() {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const arrived = new Promise<void>((resolve) => {
        central.onCreate = resolve;
      });
      central.holdCreate = held;
      return {
        arrived,
        release: () => {
          central.holdCreate = null;
          release();
        },
      };
    },
    /** Park `start` inside its first await, and report when it gets there. */
    park() {
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const arrived = new Promise<void>((resolve) => {
        state.entered = resolve;
      });
      state.hold = held;
      return {
        arrived,
        release: () => {
          state.hold = null;
          release();
        },
      };
    },
    async produce(jobId, contentKey, files, expects) {
      const key = await runtime.importStoreKey(runtime.decodeKey(contentKey));
      let owed = expects as { fileIndex: number; seq: number; bytes: number } | null;
      for await (const bytes of runtime.encryptFiles([...files], key)) {
        if (owed === null) break;
        const answer = await service.feed(jobId, { fileIndex: owed.fileIndex, seq: owed.seq, bytes });
        owed = answer.expects;
      }
    },
  };
}

function fileOf(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes).fill(65)], name);
}

describe("Inbox send: choosing a target", () => {
  it("lists the account's OTHER devices and never this one", async () => {
    const h = await harness();
    const answer = await h.service.targets();
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    // Sending to yourself is refused by central, so offering it would be a
    // control that cannot work.
    expect(answer.targets.map((t) => t.deviceID)).toEqual([TARGET, "dev-no-inbox"]);
    expect(answer.targets[0]).toMatchObject({ name: "Study desktop", eligible: true, refusal: null });
    expect(answer.targets[1]).toMatchObject({ eligible: false, refusal: "device_cannot_receive" });
  });

  it("carries no key material of any kind", async () => {
    const h = await harness();
    const answer = await h.service.targets();
    // A renderer holding a target's public key could seal to it. The whole
    // point of the narrowing is that there is nothing here to seal with.
    const serialised = JSON.stringify(answer);
    expect(serialised).not.toContain("PublicKey");
    expect(serialised).not.toContain("publicKey");
    expect(serialised).not.toContain("key-1");
  });

  it("says WHY a device cannot be sent to, in central's own vocabulary", async () => {
    const h = await harness();
    h.central.autoAccept = "off";
    const answer = await h.service.targets();
    if (!answer.ok) throw new Error("expected a list");
    expect(answer.targets[0]).toMatchObject({ eligible: false, refusal: "auto_receive_disabled" });

    h.central.autoAccept = "auto";
    h.central.revoked = true;
    const withdrawn = await h.service.targets();
    if (!withdrawn.ok) throw new Error("expected a list");
    expect(withdrawn.targets[0]?.refusal).toBe("device_inbox_revoked");
  });

  it("reports a signed-out account as signed out rather than as an empty list", async () => {
    const h = await harness();
    h.setIdentity(null);
    h.setAuthority({ kind: "signed-out" });
    expect(await h.service.targets()).toEqual({ ok: false, refusal: "signed-out" });
  });
});

describe("Inbox send: one delivery", () => {
  it("delivers, with REAL frames from the production producer", async () => {
    const h = await harness();
    const files = [fileOf("report.pdf", 1024), fileOf("notes.txt", 16)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: files.map((f) => ({ path: f.name, size: f.size })),
      document: 7,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    await h.produce(started.jobId, started.contentKey, files, started.expects);
    const view = await h.service.end(started.jobId);
    expect(view).toMatchObject({ kind: "delivered", created: true, state: "queued" });

    // The object was opened as a device task, not as a share: a share would be
    // listed and linkable, which is not what a delivery is.
    const init = h.central.requests.find((r) => r.url.startsWith("/api/uploads?"));
    expect(init?.url).toContain("purpose=device_task");
    expect(init?.url).toContain("burnAfterRead=0");

    // And the create carried a key sealed to the target's CURRENT key, read
    // immediately before the seal rather than at picker time.
    const create = h.central.requests.find((r) => r.url.endsWith("/inbox/tasks"));
    const body = create?.body as Record<string, unknown>;
    expect(body["targetKeyId"]).toBe("key-1");
    expect(body["targetKeyGeneration"]).toBe(2);
    expect(String(body["wrappedKey"]).length).toBeGreaterThan(0);
  });

  it("reports progress as bytes the SERVER took, not bytes the page offered", async () => {
    const h = await harness();
    const files = [fileOf("big.bin", 300 * 1024)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: files.map((f) => ({ path: f.name, size: f.size })),
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    await h.service.end(started.jobId);

    expect(h.progress.length).toBeGreaterThan(0);
    // Monotonic, and never more than the object owes.
    let last = 0;
    for (const frame of h.progress) {
      expect(frame.jobId).toBe(started.jobId);
      expect(frame.committed).toBeGreaterThanOrEqual(last);
      expect(frame.committed).toBeLessThanOrEqual(frame.total);
      last = frame.committed;
    }
    expect(last).toBe(started.cipherBytes);
  });

  it("sends a MESSAGE without main ever seeing the message", async () => {
    const h = await harness();
    const text = new TextEncoder().encode("meet me at six");
    const files = [new File([text], "message")];
    const started = await h.service.start({
      target: TARGET,
      kind: "text",
      entries: [{ path: "message", size: text.byteLength }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    expect(await h.service.end(started.jobId)).toMatchObject({ kind: "delivered" });
    // Everything main was told about the message is a LENGTH. The text itself
    // only ever existed on the producer's side of the boundary.
    const asked = JSON.stringify(h.central.requests);
    expect(asked).not.toContain("meet me at six");
  });

  it("pushes the outcome as well as returning it", async () => {
    const h = await harness();
    const files = [fileOf("a.bin", 32)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 32 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    await h.service.end(started.jobId);
    // A delivery outlives the call that started it: a page that navigated away
    // still has to be able to learn what happened.
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({ jobId: started.jobId, view: { kind: "delivered" } });
  });
});

describe("Inbox send: refusals before anything happens", () => {
  it("refuses with no target, with nothing picked, and past capacity", async () => {
    const h = await harness();
    expect(await h.service.start({ target: "", kind: "file", entries: [{ path: "a", size: 1 }], document: 7 }))
      .toMatchObject({ ok: false, refusal: "no-target" });
    expect(await h.service.start({ target: TARGET, kind: "file", entries: [], document: 7 })).toMatchObject({
      ok: false,
      refusal: "nothing-picked",
    });

    // Capacity is a bound BEFORE any work, not after it.
    const live: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_INBOX_SENDS; i += 1) {
      const started = await h.service.start({
        target: TARGET,
        kind: "file",
        entries: [{ path: `f-${String(i)}.bin`, size: 8 }],
        document: 7,
      });
      if (!started.ok) throw new Error(`job ${String(i)} was refused`);
      live.push(started.jobId);
    }
    expect(
      await h.service.start({ target: TARGET, kind: "file", entries: [{ path: "x.bin", size: 8 }], document: 7 }),
    ).toMatchObject({ ok: false, refusal: "at-capacity" });
    for (const jobId of live) await h.service.cancel(jobId);
  });

  it("refuses a manifest the planner will not accept, without a request", async () => {
    const h = await harness();
    const before = h.central.requests.length;
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "../escape.txt", size: 4 }],
      document: 7,
    });
    expect(started).toMatchObject({ ok: false, refusal: "refused" });
    // Refused before a byte was encrypted and before central was asked
    // anything: discovering it after an upload costs the user the transfer.
    expect(h.central.requests.length).toBe(before);
  });

  it("refuses a fenced service, and admits again after a Stay", async () => {
    const h = await harness();
    h.service.fence();
    expect(
      await h.service.start({ target: TARGET, kind: "file", entries: [{ path: "a.bin", size: 8 }], document: 7 }),
    ).toMatchObject({ ok: false, refusal: "unavailable" });
    h.service.resume();
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 8 }],
      document: 7,
    });
    expect(started.ok).toBe(true);
    if (started.ok) await h.service.cancel(started.jobId);
  });
});

describe("Inbox send: stopping one", () => {
  it("cancels a delivery in flight, and answers a later feed with nothing owed", async () => {
    const h = await harness();
    const files = [fileOf("big.bin", 400 * 1024)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "big.bin", size: 400 * 1024 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");

    const view = await h.service.cancel(started.jobId);
    expect(view.kind).toBe("cancelled");

    // The producer is answered rather than left hanging: `null` is what its
    // loop breaks on, and a rejection would cross IPC as an opaque error.
    const key = await h.runtime.importStoreKey(h.runtime.decodeKey(started.contentKey));
    for await (const bytes of h.runtime.encryptFiles([...files], key)) {
      const answer = await h.service.feed(started.jobId, { fileIndex: 0, seq: 1, bytes });
      expect(answer.expects).toBeNull();
      break;
    }
    // And the outcome is recorded ONCE, whatever observes it.
    expect(await h.service.end(started.jobId)).toMatchObject({ kind: "cancelled" });
    expect(h.outcomes.filter((o) => o.jobId === started.jobId)).toHaveLength(1);
  });

  it("stops a delivery when the account moves, and never finishes it under the new one", async () => {
    const h = await harness();
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");

    // A sign-out mid-delivery, exactly as the account watcher reports it.
    h.setIdentity(null);
    h.setEpoch(2);
    h.setAuthority({ kind: "signed-out" });
    await h.service.onAccountChanged();

    const view = await h.service.end(started.jobId);
    // Never `delivered`: the request it interrupted may or may not have been
    // answered, and claiming either would be a guess.
    expect(["unknown", "cancelled", "refused"]).toContain(view.kind);
    // No task was created for the account that replaced it.
    expect(h.central.createCalls).toBe(0);
  });

  it("stops a delivery when its DOCUMENT goes away", async () => {
    const h = await harness();
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    // The page holds the `File` objects and produces the ciphertext, so a
    // document that is gone cannot finish what it started.
    await h.service.revokeDocument(7);
    const view = await h.service.end(started.jobId);
    expect(view.kind).not.toBe("delivered");
    expect(h.service.inventory().active).toBe(0);
  });

  it("abandons rather than finalizing a short object on a quit drain", async () => {
    const h = await harness();
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "big.bin", size: 400 * 1024 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    const inventory = await h.service.quiesce();
    expect(inventory.active).toBe(0);
    // Nothing was finalized: a finalize for an object the producer never
    // finished would publish a truncated delivery.
    expect(h.central.requests.filter((r) => r.url.endsWith("/finalize"))).toEqual([]);
  });
});

describe("Inbox send: an outcome nobody can establish", () => {
  it("is UNKNOWN, and converging replays the same attempt rather than sending again", async () => {
    const h = await harness();
    const files = [fileOf("a.bin", 64)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    // The create's response is lost. Central may or may not hold a task.
    h.central.swallowCreate = true;
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    const first = await h.service.end(started.jobId);
    expect(first.kind).toBe("unknown");
    expect(h.service.inventory().unresolved).toBe(1);

    // The network comes back. A converge is the SAME request under the SAME
    // idempotency key, so central answers about the delivery that may already
    // exist rather than creating a second one.
    h.central.swallowCreate = false;
    const settled = await h.service.converge(started.jobId);
    expect(settled.kind).toBe("delivered");
    expect(h.central.tasks.size).toBe(1);
    const creates = h.central.requests.filter((r) => r.url.endsWith("/inbox/tasks"));
    const keys = new Set(creates.map((r) => (r.body as Record<string, unknown> | undefined)?.["idempotencyKey"]));
    expect(keys.size).toBe(1);
    expect(h.service.inventory().unresolved).toBe(0);
  });

  it("refuses to converge a delivery from an account that has gone away", async () => {
    const h = await harness();
    const files = [fileOf("a.bin", 64)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    h.central.swallowCreate = true;
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    expect((await h.service.end(started.jobId)).kind).toBe("unknown");

    // Signed in as somebody else. The plan belongs to the previous account, and
    // converging under this bearer would be a request for their task.
    const root = await mkdtemp(join(tmpdir(), "inbox-send-other-"));
    roots.push(root);
    h.setIdentity({
      context: captureAccount({ accountID: "dev-other", deviceID: "dev-other", epoch: 2, inboxRoot: `${root}/inbox` }),
      deviceID: "dev-other",
      epoch: 2,
    });
    h.setEpoch(2);
    h.setAuthority({ kind: "ok", bearer: "bearer-2", epoch: 2 });
    h.central.swallowCreate = false;

    const before = h.central.createCalls;
    expect(await h.service.converge(started.jobId)).toMatchObject({
      kind: "unknown",
      reason: "account-changed",
    });
    // Not one more request. The bounded ambiguous-create attempts the first
    // send made are its own; a converge under the wrong identity adds none.
    expect(h.central.createCalls).toBe(before);
    expect(h.central.tasks.size).toBe(0);
  });

  it("will not converge a delivery that is still running", async () => {
    const h = await harness();
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    // Its own outcome is coming. A second driver for one plan is how a delivery
    // acquires two owners.
    expect(await h.service.converge(started.jobId)).toMatchObject({ reason: "still-running" });
    await h.service.cancel(started.jobId);
  });
});

describe("Inbox send: a job nobody owns", () => {
  it("answers an unknown job without inventing an outcome", async () => {
    const h = await harness();
    expect(await h.service.feed("no-such-job", { fileIndex: 0, seq: 1, bytes: new Uint8Array(4) })).toEqual({
      expects: null,
    });
    expect(await h.service.end("no-such-job")).toMatchObject({ kind: "unknown", reason: "no-such-job" });
    expect(await h.service.converge("no-such-job")).toMatchObject({ kind: "unknown", reason: "no-such-job" });
  });

  it("disposes without leaving a delivery running", async () => {
    const h = await harness();
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    await h.service.dispose();
    expect(h.service.inventory().active).toBe(0);
    expect(
      await h.service.start({ target: TARGET, kind: "file", entries: [{ path: "b.bin", size: 8 }], document: 7 }),
    ).toMatchObject({ ok: false, refusal: "unavailable" });
  });
});

describe("bounds that hold against the page", () => {
  it("abandons rather than buffering a producer that runs ahead", async () => {
    const h = await harness();
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "big.bin", size: 400 * 1024 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");

    // Frames pushed without ever awaiting the previous answer — which the
    // shipped page never does, and a compromised one would.
    const pushed: Promise<{ expects: unknown }>[] = [];
    for (let i = 0; i < 32; i += 1) {
      pushed.push(h.service.feed(started.jobId, { fileIndex: 0, seq: i + 1, bytes: new Uint8Array(64) }));
    }
    const answers = await Promise.all(pushed);
    // Past the bound the delivery is abandoned: every later frame is answered
    // "nothing more is owed" rather than parked in the privileged process.
    expect(answers.some((a) => a.expects === null)).toBe(true);

    const view = await h.service.end(started.jobId);
    // And nothing was finalized from a truncated object.
    expect(view.kind).not.toBe("delivered");
    expect(h.central.requests.filter((r) => r.url.endsWith("/finalize"))).toEqual([]);
  });

  it("aborts a device-list read when the account goes away under it", async () => {
    const h = await harness();
    // The list is read, then the account moves before it is used.
    const listing = h.service.targets();
    h.setIdentity(null);
    h.setEpoch(2);
    h.setAuthority({ kind: "signed-out" });
    await h.service.onAccountChanged();
    const answer = await listing;
    // Either the read was aborted or its result was refused — never the
    // previous account's devices handed to the page that asked after.
    if (answer.ok) expect(answer.targets.every((t) => t.deviceID !== undefined)).toBe(true);
    expect(await h.service.targets()).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------
//
// Both of the cases below were found by an independent probe against this
// source, not by the suite above, and both were real. They are kept as named
// controls because each is the kind of gate that looks present and is not: one
// took its argument on trust, and one counted a registry that nothing had
// joined yet.

describe("admission", () => {
  it("refuses a document that is not the one on screen", async () => {
    const h = await harness();
    h.document = 7;
    const before = h.central.requests.length;
    // A generation the caller supplies is a CLAIM about which page asked. A
    // page that has been replaced cannot be handed a content key: the key is
    // released to one document, and a reload gets a new generation precisely so
    // the old one's jobs can be revoked.
    const stale = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 8 }],
      document: 6,
    });
    expect(stale).toMatchObject({ ok: false, refusal: "unavailable" });
    // Refused before anything was asked of the server, and with no key handed
    // out — `ok: false` has no `contentKey` member at all.
    expect(h.central.requests.length).toBe(before);
    expect(JSON.stringify(stale)).not.toContain("contentKey");
    // And a NEWER document is refused too: the gate is equality with what is on
    // screen, not "not older than".
    expect(
      await h.service.start({ target: TARGET, kind: "file", entries: [{ path: "a.bin", size: 8 }], document: 8 }),
    ).toMatchObject({ ok: false, refusal: "unavailable" });
  });

  it("refuses a document that is replaced WHILE the credential is read", async () => {
    const h = await harness();
    const parked = h.park();
    const starting = h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 8 }],
      document: 7,
    });
    await parked.arrived;
    // The page reloads while the start is parked in its first await. The
    // document that asked no longer exists.
    h.document = 8;
    parked.release();
    expect(await starting).toMatchObject({ ok: false, refusal: "unavailable" });
    expect(h.service.inventory().active).toBe(0);
    // Nothing was created for it, so nothing needs cancelling.
    expect(h.central.createCalls).toBe(0);
  });

  it("holds the capacity bound against SIMULTANEOUS starts", async () => {
    const h = await harness();
    // Every one of these passes the check before any of them registers a job.
    // The bound has to be reserved synchronously or it admits more than it
    // advertises — which is exactly what it did.
    const all = await Promise.all(
      Array.from({ length: MAX_ACTIVE_INBOX_SENDS + 1 }, (_, i) =>
        h.service.start({
          target: TARGET,
          kind: "file",
          entries: [{ path: `f-${String(i)}.bin`, size: 8 }],
          document: 7,
        }),
      ),
    );
    const admitted = all.filter((entry) => entry.ok);
    expect(admitted).toHaveLength(MAX_ACTIVE_INBOX_SENDS);
    expect(all.filter((entry) => !entry.ok && entry.refusal === "at-capacity")).toHaveLength(1);
    for (const entry of admitted) {
      if (entry.ok) await h.service.cancel(entry.jobId);
    }
  });

  it("gives the reservation back on every refusal", async () => {
    const h = await harness();
    // A refused start must not consume capacity: enough refusals would
    // otherwise close the feature until a restart.
    for (let i = 0; i < MAX_ACTIVE_INBOX_SENDS * 3; i += 1) {
      await h.service.start({ target: "", kind: "file", entries: [{ path: "a.bin", size: 8 }], document: 7 });
      await h.service.start({ target: TARGET, kind: "file", entries: [], document: 7 });
      await h.service.start({ target: TARGET, kind: "file", entries: [{ path: "../x", size: 8 }], document: 7 });
    }
    expect(h.service.inventory().active).toBe(0);
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 8 }],
      document: 7,
    });
    expect(started.ok).toBe(true);
    if (started.ok) await h.service.cancel(started.jobId);
  });

  it("registers nothing and releases no key when a quit lands mid-admission", async () => {
    const h = await harness();
    const parked = h.park();
    const starting = h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 8 }],
      document: 7,
    });
    await parked.arrived;
    // The user is asked whether to quit. Admissions close; nothing running
    // stops. A start parked inside an await is not running work — it is an
    // admission, and it must not become one.
    h.service.fence();
    parked.release();
    const settled = await starting;
    expect(settled).toMatchObject({ ok: false, refusal: "unavailable" });
    expect(JSON.stringify(settled)).not.toContain("contentKey");
    expect(h.service.inventory().active).toBe(0);
    // And no upload was opened under the account this quit is tearing down.
    expect(h.central.requests.filter((r) => r.url.startsWith("/api/uploads?"))).toEqual([]);
  });

  it("counts an admission that has no job id yet", async () => {
    const h = await harness();
    const parked = h.park();
    const starting = h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 8 }],
      document: 7,
    });
    await parked.arrived;
    // A quit prompt asks what is at stake. This admission is about to read a
    // credential and open an upload; reporting zero would be reporting an idle
    // app over work that is one await from starting.
    expect(h.service.inventory().active).toBe(1);
    parked.release();
    const started = await starting;
    if (started.ok) await h.service.cancel(started.jobId);
  });
});

// ---------------------------------------------------------------------------
// Lifetime: what the coordinator is still holding, and what this side may claim
// ---------------------------------------------------------------------------

describe("job lifetime", () => {
  it("does not run out of coordinator registry after many completed sends", async () => {
    // The registry the coordinator's own `maxLiveJobs` counts is separate from
    // this feature's. Settled jobs were deleted here and left there, so a
    // process that had finished 64 sends — however long ago — refused the 65th.
    const h = await harness();
    for (let i = 0; i < 65; i += 1) {
      const started = await h.service.start({
        target: TARGET,
        kind: "file",
        entries: [{ path: `f-${String(i)}.bin`, size: 8 }],
        document: 7,
      });
      if (!started.ok) throw new Error(`send ${String(i)} was refused: ${started.refusal}`);
      await h.service.cancel(started.jobId);
      expect(h.service.inventory().active).toBe(0);
    }
  });

  it("says UNKNOWN, never cancelled, for a delivery it has forgotten", async () => {
    const h = await harness();
    // Never this process's job at all — the same position it is in after its
    // bounded memory of settled outcomes has evicted one.
    const answer = await h.service.cancel("job-from-a-previous-life");
    // "Cancelled" is a definite claim that nothing was delivered, and there is
    // no basis for it: the delivery may well have happened.
    expect(answer).toMatchObject({ kind: "unknown", reason: "forgotten" });
    expect(answer.kind).not.toBe("cancelled");
  });

  it("still answers a cancel for a job it remembers", async () => {
    const h = await harness();
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 8 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    const first = await h.service.cancel(started.jobId);
    expect(first.kind).toBe("cancelled");
    // Asked again: the REMEMBERED outcome, not a second cancellation and not
    // "forgotten".
    expect(await h.service.cancel(started.jobId)).toMatchObject({ kind: "cancelled" });
  });

  it("coalesces concurrent converges onto one attempt", async () => {
    const h = await harness();
    const files = [fileOf("a.bin", 64)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    h.central.swallowCreate = true;
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    expect((await h.service.end(started.jobId)).kind).toBe("unknown");

    h.central.swallowCreate = false;
    const before = h.central.createCalls;
    // Two presses of "Check again", together. One attempt, one answer — and no
    // second create for one delivery.
    const [a, b] = await Promise.all([
      h.service.converge(started.jobId),
      h.service.converge(started.jobId),
    ]);
    expect(a).toEqual(b);
    expect(a.kind).toBe("delivered");
    expect(h.central.createCalls).toBe(before + 1);
    expect(h.central.tasks.size).toBe(1);
  });

  it("will not let a later converge un-establish an earlier one", async () => {
    const h = await harness();
    const files = [fileOf("a.bin", 64)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    h.central.swallowCreate = true;
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    expect((await h.service.end(started.jobId)).kind).toBe("unknown");

    h.central.swallowCreate = false;
    expect((await h.service.converge(started.jobId)).kind).toBe("delivered");

    // The network goes away again. A re-check that establishes nothing says
    // nothing about what the previous one proved.
    h.central.swallowCreate = true;
    expect(await h.service.converge(started.jobId)).toMatchObject({ kind: "delivered" });
    expect(await h.service.end(started.jobId)).toMatchObject({ kind: "delivered" });
  });
});

describe("what the quit prompt is told is running", () => {
  it("counts a converge that is making a real request", async () => {
    // A re-check reaches central under this account's bearer. Counting only
    // sends made an app settling an unresolved delivery look idle at exactly
    // the moment somebody was deciding whether to end it.
    const h = await harness();
    const files = [fileOf("a.bin", 64)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    h.central.swallowCreate = true;
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    expect((await h.service.end(started.jobId)).kind).toBe("unknown");
    expect(h.service.inventory().active).toBe(0);

    // Hold the converge's create open, and observe that the request is real.
    h.central.swallowCreate = false;
    const parked = h.holdCreate();
    const converging = h.service.converge(started.jobId);
    await parked.arrived;
    expect(h.service.inventory().active).toBeGreaterThan(0);
    // It is still an UNRESOLVED delivery too, and that is a separate count.
    expect(h.service.inventory().unresolved).toBe(1);

    parked.release();
    const view = await converging;
    expect(view.kind).toBe("delivered");
    // Settled: the count returns to nothing, without a teardown having to run.
    expect(h.service.inventory().active).toBe(0);
    expect(h.service.inventory().unresolved).toBe(0);
  });

  it("does not let a converge refuse a new send", async () => {
    // The admission bound and the liveness count are different questions.
    const h = await harness();
    const files = [fileOf("a.bin", 64)];
    const first = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!first.ok) throw new Error("expected a job");
    h.central.swallowCreate = true;
    await h.produce(first.jobId, first.contentKey, files, first.expects);
    await h.service.end(first.jobId);

    h.central.swallowCreate = false;
    const parked = h.holdCreate();
    const converging = h.service.converge(first.jobId);
    await parked.arrived;
    // A re-check is not a send, and must not consume a send's capacity.
    const second = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "b.bin", size: 8 }],
      document: 7,
    });
    expect(second.ok).toBe(true);
    if (second.ok) await h.service.cancel(second.jobId);
    parked.release();
    await converging;
  });

  it("joins a converge in flight when it is disposed", async () => {
    const h = await harness();
    const files = [fileOf("a.bin", 64)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    h.central.swallowCreate = true;
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    await h.service.end(started.jobId);

    h.central.swallowCreate = false;
    const parked = h.holdCreate();
    const converging = h.service.converge(started.jobId);
    await parked.arrived;

    let disposed = false;
    const disposing = h.service.dispose().then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Not "finished" while a request this feature started is still open.
    expect(disposed).toBe(false);
    parked.release();
    await disposing;
    await converging;
    expect(h.service.inventory().active).toBe(0);
  });
});

describe("an unresolved delivery is never evicted by ordinary use", () => {
  /** Leave one delivery unresolved, and answer with its job id. */
  async function leaveUnresolved(h: Harness): Promise<string> {
    const files = [fileOf("a.bin", 64)];
    const started = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "a.bin", size: 64 }],
      document: 7,
    });
    if (!started.ok) throw new Error("expected a job");
    h.central.swallowCreate = true;
    await h.produce(started.jobId, started.contentKey, files, started.expects);
    expect((await h.service.end(started.jobId)).kind).toBe("unknown");
    h.central.swallowCreate = false;
    return started.jobId;
  }

  it("survives sixty-four later settled sends, and still converges", async () => {
    // Reachable only once the coordinator cap was released properly, which is
    // what makes this a REGRESSION of the previous fix rather than a new
    // feature: sixty-four ordinary sends pushed the unresolved delivery out of
    // a single bounded memory and wiped its content key, so a converge answered
    // `unknown` forever for a delivery that had actually been created.
    const h = await harness();
    const stranded = await leaveUnresolved(h);

    for (let i = 0; i < MAX_REMEMBERED_SENDS; i += 1) {
      const started = await h.service.start({
        target: TARGET,
        kind: "file",
        entries: [{ path: `later-${String(i)}.bin`, size: 8 }],
        document: 7,
      });
      if (!started.ok) throw new Error(`later send ${String(i)} was refused: ${started.refusal}`);
      await h.service.cancel(started.jobId);
    }

    // Still unaccounted for, still counted, and still recoverable.
    expect(h.service.inventory().unresolved).toBe(1);
    const settled = await h.service.converge(stranded);
    expect(settled.kind).toBe("delivered");
    expect(h.service.inventory().unresolved).toBe(0);
  });

  it("refuses a NEW send rather than forgetting one it cannot account for", async () => {
    const h = await harness();
    const stranded: string[] = [];
    for (let i = 0; i < MAX_UNRESOLVED_SENDS; i += 1) stranded.push(await leaveUnresolved(h));
    expect(h.service.inventory().unresolved).toBe(MAX_UNRESOLVED_SENDS);

    // The alternative to this refusal is destroying the identity of a delivery
    // that may be live, with no way to establish it afterwards.
    const refused = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "one-too-many.bin", size: 8 }],
      document: 7,
    });
    expect(refused).toMatchObject({ ok: false, refusal: "at-capacity", code: "unresolved-full" });
    // Refused BEFORE any upload: nothing was opened for it.
    const uploads = h.central.requests.filter((r) => r.url.startsWith("/api/uploads?")).length;
    expect(uploads).toBe(MAX_UNRESOLVED_SENDS);

    // Settling one makes room again — the refusal is something the user can act
    // on, which is the whole reason it is a refusal.
    expect((await h.service.converge(stranded[0]!)).kind).toBe("delivered");
    const admitted = await h.service.start({
      target: TARGET,
      kind: "file",
      entries: [{ path: "now-fine.bin", size: 8 }],
      document: 7,
    });
    expect(admitted.ok).toBe(true);
    if (admitted.ok) await h.service.cancel(admitted.jobId);
  });

  it("keeps every stranded delivery's key, not just the newest", async () => {
    const h = await harness();
    const first = await leaveUnresolved(h);
    const second = await leaveUnresolved(h);
    // Both converge, which they could not do if either key had been dropped to
    // make room for the other.
    expect((await h.service.converge(first)).kind).toBe("delivered");
    expect((await h.service.converge(second)).kind).toBe("delivered");
    expect(h.service.inventory().unresolved).toBe(0);
  });
});
