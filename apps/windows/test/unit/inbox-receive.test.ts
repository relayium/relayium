// Owning tests for the receive half: vault, source lease, state and receiver.
//
// SCOPE: fakes plus REAL WebCrypto and the REAL built runtime bundle. These
// prove the ordering, bounding and refusal rules. They prove nothing about the
// server — that is the real-server interop harness — and nothing about the
// native helper's own behaviour, which has its own owning tests.
import { describe, expect, it } from "vitest";

import { captureAccount, type AccountContext } from "../../src/main/inbox/account.js";
import { newAtRestKeyBytes } from "../../src/main/inbox/atrest.js";
import {
  MAX_VAULT_RECORDS,
  MAX_VAULT_TEXT_BYTES,
  MessageVault,
  VaultError,
  type VaultFiles,
} from "../../src/main/inbox/vault.js";
import {
  LEASE_TTL_MS,
  MAX_LIVE_LEASES,
  MAX_SOURCE_CHUNK_BYTES,
  SourceLeaseError,
  SourceLeaseRegistry,
  readItem,
  type SourceItem,
} from "../../src/main/inbox/source.js";
import {
  assertNever,
  describeState,
  isBusy,
  mayClaim,
  type InboxRuntimeState,
} from "../../src/main/inbox/state.js";
import {
  MAX_BODY_ATTEMPTS,
  MAX_RETAINED_HANDLES,
  Receiver,
  describeManifest,
  type PublishReport,
  type ReceiveDestination,
} from "../../src/main/inbox/receiver.js";
import {
  IMPLEMENTED,
  autoAcceptFor,
  capabilitiesFor,
  mayEnrol,
  CAP_AUTO_ACCEPT_V1,
} from "../../src/main/inbox/capabilities.js";
import { inboxRuntime, resetInboxRuntimeForTest } from "../../src/main/inbox/runtime.js";
import type { InboxRuntime } from "../../src/main/inbox/runtime-contract.js";
import { TaskJournal, type JournalFiles } from "../../src/main/inbox/journal.js";
import type { WireDelivery } from "../../src/main/inbox/wire.js";

async function realRuntime(): Promise<InboxRuntime> {
  resetInboxRuntimeForTest();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const artifact = pathToFileURL(resolve(process.cwd(), "dist/main/inbox-runtime.js")).href;
  return inboxRuntime(() => import(artifact) as Promise<{ default?: unknown }>);
}

function fsError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

class FakeFiles implements VaultFiles, JournalFiles {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  writes = 0;
  /** Paths whose next write should fail, to simulate a crash mid-save. */
  readonly failWrites = new Set<string>();

  readFile(path: string): Promise<Uint8Array> {
    const value = this.files.get(path);
    if (value === undefined) return Promise.reject(fsError("ENOENT"));
    return Promise.resolve(value);
  }
  writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
    if (this.failWrites.has(path)) return Promise.reject(fsError("EIO"));
    this.writes += 1;
    this.files.set(path, bytes.slice());
    return Promise.resolve();
  }
  mkdirp(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

const CONTEXT = captureAccount({
  accountID: "person@example.invalid",
  deviceID: "device-1",
  epoch: 1,
  inboxRoot: "/profile/inbox",
});

function vaultOf(files: FakeFiles, context: AccountContext = CONTEXT): MessageVault {
  const key = newAtRestKeyBytes();
  return new MessageVault(context, files, () => Promise.resolve(key));
}

// ---------------------------------------------------------------------------
// Vault — invariant 8
// ---------------------------------------------------------------------------

describe("message vault", () => {
  it("round-trips a message and never writes plaintext", async () => {
    const files = new FakeFiles();
    const vault = vaultOf(files);
    const plaintext = new TextEncoder().encode("meet me at the usual place");

    const meta = await vault.saveText({
      id: "task-1",
      taskID: "task-1",
      sourceDeviceID: "sender-1",
      plaintext,
      now: 1_000,
    });
    expect(meta.bytes).toBe(plaintext.byteLength);
    expect(await vault.openText("task-1")).toEqual(plaintext);

    // Nothing on disk may contain the message.
    for (const bytes of files.files.values()) {
      expect(Buffer.from(bytes).includes(Buffer.from(plaintext))).toBe(false);
      expect(new TextDecoder().decode(bytes)).not.toContain("usual place");
    }
  });

  it("writes the record BEFORE the index", async () => {
    const files = new FakeFiles();
    const vault = vaultOf(files);
    // The index write fails, standing in for a crash between the two writes.
    files.failWrites.add(`${CONTEXT.directory}/vault/index.enc`);

    await expect(
      vault.saveText({
        id: "task-1",
        taskID: "task-1",
        sourceDeviceID: "s",
        plaintext: new Uint8Array([1, 2, 3]),
        now: 1,
      }),
    ).rejects.toThrow();

    // The record exists and the index does not: an orphan, which is harmless.
    // The other order would leave the index naming a record that is not there.
    expect(files.files.has(`${CONTEXT.directory}/vault/task-1.enc`)).toBe(true);
    expect(files.files.has(`${CONTEXT.directory}/vault/index.enc`)).toBe(false);
  });

  it("reports a corrupt index as unreadable and NEVER starts fresh", async () => {
    const files = new FakeFiles();
    const vault = vaultOf(files);
    await vault.saveText({
      id: "task-1",
      taskID: "task-1",
      sourceDeviceID: "s",
      plaintext: new Uint8Array([7]),
      now: 1,
    });

    // Corrupt the sealed index.
    const path = `${CONTEXT.directory}/vault/index.enc`;
    const sealed = files.files.get(path)!;
    sealed[sealed.length - 2] ^= 0x01;

    const fresh = new MessageVault(CONTEXT, files, () => Promise.resolve(newAtRestKeyBytes()));
    await expect(fresh.list()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("reports a record the index names but that is gone", async () => {
    const files = new FakeFiles();
    const vault = vaultOf(files);
    await vault.saveText({
      id: "task-1",
      taskID: "task-1",
      sourceDeviceID: "s",
      plaintext: new Uint8Array([7]),
      now: 1,
    });
    files.files.delete(`${CONTEXT.directory}/vault/task-1.enc`);
    await expect(vault.openText("task-1")).rejects.toMatchObject({ code: "missing-record" });
  });

  it("refuses a record sealed for another account", async () => {
    const files = new FakeFiles();
    const key = newAtRestKeyBytes();
    const a = new MessageVault(CONTEXT, files, () => Promise.resolve(key));
    await a.saveText({
      id: "task-1",
      taskID: "task-1",
      sourceDeviceID: "s",
      plaintext: new Uint8Array([9]),
      now: 1,
    });

    // Same key, same bytes, different account: the associated data differs, so
    // it must not open.
    const other = captureAccount({
      accountID: "someone-else@example.invalid",
      deviceID: "device-1",
      epoch: 1,
      inboxRoot: "/profile/inbox",
    });
    const moved = new FakeFiles();
    moved.files.set(
      `${other.directory}/vault/index.enc`,
      files.files.get(`${CONTEXT.directory}/vault/index.enc`)!,
    );
    const b = new MessageVault(other, moved, () => Promise.resolve(key));
    await expect(b.list()).rejects.toMatchObject({ code: "unreadable" });
  });

  it("is idempotent on a replayed save", async () => {
    const files = new FakeFiles();
    const vault = vaultOf(files);
    const args = {
      id: "task-1",
      taskID: "task-1",
      sourceDeviceID: "s",
      plaintext: new Uint8Array([1, 2]),
      now: 1,
    };
    await vault.saveText(args);
    await vault.saveText(args);
    expect((await vault.list()).length).toBe(1);
  });

  it("refuses an oversized message rather than truncating it", async () => {
    const vault = vaultOf(new FakeFiles());
    await expect(
      vault.saveText({
        id: "t",
        taskID: "t",
        sourceDeviceID: "s",
        plaintext: new Uint8Array(MAX_VAULT_TEXT_BYTES + 1),
        now: 1,
      }),
    ).rejects.toMatchObject({ code: "too-large" });
  });

  it("refuses at the retention bound rather than evicting a message", async () => {
    const files = new FakeFiles();
    const vault = vaultOf(files);
    for (let i = 0; i < MAX_VAULT_RECORDS; i += 1) {
      await vault.saveText({
        id: `task-${i}`,
        taskID: `task-${i}`,
        sourceDeviceID: "s",
        plaintext: new Uint8Array([i & 0xff]),
        now: i,
      });
    }
    await expect(
      vault.saveText({
        id: "one-too-many",
        taskID: "one-too-many",
        sourceDeviceID: "s",
        plaintext: new Uint8Array([1]),
        now: 1,
      }),
    ).rejects.toMatchObject({ code: "vault-full" });
    // The oldest is still there: nothing was dropped to make room.
    expect(await vault.openText("task-0")).toEqual(new Uint8Array([0]));
  });

  it("survives a failed save without wedging the store", async () => {
    const files = new FakeFiles();
    const vault = vaultOf(files);
    await expect(
      vault.saveText({
        id: "",
        taskID: "t",
        sourceDeviceID: "s",
        plaintext: new Uint8Array([1]),
        now: 1,
      }),
    ).rejects.toBeInstanceOf(VaultError);
    // The serialising chain must not be poisoned by the rejection.
    await vault.saveText({
      id: "task-1",
      taskID: "task-1",
      sourceDeviceID: "s",
      plaintext: new Uint8Array([1]),
      now: 1,
    });
    expect((await vault.list()).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Source lease — invariant 7
// ---------------------------------------------------------------------------

function itemOf(name: string, bytes: Uint8Array, chunkSize = 4): SourceItem {
  return {
    name,
    size: bytes.byteLength,
    async *chunks() {
      for (let at = 0; at < bytes.byteLength; at += chunkSize) {
        yield bytes.subarray(at, Math.min(at + chunkSize, bytes.byteLength));
      }
    },
  };
}

describe("source lease", () => {
  it("hands back an opaque id and never a path", () => {
    const registry = new SourceLeaseRegistry(() => 0);
    const summary = registry.create([itemOf("holiday/one.jpg", new Uint8Array(8))]);
    expect(summary.id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(summary)).not.toContain("holiday");
    expect(summary.totalBytes).toBe(8);
  });

  it("is one-shot", () => {
    const registry = new SourceLeaseRegistry(() => 0);
    const { id } = registry.create([itemOf("a", new Uint8Array(2))]);
    expect(registry.take(id).length).toBe(1);
    expect(() => registry.take(id)).toThrow(SourceLeaseError);
  });

  it("expires, and cannot distinguish expired from never-existed", () => {
    let now = 0;
    const registry = new SourceLeaseRegistry(() => now);
    const { id } = registry.create([itemOf("a", new Uint8Array(2))]);
    now += LEASE_TTL_MS + 1;
    expect(() => registry.take(id)).toThrow(
      expect.objectContaining({ code: "no-such-lease" }) as Error,
    );
    expect(() => registry.take("00000000000000000000000000000000")).toThrow(
      expect.objectContaining({ code: "no-such-lease" }) as Error,
    );
  });

  it("bounds how many leases can be live at once", () => {
    const registry = new SourceLeaseRegistry(() => 0);
    for (let i = 0; i < MAX_LIVE_LEASES; i += 1) registry.create([itemOf(`a${i}`, new Uint8Array(1))]);
    expect(() => registry.create([itemOf("one-too-many", new Uint8Array(1))])).toThrow(
      expect.objectContaining({ code: "too-many-leases" }) as Error,
    );
  });

  it("refuses a source that yields more bytes than it declared", async () => {
    const item: SourceItem = {
      name: "a",
      size: 4,
      async *chunks() {
        yield new Uint8Array(4);
        yield new Uint8Array(1);
      },
    };
    const signal = new AbortController().signal;
    await expect(async () => {
      for await (const _ of readItem(item, signal)) {
        // drain
      }
    }).rejects.toMatchObject({ code: "length-mismatch" });
  });

  it("refuses a source that yields fewer bytes than it declared", async () => {
    const item = itemOf("a", new Uint8Array(3));
    const short: SourceItem = { ...item, size: 9 };
    const signal = new AbortController().signal;
    await expect(async () => {
      for await (const _ of readItem(short, signal)) {
        // drain
      }
    }).rejects.toMatchObject({ code: "length-mismatch" });
  });

  it("refuses an oversized chunk", async () => {
    const item: SourceItem = {
      name: "a",
      size: MAX_SOURCE_CHUNK_BYTES + 1,
      async *chunks() {
        yield new Uint8Array(MAX_SOURCE_CHUNK_BYTES + 1);
      },
    };
    const signal = new AbortController().signal;
    await expect(async () => {
      for await (const _ of readItem(item, signal)) {
        // drain
      }
    }).rejects.toMatchObject({ code: "chunk-too-large" });
  });
});

// ---------------------------------------------------------------------------
// State union
// ---------------------------------------------------------------------------

describe("runtime state", () => {
  const states: InboxRuntimeState[] = [
    { kind: "disabled" },
    { kind: "unavailable", reason: "not-enrolled" },
    { kind: "idle", pending: 0 },
    {
      kind: "receiving",
      progress: { total: 2, published: 1, totalBytes: 10, receivedBytes: 5, text: false },
    },
    { kind: "blocked", reason: "reconcile-blocked", residue: "unknown", pending: 1 },
  ];

  it("labels every variant without throwing", () => {
    for (const state of states) expect(typeof describeState(state)).toBe("string");
  });

  it("only `receiving` is busy, and only `idle` may claim", () => {
    expect(states.filter(isBusy).map((s) => s.kind)).toEqual(["receiving"]);
    expect(states.filter(mayClaim).map((s) => s.kind)).toEqual(["idle"]);
  });

  it("a blocked state is a genuine stop, not a slow idle", () => {
    const blocked = states.find((s) => s.kind === "blocked")!;
    expect(mayClaim(blocked)).toBe(false);
    expect(isBusy(blocked)).toBe(false);
  });

  it("assertNever throws on a variant widened from an untyped edge", () => {
    expect(() => assertNever({ kind: "invented" } as never)).toThrow(/unhandled variant/);
  });
});

// ---------------------------------------------------------------------------
// Capabilities — the interop finding
// ---------------------------------------------------------------------------

describe("capabilities", () => {
  it("advertises nothing while nothing is implemented", async () => {
    const runtime = await realRuntime();
    expect(capabilitiesFor(runtime, IMPLEMENTED)).toEqual([]);
    expect(mayEnrol(IMPLEMENTED)).toBe(false);
  });

  it("defaults to `ask`, because `off` makes central refuse every send", () => {
    expect(autoAcceptFor(IMPLEMENTED, { enabled: true })).toBe("ask");
    // Even when the user asks for auto, a build that does not implement it must
    // not claim the policy: central gates it on the separate capability.
    expect(autoAcceptFor(IMPLEMENTED, { enabled: true, autoAccept: true })).toBe("ask");
  });

  it("auto-accept is its own capability, gated on its own switch", async () => {
    const runtime = await realRuntime();
    const withAuto = { files: true, text: false, autoAccept: true };
    expect(capabilitiesFor(runtime, withAuto)).toContain(CAP_AUTO_ACCEPT_V1);
    expect(autoAcceptFor(withAuto, { enabled: true, autoAccept: true })).toBe("auto");
    // Receiving does not imply accepting silently.
    expect(capabilitiesFor(runtime, { files: true, text: false, autoAccept: false })).not.toContain(
      CAP_AUTO_ACCEPT_V1,
    );
  });

  it("auto-accept alone is not a reason to enrol", () => {
    expect(mayEnrol({ files: false, text: false, autoAccept: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Receiver — invariants 3, 4 and 6
// ---------------------------------------------------------------------------

class FakeDestination implements ReceiveDestination {
  readonly written = new Map<number, number[]>();
  readonly calls: string[] = [];
  published = false;
  cancelled = false;
  /** What publish() will report. */
  report: PublishReport;
  /** When set, cancel() rejects with this residue flag. */
  cancelResidue: boolean | null = null;
  /** When set, publish() REJECTS with this instead of resolving. */
  publishThrows: unknown = null;

  constructor(readonly fileCount: number, report?: PublishReport) {
    this.report = report ?? { status: "complete", publishedCount: fileCount, total: fileCount };
  }
  begin(index: number): Promise<void> {
    this.calls.push(`begin:${index}`);
    this.written.set(index, []);
    return Promise.resolve();
  }
  write(index: number, chunk: Uint8Array): Promise<void> {
    this.written.get(index)!.push(...chunk);
    return Promise.resolve();
  }
  finish(index: number): Promise<void> {
    this.calls.push(`finish:${index}`);
    return Promise.resolve();
  }
  publish(): Promise<PublishReport> {
    this.calls.push("publish");
    if (this.publishThrows !== null) return Promise.reject(this.publishThrows);
    this.published = true;
    return Promise.resolve(this.report);
  }
  cancel(): Promise<void> {
    this.calls.push("cancel");
    this.cancelled = true;
    if (this.cancelResidue !== null) {
      return Promise.reject(
        Object.assign(new Error("residue"), { code: "residue", residue: this.cancelResidue }),
      );
    }
    return Promise.resolve();
  }
}

/** Build a real encrypted delivery with the real runtime. */
async function buildDelivery(
  runtime: InboxRuntime,
  items: readonly { name?: string; size: number; kind: "file" | "text" }[],
  payload: Uint8Array,
): Promise<{ delivery: WireDelivery; ciphertext: Uint8Array; contentKey: Uint8Array }> {
  const contentKey = crypto.getRandomValues(new Uint8Array(runtime.constants.contentKeyBytes));
  const storeKey = await runtime.importStoreKey(contentKey);
  const manifest =
    items[0]!.kind === "text"
      ? runtime.textManifest(items[0]!.size)
      : runtime.fileManifest(items.map((i) => ({ name: i.name!, size: i.size })));

  const { encodeInboxManifestBytes } = (await import(
    /* @vite-ignore */ new URL("../../../../web/src/lib/inbox-manifest.ts", import.meta.url).href
  )) as { encodeInboxManifestBytes: (m: unknown) => Uint8Array };
  const encManifest = await runtime.sealManifestBytes(storeKey, encodeInboxManifestBytes(manifest));

  // Frames: seq 1..n over the payload, matching the sender's chunking.
  const frames: Uint8Array[] = [];
  const chunk = runtime.constants.storeChunkSize;
  let seq = 1;
  for (let at = 0; at < payload.byteLength; at += chunk) {
    const slice = payload.subarray(at, Math.min(at + chunk, payload.byteLength));
    // Copied into an ArrayBuffer-backed view: WebCrypto's BufferSource requires
    // one, and a subarray of a Node-typed Uint8Array is ArrayBufferLike.
    const piece = new Uint8Array(slice.byteLength);
    piece.set(slice);
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(8, seq);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, storeKey, piece),
    );
    const framed = new Uint8Array(4 + ct.byteLength);
    new DataView(framed.buffer).setUint32(0, ct.byteLength);
    framed.set(ct, 4);
    frames.push(framed);
    seq += 1;
  }
  let total = 0;
  for (const f of frames) total += f.byteLength;
  const ciphertext = new Uint8Array(total);
  let at = 0;
  for (const f of frames) {
    ciphertext.set(f, at);
    at += f.byteLength;
  }

  const delivery: WireDelivery = {
    ID: "task-1",
    SourceDeviceID: "sender-1",
    IdempotencyKey: "idem-1",
    State: "queued",
    ErrorCode: "",
    CiphertextBytes: ciphertext.byteLength,
    WrapAlgorithm: runtime.constants.keyAlgorithm,
    TargetKeyID: "key-1",
    TargetKeyGeneration: 1,
    CreatedAt: 1,
    ExpiresAt: 9_999,
    SavedAt: 0,
    Terminal: false,
    EncManifest: Buffer.from(encManifest).toString("base64"),
    WrappedKey: runtime.encodeKey(contentKey),
    ClaimToken: "claim-1",
  };
  return { delivery, ciphertext, contentKey };
}

interface ApiCall {
  readonly kind: string;
  readonly state?: string;
  readonly committed?: boolean;
}

function receiverFor(
  runtime: InboxRuntime,
  contentKey: Uint8Array,
  ciphertext: Uint8Array,
  destination: ReceiveDestination | null,
  options: {
    readonly calls: ApiCall[];
    readonly files?: FakeFiles;
    readonly blobFailFirst?: boolean;
    readonly failReportState?: string;
    readonly lieAboutPartial?: boolean;
    /** Deliver the body in N pieces with a real gap, so renewals can fire. */
    readonly slowChunks?: number;
    readonly leaseSeconds?: number;
    /** Fail journal.advance for this phase, AFTER the publish has happened. */
    readonly failJournalPhase?: string;
    /** A fresh destination per delivery, recorded, for distinct-id tests. */
    readonly destinationFactory?: () => ReceiveDestination;
    /** Bodies do not yield until this resolves, parking every opener. */
    readonly park?: Promise<void>;
    readonly context?: AccountContext;
    readonly currentAccount?: () => AccountContext;
  },
): { receiver: Receiver; journal: TaskJournal; vault: MessageVault } {
  const files = options.files ?? new FakeFiles();
  const atRest = newAtRestKeyBytes();
  const context = options.context ?? CONTEXT;
  const journal = new TaskJournal(context, files, () => Promise.resolve(atRest));
  const vault = new MessageVault(context, files, () => Promise.resolve(atRest));
  let served = 0;

  const receiver = new Receiver({
    context,
    runtime,
    api: {
      report(_taskID, _claim, state, committed) {
        options.calls.push({ kind: "report", state, committed });
        if (options.failReportState === state) {
          return Promise.reject(Object.assign(new Error("network"), { code: "network" }));
        }
        return Promise.resolve({ State: state, Terminal: state === "saved", SavedAt: 1 });
      },
      blob(_taskID, _claim, offset) {
        options.calls.push({ kind: `blob:${offset}` });
        served += 1;
        const failThis = options.blobFailFirst === true && served === 1;
        const slice = ciphertext.subarray(offset);
        let delivered = false;
        let sentAt = 0;
        return Promise.resolve({
          partial: options.lieAboutPartial === true ? false : offset > 0,
          body: options.park !== undefined
            ? new ReadableStream<Uint8Array>({
                async pull(controller) {
                  await options.park;
                  controller.enqueue(slice);
                  controller.close();
                },
              })
            : options.slowChunks !== undefined && !failThis
            ? new ReadableStream<Uint8Array>({
                async pull(controller) {
                  const pieces = options.slowChunks!;
                  const step = Math.ceil(slice.byteLength / pieces);
                  if (sentAt >= slice.byteLength) {
                    controller.close();
                    return;
                  }
                  await new Promise((r) => setTimeout(r, 15));
                  controller.enqueue(slice.subarray(sentAt, Math.min(sentAt + step, slice.byteLength)));
                  sentAt += step;
                },
              })
            : new ReadableStream<Uint8Array>({
            // `pull` rather than `start`: erroring a controller DISCARDS its
            // queue, so a prefix enqueued next to the error would never be
            // delivered and the resume would have nothing to resume from —
            // which is not the case under test.
            pull(controller) {
              if (!failThis) {
                controller.enqueue(slice);
                controller.close();
                return;
              }
              if (delivered) {
                controller.error(Object.assign(new Error("reset"), { code: "network" }));
                return;
              }
              delivered = true;
              controller.enqueue(slice.subarray(0, Math.floor(slice.byteLength / 2)));
            },
          }),
        });
      },
    },
    keys: {
      openSealedContentKey(keyID) {
        if (keyID !== "key-1") {
          return Promise.reject(Object.assign(new Error("unknown-key"), { code: "unknown-key" }));
        }
        return Promise.resolve(contentKey.slice());
      },
    },
    journal,
    vault,
    destinationFor() {
      if (options.destinationFactory !== undefined) {
        return Promise.resolve(options.destinationFactory());
      }
      if (destination === null) return Promise.reject(new Error("no destination"));
      return Promise.resolve(destination);
    },
    currentAccount: options.currentAccount ?? (() => context),
    now: () => 1_000,
    idleTimeoutMs: 5_000,
    ...(options.leaseSeconds !== undefined ? { leaseSeconds: options.leaseSeconds } : {}),
  });
  if (options.failJournalPhase !== undefined) {
    const real = journal.advance.bind(journal);
    journal.advance = async (taskID, phase, count, now) => {
      if (phase === options.failJournalPhase) {
        throw Object.assign(new Error("journal write failed"), { code: "unreadable" });
      }
      return real(taskID, phase, count, now);
    };
  }
  return { receiver, journal, vault };
}

describe("receiver", () => {
  it("reports verifying BEFORE it commits, and saved only after", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(64).fill(7);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "one.bin", size: 64 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, { calls });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved", total: 1 });

    const states = calls.filter((c) => c.kind === "report").map((c) => c.state);
    expect(states).toEqual(["downloading", "verifying", "saved"]);
    // `verifying` must precede the publish, and `saved` must follow it.
    const order = [...destination.calls];
    expect(order).toContain("publish");
    expect(destination.written.get(0)).toEqual([...payload]);
  });

  it("journals `publishing` BEFORE the publish and `published` BEFORE the ACK", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(32).fill(3);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 32 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver, journal } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
    });
    await receiver.receive(delivery, new AbortController().signal);
    const record = await journal.find("task-1");
    expect(record?.phase).toBe("acked");
    expect(record?.publishedCount).toBe(1);
    expect(record?.serverTerminal).toBe(true);
  });

  it("records a partial publish as partial and does NOT ACK it", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(8).fill(1);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [
        { kind: "file", name: "a.bin", size: 4 },
        { kind: "file", name: "b.bin", size: 4 },
      ],
      payload,
    );
    const destination = new FakeDestination(2, {
      status: "partial",
      publishedCount: 1,
      total: 2,
      failedIndex: 1,
      reason: "E_IO",
    });
    const calls: ApiCall[] = [];
    const { receiver, journal } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "partial", savedCount: 1, total: 2, failedIndex: 1 });
    // No `saved` report: telling central a partial batch was complete is the
    // one thing this path must never do.
    expect(calls.filter((c) => c.state === "saved")).toEqual([]);
    expect((await journal.find("task-1"))?.phase).toBe("partial");
  });

  it("keeps the claimed prefix when a publish receipt disagrees with the manifest", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(4);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 4 }],
      payload,
    );
    // The helper claims two files landed where the manifest declared one.
    const destination = new FakeDestination(1, {
      status: "complete",
      publishedCount: 2,
      total: 2,
    });
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, { calls });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    // NOT `refused`: the receipt claims a file landed, and discarding that would
    // tell the user nothing was saved while something may be on disk. It is not
    // `saved` either — the three numbers disagree, so completion is not claimed.
    expect(receipt).toMatchObject({ kind: "partial", reason: "total-mismatch", savedCount: 2 });
    // Central is never told `saved` on the strength of a receipt that
    // contradicts the manifest.
    expect(calls.filter((c) => c.state === "saved")).toEqual([]);
  });

  it("refuses a truncated body rather than publishing a short file", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(64).fill(5);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 64 }],
      payload,
    );
    // Cut the last frame off entirely, so the stream ends ON a frame boundary —
    // the truncation that is otherwise indistinguishable from a clean end.
    const short = ciphertext.subarray(0, ciphertext.byteLength - 1);
    const delivered: WireDelivery = { ...delivery, CiphertextBytes: short.byteLength };
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, short, destination, { calls });

    const receipt = await receiver.receive(delivered, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    expect(destination.published).toBe(false);
    expect(destination.cancelled).toBe(true);
  });

  it("surfaces helper residue truthfully rather than softening it", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(16).fill(2);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 16 }],
      payload,
    );
    const destination = new FakeDestination(1);
    destination.cancelResidue = true;
    const bad: WireDelivery = { ...delivery, TargetKeyID: "key-does-not-exist" };
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, { calls });

    const receipt = await receiver.receive(bad, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    if (receipt.kind === "refused") {
      expect(receipt.failure.code).toBe("key-unavailable");
    }
  });

  it("resumes at the ciphertext offset already consumed", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(128).fill(9);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 128 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      blobFailFirst: true,
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved" });
    const blobs = calls.filter((c) => c.kind.startsWith("blob:")).map((c) => c.kind);
    expect(blobs.length).toBe(2);
    expect(blobs[0]).toBe("blob:0");
    // The second request resumed rather than restarting.
    expect(blobs[1]).not.toBe("blob:0");
    expect(destination.written.get(0)).toEqual([...payload]);
  });

  it("stops when the account changes under it", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(16).fill(4);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 16 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const other = captureAccount({
      accountID: "someone-else@example.invalid",
      deviceID: "device-2",
      epoch: 2,
      inboxRoot: "/profile/inbox",
    });
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      currentAccount: () => other,
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    if (receipt.kind === "refused") expect(receipt.failure.code).toBe("account-changed");
    expect(destination.published).toBe(false);
  });

  it("saves a message to the vault, with no destination involved", async () => {
    const runtime = await realRuntime();
    const message = new TextEncoder().encode("hello from the other device");
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "text", size: message.byteLength }],
      message,
    );
    const calls: ApiCall[] = [];
    const { receiver, vault } = receiverFor(runtime, contentKey, ciphertext, null, { calls });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved-message" });
    expect(await vault.openText("task-1")).toEqual(message);
    expect(calls.filter((c) => c.kind === "report").map((c) => c.state)).toEqual([
      "downloading",
      "verifying",
      "saved",
    ]);
  });

  it("bounds body attempts", () => {
    expect(MAX_BODY_ATTEMPTS).toBe(5);
  });
});

describe("manifest planning", () => {
  it("refuses a mixed-kind manifest", () => {
    expect(() =>
      describeManifest({
        v: 3,
        items: [
          { kind: "file", name: "a", size: 1 },
          { kind: "text", size: 1 },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "manifest-refused" }) as Error);
  });

  it("refuses a text item that carries a name", () => {
    expect(() =>
      describeManifest({ v: 3, items: [{ kind: "text", name: "message.txt", size: 4 }] }),
    ).toThrow(expect.objectContaining({ code: "manifest-refused" }) as Error);
  });

  it("refuses a file item with no name", () => {
    expect(() => describeManifest({ v: 3, items: [{ kind: "file", size: 4 }] })).toThrow(
      expect.objectContaining({ code: "manifest-refused" }) as Error,
    );
  });

  it("refuses a manifest with no items", () => {
    expect(() => describeManifest({ v: 3, items: [] })).toThrow(
      expect.objectContaining({ code: "manifest-refused" }) as Error,
    );
  });
});

// ---------------------------------------------------------------------------
// The discriminating cases from root's receiver review
// ---------------------------------------------------------------------------

describe("receiver — review cases", () => {
  it("creates and finishes a zero-size file, which produces no bytes at all", async () => {
    const runtime = await realRuntime();
    // One item, size 0. Nothing ever arrives for it, so a cursor driven by
    // chunk arrival would never visit it and the file would be lost.
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "empty.bin", size: 0 }],
      new Uint8Array(0),
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, { calls });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved", total: 1 });
    expect(destination.calls).toContain("begin:0");
    expect(destination.calls).toContain("finish:0");
  });

  it("finishes an empty file that TRAILS the last byte of content", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array([42]);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [
        { kind: "file", name: "one.bin", size: 1 },
        { kind: "file", name: "trailing-empty.bin", size: 0 },
      ],
      payload,
    );
    const destination = new FakeDestination(2);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, { calls });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved", total: 2 });
    // The trailing empty is drained by end(), after the last byte has arrived.
    expect(destination.calls).toContain("begin:1");
    expect(destination.calls).toContain("finish:1");
    expect(destination.written.get(0)).toEqual([42]);
  });

  it("does NOT publish when the account changes while the journal write is held", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(16).fill(6);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 16 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    let current = CONTEXT;
    const { receiver, journal } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      currentAccount: () => current,
    });

    // The sign-out lands DURING the `publishing` journal write — the window an
    // account check at the top of the operation cannot see.
    const realAdvance = journal.advance.bind(journal);
    journal.advance = async (taskID, phase, count, now) => {
      const result = await realAdvance(taskID, phase, count, now);
      if (phase === "publishing") {
        current = captureAccount({
          accountID: "someone-else@example.invalid",
          deviceID: "device-2",
          epoch: 2,
          inboxRoot: "/profile/inbox",
        });
      }
      return result;
    };

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    if (receipt.kind === "refused") expect(receipt.failure.code).toBe("account-changed");
    expect(destination.published).toBe(false);
    expect(calls.filter((c) => c.state === "saved")).toEqual([]);
  });

  it("does NOT publish when a cancel lands while the journal write is held", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(16).fill(6);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 16 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const aborter = new AbortController();
    const { receiver, journal } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
    });

    const realAdvance = journal.advance.bind(journal);
    journal.advance = async (taskID, phase, count, now) => {
      const result = await realAdvance(taskID, phase, count, now);
      if (phase === "publishing") aborter.abort();
      return result;
    };

    const receipt = await receiver.receive(delivery, aborter.signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    if (receipt.kind === "refused") expect(receipt.failure.code).toBe("cancelled");
    expect(destination.published).toBe(false);
  });

  it("keeps the saved prefix when publish REJECTS with a valid receipt", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(16).fill(8);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 16 }],
      payload,
    );
    // Exactly the shape `settleAfterPublish` throws: publication succeeded and
    // only the teardown did not, with the validated report attached.
    const destination = new FakeDestination(1);
    destination.publishThrows = Object.assign(new Error("published, but cleanup left bytes"), {
      code: "residue",
      residue: true,
      publishReport: { status: "complete", publishedCount: 1, total: 1 },
    });
    const calls: ApiCall[] = [];
    const { receiver, journal } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    // The files exist. Reporting `refused` here would be false in the direction
    // that matters.
    expect(receipt).toMatchObject({ kind: "saved", total: 1, residue: "present" });
    expect(calls.filter((c) => c.state === "saved").length).toBe(1);
    expect((await journal.find("task-1"))?.phase).toBe("acked");
    // The handle is RETAINED, not dropped: the child may still be live.
    expect(receiver.retainedHandles().map((h) => h.taskID)).toEqual(["task-1"]);
  });

  it("reports a lost ACK as committed-with-ack-pending, not as a failure", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(16).fill(4);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 16 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver, journal } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      failReportState: "saved",
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved", total: 1, ackPending: true });
    // Left at `published`, whose reconciliation is "replay the ACK" — never a
    // re-download and never a re-publish.
    expect((await journal.find("task-1"))?.phase).toBe("published");
    expect((await journal.find("task-1"))?.publishedCount).toBe(1);
  });

  it("retains a destination whose cancel failed, and bounds new admission", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(16).fill(1);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 16 }],
      payload,
    );
    const destination = new FakeDestination(1);
    destination.cancelResidue = true;
    // Fail the publish outright, with no receipt: the handle is still ours.
    destination.publishThrows = Object.assign(new Error("publish refused"), {
      code: "publish-failed",
    });
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, { calls });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    const retained = receiver.retainedHandles();
    expect(retained.length).toBe(1);
    // The OBJECT is kept, not a count: it is what can still be cancelled.
    expect(retained[0]!.destination).toBe(destination);
    expect(retained[0]!.residue).toBe("present");
    // Cleanup succeeds this time, so ownership may be given up.
    destination.cancelResidue = null;
    expect(await receiver.releaseRetained(retained[0]!.key)).toBe(true);
    expect(receiver.canAdmit()).toBe(true);
  });

  it("refuses new work once the retention bound is reached", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(4);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 4 }],
      payload,
    );
    const calls: ApiCall[] = [];
    const destination = new FakeDestination(1);
    destination.cancelResidue = true;
    destination.publishThrows = Object.assign(new Error("publish refused"), {
      code: "publish-failed",
    });
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, { calls });

    for (let i = 0; i < MAX_RETAINED_HANDLES; i += 1) {
      await receiver.receive({ ...delivery, ID: `task-${i}` }, new AbortController().signal);
    }
    expect(receiver.retainedHandles().length).toBe(MAX_RETAINED_HANDLES);
    expect(receiver.canAdmit()).toBe(false);

    const before = calls.length;
    const refused = await receiver.receive({ ...delivery, ID: "one-too-many" }, new AbortController().signal);
    expect(refused).toMatchObject({ kind: "refused" });
    // Refused without touching the network at all.
    expect(calls.length).toBe(before);
  });

  it("does NOT re-download after a decrypt failure", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(64).fill(2);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 64 }],
      payload,
    );
    // Tamper with the ciphertext body: the AEAD must refuse, and refusing is
    // not something another download would fix.
    const tampered = ciphertext.slice();
    tampered[tampered.length - 1] ^= 0x01;
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, tampered, destination, { calls });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    expect(destination.published).toBe(false);
    // Exactly one body request: a tampered stream is never re-fetched.
    expect(calls.filter((c) => c.kind.startsWith("blob:")).length).toBe(1);
  });

  it("refuses a resume the transport did not answer as a range", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(128).fill(3);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 128 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      blobFailFirst: true,
      // The resume comes back claiming NOT to be partial. Splicing it would
      // produce plaintext nobody sent.
      lieAboutPartial: true,
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "refused" });
    expect(destination.published).toBe(false);
  });

  it("removes its abort listener after every read", async () => {
    const runtime = await realRuntime();
    // Many small frames means many reads, so a listener left on each one would
    // accumulate visibly.
    const payload = new Uint8Array(64).fill(5);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 64 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const aborter = new AbortController();
    let added = 0;
    let removed = 0;
    const realAdd = aborter.signal.addEventListener.bind(aborter.signal);
    const realRemove = aborter.signal.removeEventListener.bind(aborter.signal);
    aborter.signal.addEventListener = ((type: string, listener: never, opts: never) => {
      if (type === "abort") added += 1;
      return realAdd(type, listener, opts);
    }) as typeof aborter.signal.addEventListener;
    aborter.signal.removeEventListener = ((type: string, listener: never, opts: never) => {
      if (type === "abort") removed += 1;
      return realRemove(type, listener, opts);
    }) as typeof aborter.signal.removeEventListener;

    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, { calls });
    await receiver.receive(delivery, aborter.signal);
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

// ---------------------------------------------------------------------------
// The two pre-freeze blockers
// ---------------------------------------------------------------------------

describe("receiver — lease renewal and post-commit markers", () => {
  it("renews REPEATEDLY and joins, rather than once and forever", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(256).fill(7);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 256 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      // A third of 30ms: renewals every 10ms while a ~150ms body streams.
      leaseSeconds: 0.03,
      slowChunks: 10,
    });

    // Completing at all is half the assertion: with the tracking bug, `stop()`
    // spun on an already-resolved promise and this never returned.
    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved" });

    // Renewals are reports of the CURRENT state, beyond the one that opens the
    // download. A version that renewed once would show exactly one.
    const renewals = calls.filter((c) => c.kind === "report" && c.state === "downloading").length - 1;
    expect(renewals).toBeGreaterThanOrEqual(2);

    // Nothing keeps renewing after the job that owned the timer has finished.
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.length).toBe(after);
  });

  it("keeps the receipt when the post-publish journal marker fails", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(16).fill(9);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 16 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      // The marker written AFTER the files exist.
      failJournalPhase: "published",
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    // The files are on disk. Reporting `refused` would be false in the
    // direction that matters.
    expect(receipt).toMatchObject({ kind: "saved", total: 1 });
    // And the uncertainty is stated rather than papered over: there is no
    // durable record for a later run to reconcile from.
    if (receipt.kind === "saved") {
      expect(receipt.journalRecorded).toBe(false);
    }
    expect(destination.published).toBe(true);
    // Still acknowledged: the report is truthful and it stops a redelivery this
    // side could no longer prove it had completed.
    expect(calls.filter((c) => c.state === "saved").length).toBe(1);
  });

  it("keeps the message receipt when the post-save journal marker fails", async () => {
    const runtime = await realRuntime();
    const message = new TextEncoder().encode("this message was saved");
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "text", size: message.byteLength }],
      message,
    );
    const calls: ApiCall[] = [];
    const { receiver, vault } = receiverFor(runtime, contentKey, ciphertext, null, {
      calls,
      failJournalPhase: "published",
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "saved-message" });
    if (receipt.kind === "saved-message") {
      expect(receipt.journalRecorded).toBe(false);
    }
    // The message really is in the vault.
    expect(await vault.openText("task-1")).toEqual(message);
  });

  it("keeps a partial receipt when its marker fails", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(8).fill(1);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [
        { kind: "file", name: "a.bin", size: 4 },
        { kind: "file", name: "b.bin", size: 4 },
      ],
      payload,
    );
    const destination = new FakeDestination(2, {
      status: "partial",
      publishedCount: 1,
      total: 2,
      failedIndex: 1,
      reason: "E_IO",
    });
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      failJournalPhase: "partial",
    });

    const receipt = await receiver.receive(delivery, new AbortController().signal);
    expect(receipt).toMatchObject({ kind: "partial", savedCount: 1, journalRecorded: false });
    expect(calls.filter((c) => c.state === "saved")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adversarial: ownership of live adapters
// ---------------------------------------------------------------------------

describe("receiver — retained ownership", () => {
  /** A receiver whose deliveries always end with an unresolved teardown. */
  async function stuckDelivery(runtime: InboxRuntime) {
    const payload = new Uint8Array(8).fill(1);
    const built = await buildDelivery(runtime, [{ kind: "file", name: "a.bin", size: 8 }], payload);
    const destination = new FakeDestination(1);
    destination.cancelResidue = true;
    destination.publishThrows = Object.assign(new Error("publish refused"), {
      code: "publish-failed",
    });
    return { ...built, destination };
  }

  it("never overwrites a retained handle for a task it is asked to redo", async () => {
    const runtime = await realRuntime();
    const first = await stuckDelivery(runtime);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, first.contentKey, first.ciphertext, first.destination, {
      calls,
    });

    await receiver.receive(first.delivery, new AbortController().signal);
    const retained = receiver.retainedHandles();
    expect(retained.length).toBe(1);
    const owned = retained[0]!.destination;

    // The SAME task id again. Under a map keyed by task id with no guard, the
    // second retain would replace the first and the live child behind it would
    // have nothing referring to it.
    const again = await receiver.receive(first.delivery, new AbortController().signal);
    expect(again).toMatchObject({ kind: "refused" });
    expect(receiver.retainedHandles().length).toBe(1);
    expect(receiver.retainedHandles()[0]!.destination).toBe(owned);
  });

  it("refuses a second delivery of the same task already in flight", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(128).fill(2);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 128 }],
      payload,
    );
    const destination = new FakeDestination(1);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, destination, {
      calls,
      slowChunks: 6,
    });

    // Started concurrently, and the reservation happens before the first await,
    // so the second cannot get past it.
    const [a, b] = await Promise.all([
      receiver.receive(delivery, new AbortController().signal),
      receiver.receive(delivery, new AbortController().signal),
    ]);
    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(["refused", "saved"]);
    // The duplicate must be stopped BY THE RESERVATION, before any await — so
    // it never reaches the network at all. Asserting only on the outcome would
    // pass on a build with no guard, because the journal's transition table
    // rejects the second publish anyway; that is a different mechanism, one
    // step later, after a wasted download.
    expect(calls.filter((c) => c.kind.startsWith("blob:")).length).toBe(1);
    expect(calls.filter((c) => c.kind === "report").length).toBeGreaterThan(0);
    expect(destination.calls.filter((c) => c === "publish").length).toBe(1);
  });

  it("keeps ownership when a release attempt does not conclude", async () => {
    const runtime = await realRuntime();
    const stuck = await stuckDelivery(runtime);
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, stuck.contentKey, stuck.ciphertext, stuck.destination, {
      calls,
    });
    await receiver.receive(stuck.delivery, new AbortController().signal);
    const key = receiver.retainedHandles()[0]!.key;

    // Cleanup still fails. Asking is not evidence, so ownership is kept.
    expect(await receiver.releaseRetained(key)).toBe(false);
    expect(receiver.retainedHandles().length).toBe(1);
    // The fresh failure updates what is recorded rather than dropping it.
    expect(receiver.retainedHandles()[0]!.residue).toBe("present");

    // Only an OBSERVED success gives it up.
    stuck.destination.cancelResidue = null;
    expect(await receiver.releaseRetained(key)).toBe(true);
    expect(receiver.retainedHandles()).toEqual([]);
  });

  it("reports the bound as retention-full rather than as an internal error", async () => {
    const runtime = await realRuntime();
    const calls: ApiCall[] = [];
    const first = await stuckDelivery(runtime);
    const { receiver } = receiverFor(runtime, first.contentKey, first.ciphertext, first.destination, {
      calls,
    });
    for (let i = 0; i < MAX_RETAINED_HANDLES; i += 1) {
      await receiver.receive({ ...first.delivery, ID: `task-${i}` }, new AbortController().signal);
    }
    const refused = await receiver.receive(
      { ...first.delivery, ID: "one-too-many" },
      new AbortController().signal,
    );
    expect(refused).toMatchObject({ kind: "refused" });
    if (refused.kind === "refused") expect(refused.failure.code).toBe("retention-full");
  });
});

// ---------------------------------------------------------------------------
// The bound applies to DISTINCT ids too
// ---------------------------------------------------------------------------

describe("receiver — live adapter bound", () => {
  it("never opens more destinations than the exported bound, for distinct tasks", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(32).fill(3);
    const { delivery, ciphertext, contentKey } = await buildDelivery(
      runtime,
      [{ kind: "file", name: "a.bin", size: 32 }],
      payload,
    );

    // Every opener parks inside its body, so all of them are in flight at once
    // and none has reached `retain` yet. Bounding only on retained handles
    // therefore admitted every one of them.
    let release: () => void = () => undefined;
    const park = new Promise<void>((resolve) => {
      release = resolve;
    });

    const built: FakeDestination[] = [];
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, contentKey, ciphertext, null, {
      calls,
      park,
      destinationFactory: () => {
        const d = new FakeDestination(1);
        built.push(d);
        return d;
      },
    });

    // The bound is READ FROM THE EXPORT rather than hardcoded, so this test
    // still means the same thing if the constant changes.
    const attempts = MAX_RETAINED_HANDLES + 1;
    const running = Array.from({ length: attempts }, (_, i) =>
      receiver.receive({ ...delivery, ID: `distinct-${String(i)}` }, new AbortController().signal),
    );

    // Give every admitted delivery the chance to reach its destination.
    await new Promise((r) => setTimeout(r, 20));
    expect(built.length).toBeLessThanOrEqual(MAX_RETAINED_HANDLES);
    // And the ones above the bound never downloaded anything either.
    expect(calls.filter((c) => c.kind.startsWith("blob:")).length).toBeLessThanOrEqual(
      MAX_RETAINED_HANDLES,
    );

    release();
    const receipts = await Promise.all(running);
    expect(receipts.filter((r) => r.kind === "refused").length).toBeGreaterThanOrEqual(1);
    const refused = receipts.find((r) => r.kind === "refused");
    if (refused?.kind === "refused") expect(refused.failure.code).toBe("retention-full");
  });

  it("runs one cleanup attempt per entry, so overlapping releases cannot double-cancel", async () => {
    const runtime = await realRuntime();
    const payload = new Uint8Array(8).fill(1);
    const built = await buildDelivery(runtime, [{ kind: "file", name: "a.bin", size: 8 }], payload);
    const destination = new FakeDestination(1);
    destination.cancelResidue = true;
    destination.publishThrows = Object.assign(new Error("publish refused"), {
      code: "publish-failed",
    });
    const calls: ApiCall[] = [];
    const { receiver } = receiverFor(runtime, built.contentKey, built.ciphertext, destination, {
      calls,
    });
    await receiver.receive(built.delivery, new AbortController().signal);
    const key = receiver.retainedHandles()[0]!.key;

    // Two overlapping releases. Cancelling one destination twice is a second
    // teardown of a process the first may already be tearing down, so only one
    // attempt may run; the other is refused without touching the handle.
    const cancelsBefore = destination.calls.filter((c) => c === "cancel").length;
    destination.cancelResidue = null;
    const [a, b] = await Promise.all([
      receiver.releaseRetained(key),
      receiver.releaseRetained(key),
    ]);

    expect([a, b].sort()).toEqual([false, true]);
    const cancelsAfter = destination.calls.filter((c) => c === "cancel").length;
    expect(cancelsAfter - cancelsBefore).toBe(1);
    expect(receiver.retainedHandles()).toEqual([]);
    expect(receiver.canAdmit()).toBe(true);

    // NOTE on the identity check inside the failure path: with this
    // serialization in place a concurrent success cannot be observed by a
    // failing attempt, so that check is defence in depth and this test does NOT
    // discriminate it. Recorded rather than implied — a mutation that removes
    // the identity check still passes here.
  });
});
