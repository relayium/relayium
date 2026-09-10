// The receive orchestration, with real crypto and an adversarial destination.
//
// ## What is real here and what is faked
//
// REAL: the crypto. Ciphertext is produced by `web/src/lib/store-crypto.ts` —
// the encoder the Web client and the CLI use — and opened by the BUILT
// `dist/main/stored-runtime.js`. So "a tampered frame publishes nothing" is a
// statement about the shipped AEAD, not about a stub that returns false.
//
// FAKED: the network and the destination, because both are where the
// interesting failures live. The source can 404 between the metadata read and
// the blob read, stall mid-frame, or deliver one byte at a time; the
// destination can refuse a write, publish a prefix, or fail its own teardown.
//
// ## The one thing every test here is really checking
//
// That `publish()` — the only operation whose success means "saved" — is
// reached ONLY after the stream validated completely, and that every other exit
// tore the lease down instead. The op log is asserted as a sequence for that
// reason: "cancel, and never publish" is the property, and a test that only
// checked the returned status would pass while the files were being published
// anyway.
import { beforeAll, describe, expect, it } from "vitest";

import {
  NativeHelperError,
  type NativeManifestEntry,
  type NativePublishReport,
  type NativeReceiveDestination,
} from "../../src/main/io/native-helper-client.js";
import { CleanupOwnershipError, CleanupRegistry } from "../../src/main/stored/cleanup.js";
import type { DestinationAuthority, DestinationGrant } from "../../src/main/stored/receive.js";
import { receiveStoredLink } from "../../src/main/stored/receive.js";
import type { StoredRuntime } from "../../src/main/stored/runtime-contract.js";
import { resetStoredRuntimeForTest, storedRuntime } from "../../src/main/stored/runtime.js";
import type {
  StoredBlobBody,
  StoredObjectMeta,
  StoredObjectSource,
} from "../../src/main/stored/transport.js";
import { StoredTransportError } from "../../src/main/stored/transport.js";
import {
  encodeKey,
  encryptFiles,
  encryptManifest,
  generateStoreKey,
} from "../../../../web/src/lib/store-crypto";

const ARTIFACT = new URL("../../dist/main/stored-runtime.js", import.meta.url);

let runtime: StoredRuntime;

beforeAll(async () => {
  resetStoredRuntimeForTest();
  runtime = await storedRuntime(async () => {
    try {
      return (await import(ARTIFACT.href)) as { default?: unknown };
    } catch (error) {
      throw new Error(
        `dist/main/stored-runtime.js is missing or unloadable (${(error as Error).message}). ` +
          "Build it from apps/windows: node_modules/.bin/vite build --config vite.stored.config.ts",
      );
    }
  });
});

const ID = "abc123";
const GRANT: DestinationGrant = { rootPath: "C:\\Users\\someone\\Downloads", authorityId: "auth-1" };

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface SealedObject {
  readonly link: string;
  readonly meta: StoredObjectMeta;
  readonly stream: Uint8Array;
}

/**
 * Seal one object with the SHARED encoder.
 *
 * `declared` exists so a manifest can be made to disagree with the ciphertext —
 * the only way to test "more plaintext than the manifest describes" without
 * hand-rolling a frame, which would be testing a hand-rolled frame.
 */
async function seal(
  files: readonly { name: string; data: Uint8Array }[],
  options: { readonly declared?: readonly number[]; readonly burn?: boolean } = {},
): Promise<SealedObject> {
  const key = await generateStoreKey();
  const manifest = {
    files: files.map((file, index) => ({
      name: file.name,
      size: options.declared?.[index] ?? file.data.byteLength,
    })),
  };
  const sealedManifest = await encryptManifest(key.key, manifest);
  const frames: Uint8Array[] = [];
  for await (const frame of encryptFiles(
    files.map((file) => new File([file.data as BlobPart], file.name)),
    key.key,
  )) {
    frames.push(frame);
  }
  return {
    link: `relayium://d/${ID}#k=${encodeKey(key.raw)}`,
    meta: {
      encManifest: Buffer.from(sealedManifest).toString("base64"),
      size: frames.reduce((n, frame) => n + frame.byteLength, 0),
      burnAfterRead: options.burn ?? false,
      expiresAt: 1_800_000_000,
    },
    stream: concat(frames),
  };
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface SourceOptions {
  /** Bytes per delivery. Default: the whole stream in one. */
  readonly chunk?: number;
  /** Fail the blob request itself. */
  readonly blobError?: StoredTransportError;
  /** Fail the metadata request. */
  readonly metaError?: StoredTransportError;
  /** Fail after this many deliveries. */
  readonly failAfter?: { readonly deliveries: number; readonly error: StoredTransportError };
  /** Block forever on the read after this many deliveries. */
  readonly blockAfter?: number;
  /** Observe the moment the body is released. */
  readonly onClose?: () => void;
}

class FakeSource implements StoredObjectSource {
  readonly calls: string[] = [];
  readonly maxBytesSeen: number[] = [];
  closed = 0;
  blockedRead: Promise<never> | null = null;

  constructor(
    private readonly object: SealedObject,
    private readonly options: SourceOptions = {},
  ) {}

  async meta(id: string): Promise<StoredObjectMeta> {
    this.calls.push(`meta:${id}`);
    if (this.options.metaError) throw this.options.metaError;
    return this.object.meta;
  }

  async blob(id: string, maxBytes: number): Promise<StoredBlobBody> {
    this.calls.push(`blob:${id}`);
    this.maxBytesSeen.push(maxBytes);
    if (this.options.blobError) throw this.options.blobError;
    const size = this.options.chunk ?? this.object.stream.byteLength;
    let at = 0;
    let deliveries = 0;
    return {
      read: async (): Promise<Uint8Array | null> => {
        if (this.options.failAfter && deliveries >= this.options.failAfter.deliveries) {
          throw this.options.failAfter.error;
        }
        if (this.options.blockAfter !== undefined && deliveries >= this.options.blockAfter) {
          // A read that never settles: what a cancelled transfer is actually
          // waiting on when the user changes their mind mid-download.
          this.blockedRead = new Promise<never>(() => undefined);
          return this.blockedRead;
        }
        if (at >= this.object.stream.byteLength) return null;
        const next = this.object.stream.subarray(at, at + Math.max(1, size));
        at += next.byteLength;
        deliveries += 1;
        return next;
      },
      close: async (): Promise<void> => {
        this.closed += 1;
        this.options.onClose?.();
      },
    };
  }
}

interface DestinationOptions {
  readonly publish?: NativePublishReport;
  readonly publishThrows?: NativeHelperError;
  readonly cancelThrows?: NativeHelperError;
  readonly authorityId?: string;
  readonly failWriteAt?: number;
}

class FakeDestination implements NativeReceiveDestination {
  readonly ops: string[] = [];
  cancels = 0;

  constructor(
    private readonly manifest: readonly NativeManifestEntry[],
    private readonly options: DestinationOptions = {},
  ) {}

  get fileCount(): number {
    return this.manifest.length;
  }

  assertAuthority(authorityId: string): void {
    this.ops.push(`assert:${authorityId}`);
    if (authorityId !== (this.options.authorityId ?? GRANT.authorityId)) {
      throw new NativeHelperError("authority-changed");
    }
  }

  async begin(index: number): Promise<void> {
    this.ops.push(`begin:${String(index)}`);
  }

  async write(index: number, chunk: Uint8Array): Promise<void> {
    this.ops.push(`write:${String(index)}:${String(chunk.byteLength)}`);
    if (this.options.failWriteAt !== undefined && this.ops.length >= this.options.failWriteAt) {
      throw new NativeHelperError("io-failed");
    }
  }

  async finish(index: number): Promise<void> {
    this.ops.push(`finish:${String(index)}`);
  }

  async publish(): Promise<NativePublishReport> {
    this.ops.push("publish");
    if (this.options.publishThrows) throw this.options.publishThrows;
    return (
      this.options.publish ?? {
        status: "complete",
        publishedCount: this.manifest.length,
        total: this.manifest.length,
      }
    );
  }

  async cancel(): Promise<void> {
    this.ops.push("cancel");
    this.cancels += 1;
    if (this.options.cancelThrows) throw this.options.cancelThrows;
  }
}

class FakeAuthority implements DestinationAuthority {
  asked = 0;
  seen: { fileCount: number; totalBytes: number } | null = null;

  // NOT named `grant`: a parameter property by that name silently overwrites
  // the method below, and the call site then throws rather than answering.
  // Vitest does not typecheck, so this cost a debugging pass.
  constructor(private readonly result: DestinationGrant | null = GRANT) {}

  async grant(object: { fileCount: number; totalBytes: number }): Promise<DestinationGrant | null> {
    this.asked += 1;
    this.seen = { fileCount: object.fileCount, totalBytes: object.totalBytes };
    return this.result;
  }
}

/** One receive, with everything injected. */
async function receive(
  object: SealedObject,
  parts: {
    readonly source?: FakeSource;
    readonly destination?: FakeDestination;
    readonly authority?: FakeAuthority;
    readonly cleanups?: CleanupRegistry;
    readonly signal?: AbortSignal;
    readonly onProgress?: (received: number, total: number) => void;
    readonly link?: string;
  } = {},
): Promise<{
  report: Awaited<ReturnType<typeof receiveStoredLink>>;
  destination: FakeDestination | null;
  source: FakeSource;
  authority: FakeAuthority;
}> {
  const source = parts.source ?? new FakeSource(object);
  const authority = parts.authority ?? new FakeAuthority();
  let destination: FakeDestination | null = null;
  const report = await receiveStoredLink({
    link: parts.link ?? object.link,
    authority,
    transport: source,
    runtime: async () => runtime,
    cleanups: parts.cleanups ?? new CleanupRegistry(),
    ...(parts.signal ? { signal: parts.signal } : {}),
    ...(parts.onProgress ? { onProgress: parts.onProgress } : {}),
    destination: async (request) => {
      destination = parts.destination ?? new FakeDestination(request.manifest);
      return destination;
    },
  });
  return { report, destination, source, authority };
}

// ---------------------------------------------------------------------------

describe("a complete receive", () => {
  it("writes every file by index and publishes last", async () => {
    const object = await seal([
      { name: "hello.txt", data: bytes("hello world") },
      { name: "sub/xyz.bin", data: bytes("xyz") },
    ]);
    const { report, destination, source } = await receive(object);
    expect(report.status).toBe("saved");
    if (report.status !== "saved") return;
    expect(report.publishedCount).toBe(2);
    expect(report.residue).toBe(false);
    expect(destination?.ops).toEqual([
      "assert:auth-1",
      "begin:0",
      "write:0:11",
      "finish:0",
      "begin:1",
      "write:1:3",
      "finish:1",
      "assert:auth-1",
      "publish",
    ]);
    // The whole server surface a share touches: two GETs. No `complete`, no
    // DELETE, no upload — and nothing that would need an account.
    expect(source.calls).toEqual([`meta:${ID}`, `blob:${ID}`]);
  });

  it("retains the object's expiry and burn state for a truthful later UI", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("a") }], { burn: true });
    const { report } = await receive(object);
    expect(report.status).toBe("saved");
    if (report.status !== "saved") return;
    expect(report.facts).toEqual({
      fileCount: 1,
      totalBytes: 1,
      burnAfterRead: true,
      expiresAt: 1_800_000_000,
    });
  });

  it("bounds the body by the ciphertext length the manifest implies", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const { source } = await receive(object);
    // 11 plaintext + one frame's 20 bytes of overhead.
    expect(source.maxBytesSeen).toEqual([31]);
  });

  it("reassembles frames split across arbitrary deliveries", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const { report, destination } = await receive(object, {
      source: new FakeSource(object, { chunk: 1 }),
    });
    expect(report.status).toBe("saved");
    // One frame, so one plaintext delivery however finely the bytes arrive.
    expect(destination?.ops).toContain("write:0:11");
  });

  it("reports progress up to the manifest total", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("hello world") },
      { name: "b.txt", data: bytes("xyz") },
    ]);
    const seen: number[] = [];
    const { report } = await receive(object, {
      onProgress: (received) => seen.push(received),
    });
    expect(report.status).toBe("saved");
    expect(seen[seen.length - 1]).toBe(14);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe("zero-byte entries", () => {
  // The failure this whole section exists for: the delivery loop only runs
  // WHILE it holds bytes, so an entry the ciphertext carries no frame for is
  // never opened by it. Without the tail pass the transfer publishes a folder
  // missing files and reports success.
  it("creates and finishes trailing empty files", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("abc") },
      { name: "empty1.txt", data: new Uint8Array(0) },
      { name: "empty2.txt", data: new Uint8Array(0) },
    ]);
    const { report, destination } = await receive(object);
    expect(report.status).toBe("saved");
    expect(destination?.ops).toEqual([
      "assert:auth-1",
      "begin:0",
      "write:0:3",
      "finish:0",
      "begin:1",
      "finish:1",
      "begin:2",
      "finish:2",
      "assert:auth-1",
      "publish",
    ]);
  });

  it("creates and finishes a manifest that is ENTIRELY empty files", async () => {
    // The ciphertext is zero bytes long, so the stream never calls back at all.
    const object = await seal([
      { name: "a.txt", data: new Uint8Array(0) },
      { name: "b.txt", data: new Uint8Array(0) },
    ]);
    expect(object.stream.byteLength).toBe(0);
    const { report, destination } = await receive(object);
    expect(report.status).toBe("saved");
    if (report.status !== "saved") return;
    expect(report.publishedCount).toBe(2);
    expect(destination?.ops).toEqual([
      "assert:auth-1",
      "begin:0",
      "finish:0",
      "begin:1",
      "finish:1",
      "assert:auth-1",
      "publish",
    ]);
  });

  it("creates an empty file BETWEEN two non-empty ones", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("abc") },
      { name: "gap.txt", data: new Uint8Array(0) },
      { name: "c.txt", data: bytes("de") },
    ]);
    const { report, destination } = await receive(object);
    expect(report.status).toBe("saved");
    expect(destination?.ops).toEqual([
      "assert:auth-1",
      "begin:0",
      "write:0:3",
      "finish:0",
      "begin:1",
      "finish:1",
      "begin:2",
      "write:2:2",
      "finish:2",
      "assert:auth-1",
      "publish",
    ]);
  });
});

describe("nothing is published on a broken stream", () => {
  const tamper = (stream: Uint8Array, at: number): Uint8Array => {
    const out = stream.slice();
    out[at] = (out[at] ?? 0) ^ 0x01;
    return out;
  };

  it("refuses a tampered ciphertext frame and cancels the lease", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const broken: SealedObject = { ...object, stream: tamper(object.stream, 6) };
    const { report, destination } = await receive(broken);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    // An object whose bytes did not authenticate will not authenticate next
    // time either.
    expect(report.failure.retryable).toBe(false);
    expect(destination?.ops).toContain("cancel");
    expect(destination?.ops).not.toContain("publish");
  });

  it("refuses a stream truncated on a FRAME BOUNDARY", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("hello world") },
      { name: "b.txt", data: bytes("xyz") },
    ]);
    // Drop the second frame entirely: no dangling bytes, so only the expected
    // plaintext total can tell this from a clean end.
    const cut: SealedObject = { ...object, stream: object.stream.subarray(0, 4 + 11 + 16) };
    const { report, destination } = await receive(cut);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    // The first file's bytes were staged, and staging is not saving.
    expect(destination?.ops).toContain("finish:0");
    expect(destination?.ops).not.toContain("publish");
    expect(destination?.ops).toContain("cancel");
  });

  it("refuses a stream truncated MID-FRAME", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const cut: SealedObject = { ...object, stream: object.stream.subarray(0, object.stream.byteLength - 1) };
    const { report, destination } = await receive(cut);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    expect(destination?.ops).not.toContain("publish");
  });

  it("refuses plaintext the manifest does not account for", async () => {
    // Authentic frames, an authentic manifest, and they disagree: the manifest
    // declares 3 bytes for a file the stream carries 11 for. The extra bytes
    // have nowhere legitimate to go.
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }], { declared: [3] });
    const { report, destination } = await receive(object);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    expect(destination?.ops).not.toContain("publish");
    expect(destination?.ops).toContain("cancel");
  });

  it("refuses a manifest that declares MORE than the stream carries", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("abc") }], { declared: [9] });
    const { report, destination } = await receive(object);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    expect(destination?.ops).not.toContain("publish");
  });
});

describe("manifests this build refuses", () => {
  it("refuses a traversal name before opening a picker or a lease", async () => {
    const object = await seal([{ name: "..\\evil.txt", data: bytes("x") }]);
    const { report, destination, authority } = await receive(object);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("manifest-refused");
    expect(report.failure.refusal).toEqual({ kind: "path", reason: "backslash-in-segment" });
    // Neither the user nor the helper was troubled with it.
    expect(authority.asked).toBe(0);
    expect(destination).toBeNull();
  });

  it("refuses a case-colliding folder before opening a lease", async () => {
    const object = await seal([
      { name: "dir/A.txt", data: bytes("a") },
      { name: "dir/a.txt", data: bytes("b") },
    ]);
    const { report, destination, authority } = await receive(object);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.refusal).toEqual({ kind: "duplicate" });
    expect(authority.asked).toBe(0);
    expect(destination).toBeNull();
  });

  it("refuses a name that is both a file and a parent", async () => {
    const object = await seal([
      { name: "thing", data: bytes("a") },
      { name: "thing/child.txt", data: bytes("b") },
    ]);
    const { report } = await receive(object);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.refusal).toEqual({ kind: "file-vs-parent" });
  });

  it("never puts a filename in the refusal", async () => {
    const object = await seal([{ name: "NUL.txt", data: bytes("x") }]);
    const { report } = await receive(object);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(JSON.stringify(report.failure)).not.toContain("NUL");
  });
});

describe("the picker", () => {
  it("is shown the manifest's shape", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("abc") },
      { name: "b.txt", data: bytes("de") },
    ]);
    const { authority } = await receive(object);
    expect(authority.seen).toEqual({ fileCount: 2, totalBytes: 5 });
  });

  it("declining opens no lease and reports no failure", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("a") }]);
    const { report, destination } = await receive(object, { authority: new FakeAuthority(null) });
    expect(report.status).toBe("declined");
    expect(destination).toBeNull();
  });
});

describe("server outcomes", () => {
  it("reports a 404 mid-transfer as a dead link, with nothing saved", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const { report, destination, source } = await receive(object, {
      source: new FakeSource(object, { blobError: new StoredTransportError("http", 404) }),
    });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("not-found");
    expect(report.failure.status).toBe(404);
    // The link is gone; a retry cannot bring it back.
    expect(report.failure.retryable).toBe(false);
    expect(destination?.ops).toContain("cancel");
    expect(destination?.ops).not.toContain("publish");
    expect(source.calls).toEqual([`meta:${ID}`, `blob:${ID}`]);
  });

  it("marks a network fault mid-body as retryable, and still publishes nothing", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("hello world") },
      { name: "b.txt", data: bytes("xyz") },
    ]);
    const { report, destination } = await receive(object, {
      source: new FakeSource(object, {
        chunk: 4,
        failAfter: { deliveries: 2, error: new StoredTransportError("network") },
      }),
    });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("network");
    // Retryable means "start the whole receive again" — never "resume this
    // body". The lease is gone and no partial file was published.
    expect(report.failure.retryable).toBe(true);
    expect(destination?.ops).not.toContain("publish");
    expect(destination?.ops).toContain("cancel");
  });

  it("refuses a redirect rather than following it", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("a") }]);
    const { report } = await receive(object, {
      source: new FakeSource(object, { blobError: new StoredTransportError("redirect") }),
    });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("redirect-refused");
    expect(report.failure.retryable).toBe(false);
  });

  it("reports a metadata failure before any lease exists", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("a") }]);
    const { report, destination, authority } = await receive(object, {
      source: new FakeSource(object, { metaError: new StoredTransportError("http", 429) }),
    });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("rate-limited");
    expect(report.failure.retryable).toBe(true);
    expect(authority.asked).toBe(0);
    expect(destination).toBeNull();
  });
});

describe("cancellation", () => {
  it("reaches a blocked body read, then joins the destination teardown", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("hello world") },
      { name: "b.txt", data: bytes("xyz") },
    ]);
    const controller = new AbortController();
    const source = new FakeSource(object, { chunk: 4, blockAfter: 2 });
    const destination = new FakeDestination([
      { name: "a.txt", size: 11 },
      { name: "b.txt", size: 3 },
    ]);
    const running = receive(object, { source, destination, signal: controller.signal });
    // Let the run get as far as the read that never settles.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source.blockedRead).not.toBeNull();
    controller.abort();
    const { report } = await running;
    expect(report.status).toBe("cancelled");
    if (report.status !== "cancelled") return;
    expect(report.residue).toBe(false);
    // The body was closed and the lease was torn down — in that order, and both
    // awaited, so nothing is left streaming into a transfer that is over.
    expect(source.closed).toBeGreaterThan(0);
    expect(destination.cancels).toBe(1);
    expect(destination.ops).not.toContain("publish");
  });

  it("releases the connection before it tears the lease down", async () => {
    // Order matters: the body is the live connection and the helper teardown
    // has its own deadline to settle in. Leaving the stream open across it
    // means bytes still arriving for a transfer that is over.
    const object = await seal([
      { name: "a.txt", data: bytes("hello world") },
      { name: "b.txt", data: bytes("xyz") },
    ]);
    const order: string[] = [];
    const controller = new AbortController();
    const source = new FakeSource(object, {
      chunk: 4,
      blockAfter: 2,
      onClose: () => order.push("body-close"),
    });
    const destination = new FakeDestination([
      { name: "a.txt", size: 11 },
      { name: "b.txt", size: 3 },
    ]);
    const wrapped = destination.cancel.bind(destination);
    destination.cancel = async (): Promise<void> => {
      order.push("destination-cancel");
      await wrapped();
    };
    const running = receive(object, { source, destination, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await running;
    expect(order).toEqual(["body-close", "destination-cancel"]);
  });

  it("reports a destination fault that lands after the cancellation as the cancellation", async () => {
    // The user changed their mind; the helper request that was in flight
    // rejects with its own code. Reporting that code would put a failure in
    // front of someone who simply stopped.
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const controller = new AbortController();
    const destination = new FakeDestination([{ name: "a.txt", size: 11 }]);
    destination.finish = async (): Promise<void> => {
      controller.abort();
      throw new NativeHelperError("io-failed");
    };
    const { report } = await receive(object, { destination, signal: controller.signal });
    expect(report.status).toBe("cancelled");
    if (report.status !== "cancelled") return;
    expect(report.residue).toBe(false);
    expect(destination.ops).not.toContain("publish");
  });

  it("does not open a lease when the signal fires while the picker is open", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("a") }]);
    const controller = new AbortController();
    class SlowAuthority extends FakeAuthority {
      override async grant(object_: { fileCount: number; totalBytes: number }): Promise<DestinationGrant | null> {
        controller.abort();
        return super.grant(object_);
      }
    }
    const { report, destination } = await receive(object, {
      authority: new SlowAuthority(),
      signal: controller.signal,
    });
    expect(report.status).toBe("cancelled");
    expect(destination).toBeNull();
  });
});

describe("teardown that does not settle", () => {
  it("retains the destination under a ticket so cleanup can be retried", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const cleanups = new CleanupRegistry();
    let attempts = 0;
    const destination = new FakeDestination([{ name: "a.txt", size: 11 }]);
    // A first teardown that reports residue, and a second that succeeds: the
    // exact shape the helper client documents as retryable.
    const original = destination.cancel.bind(destination);
    destination.cancel = async (): Promise<void> => {
      attempts += 1;
      await original();
      if (attempts === 1) throw new NativeHelperError("cleanup-uncertain", true, undefined, null, "wedged");
    };
    const broken: SealedObject = {
      ...object,
      stream: object.stream.subarray(0, object.stream.byteLength - 1),
    };
    const { report } = await receive(broken, { destination, cleanups });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.residue).toBe(true);
    expect(report.failure.cleanupTicket).not.toBeNull();
    expect(cleanups.size).toBe(1);

    const ticket = report.failure.cleanupTicket ?? "";
    await expect(cleanups.retry(ticket)).resolves.toEqual({ outcome: "clean" });
    expect(attempts).toBe(2);
    expect(cleanups.size).toBe(0);
    await expect(cleanups.retry(ticket)).resolves.toEqual({ outcome: "unknown" });
  });

  it("keeps the ticket valid when the retry also fails", async () => {
    const cleanups = new CleanupRegistry();
    const destination = new FakeDestination([], {
      cancelThrows: new NativeHelperError("residue", true),
    });
    const ticket = cleanups.retain(destination) ?? "";
    await expect(cleanups.retry(ticket)).resolves.toEqual({ outcome: "uncertain", residue: true });
    expect(cleanups.tickets).toEqual([ticket]);
  });

  it("retries without a lifetime cap: ownership ends on confirmation, not on attempts", async () => {
    const cleanups = new CleanupRegistry();
    let attempts = 0;
    const destination = new FakeDestination([]);
    destination.cancel = async (): Promise<void> => {
      attempts += 1;
      if (attempts < 5) throw new NativeHelperError("cleanup-uncertain", true, undefined, null, "wedged");
    };
    const ticket = cleanups.retain(destination) ?? "";
    for (let i = 0; i < 4; i += 1) {
      await expect(cleanups.retry(ticket)).resolves.toEqual({ outcome: "uncertain", residue: true });
      // Still held, still the same ticket, still one slot.
      expect(cleanups.tickets).toEqual([ticket]);
      expect(cleanups.size).toBe(1);
    }
    await expect(cleanups.retry(ticket)).resolves.toEqual({ outcome: "clean" });
    expect(attempts).toBe(5);
    expect(cleanups.size).toBe(0);
  });

  it("refuses to START a transfer it could not promise to own", async () => {
    // The bug this replaces: capacity used to be checked in `retain()`, i.e.
    // AFTER a child existed and its teardown had already failed, and returning
    // null there meant dropping a possibly-live process. Refusing before the
    // helper is created is the only answer that keeps ownership total.
    const cleanups = new CleanupRegistry(1);
    cleanups.retain(new FakeDestination([]));
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const { report, destination, source } = await receive(object, { cleanups });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("cleanup-capacity");
    // No child was started, so there is nothing to have residue about and
    // nothing to retry.
    expect(destination).toBeNull();
    expect(report.failure.residue).toBe(false);
    expect(report.failure.cleanupTicket).toBeNull();
    expect(report.failure.published).toBe("none");
    // The metadata read already happened; the blob never started.
    expect(source.calls).toEqual([`meta:${ID}`]);
  });

  it("does not let two concurrent transfers take the same last slot", async () => {
    const cleanups = new CleanupRegistry(1);
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const opened: string[] = [];
    // Both receives run against a destination whose teardown never settles, so
    // whichever one gets the slot needs it. The other must be refused BEFORE it
    // creates a child, not after.
    const run = (label: string) =>
      receiveStoredLink({
        link: object.link,
        authority: new FakeAuthority(),
        transport: new FakeSource(object),
        runtime: async () => runtime,
        cleanups,
        destination: async (request) => {
          opened.push(label);
          const fake = new FakeDestination(request.manifest, {
            cancelThrows: new NativeHelperError("cleanup-uncertain", true),
          });
          // Fail the stream so teardown is reached and the slot is claimed.
          fake.finish = async (): Promise<void> => {
            throw new NativeHelperError("io-failed");
          };
          return fake;
        },
      });
    const [first, second] = await Promise.all([run("a"), run("b")]);
    const codes = [first, second].map((report) =>
      report.status === "failed" ? report.failure.code : report.status,
    );
    expect(codes).toContain("cleanup-capacity");
    expect(codes).toContain("destination-io");
    // Exactly one child was ever created.
    expect(opened.length).toBe(1);
    expect(cleanups.size).toBe(1);
  });
});

describe("the reservation contract", () => {
  // A published contract about to be held across host wiring, so its misuse
  // cases are pinned here rather than left to the single well-behaved caller
  // `discard` happens to be today.
  it("returns the same ticket for a repeated claim of the same destination", () => {
    const cleanups = new CleanupRegistry(1);
    const reservation = cleanups.reserve();
    expect(reservation).not.toBeNull();
    if (reservation === null) return;
    const destination = new FakeDestination([]);
    const first = reservation.claim(destination);
    const second = reservation.claim(destination);
    expect(second).toBe(first);
    // One slot, one entry — not two entries behind one slot, which is what a
    // second ticket would have produced.
    expect(cleanups.tickets).toEqual([first]);
    expect(cleanups.size).toBe(1);
  });

  it("refuses a second, different destination without mutating the registry", () => {
    const cleanups = new CleanupRegistry(1);
    const reservation = cleanups.reserve();
    if (reservation === null) return;
    const ticket = reservation.claim(new FakeDestination([]));
    expect(() => reservation.claim(new FakeDestination([]))).toThrow(CleanupOwnershipError);
    expect(cleanups.tickets).toEqual([ticket]);
    expect(cleanups.size).toBe(1);
  });

  it("refuses a claim after release, so no entry exists without a slot", () => {
    const cleanups = new CleanupRegistry(1);
    const reservation = cleanups.reserve();
    if (reservation === null) return;
    reservation.release();
    expect(cleanups.size).toBe(0);
    expect(() => reservation.claim(new FakeDestination([]))).toThrow(CleanupOwnershipError);
    expect(cleanups.size).toBe(0);
    expect(cleanups.tickets).toEqual([]);
  });

  it("treats release after a claim as a no-op, so the slot is not double-freed", () => {
    const cleanups = new CleanupRegistry(2);
    const reservation = cleanups.reserve();
    if (reservation === null) return;
    reservation.claim(new FakeDestination([]));
    reservation.release();
    reservation.release();
    expect(cleanups.size).toBe(1);
    // The bound still holds: one slot left, then none.
    expect(cleanups.reserve()).not.toBeNull();
    expect(cleanups.reserve()).toBeNull();
  });

  it("counts reservations toward the bound while they are outstanding", () => {
    const cleanups = new CleanupRegistry(2);
    const first = cleanups.reserve();
    const second = cleanups.reserve();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Nothing retained yet, and the registry is already full — which is the
    // point: capacity is committed before a child exists.
    expect(cleanups.tickets).toEqual([]);
    expect(cleanups.size).toBe(2);
    expect(cleanups.reserve()).toBeNull();
    first?.release();
    expect(cleanups.reserve()).not.toBeNull();
  });
});

describe("publication outcomes", () => {
  it("preserves a published prefix as a partial rather than a failure", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("abc") },
      { name: "b.txt", data: bytes("de") },
    ]);
    const destination = new FakeDestination(
      [
        { name: "a.txt", size: 3 },
        { name: "b.txt", size: 2 },
      ],
      {
        publish: { status: "partial", publishedCount: 1, total: 2, failedIndex: 1, reason: "E_EXISTS" },
      },
    );
    const { report } = await receive(object, { destination });
    expect(report.status).toBe("partially-saved");
    if (report.status !== "partially-saved") return;
    expect(report).toMatchObject({ publishedCount: 1, total: 2, failedIndex: 1, reason: "E_EXISTS" });
    expect(report.residue).toBe(false);
  });

  it("keeps the receipt when publication succeeded and only teardown failed", async () => {
    // The helper carries the validated report on the error precisely so this
    // cannot be reported as "nothing was saved".
    const object = await seal([{ name: "a.txt", data: bytes("abc") }]);
    const destination = new FakeDestination([{ name: "a.txt", size: 3 }], {
      publishThrows: new NativeHelperError(
        "residue",
        true,
        undefined,
        3,
        "published, but cleanup left bytes on disk",
        { status: "complete", publishedCount: 1, total: 1 },
      ),
    });
    const { report } = await receive(object, { destination });
    expect(report.status).toBe("saved");
    if (report.status !== "saved") return;
    expect(report.publishedCount).toBe(1);
    expect(report.residue).toBe(true);
  });

  it("keeps a PARTIAL receipt that arrives on a teardown failure", async () => {
    const object = await seal([
      { name: "a.txt", data: bytes("abc") },
      { name: "b.txt", data: bytes("de") },
    ]);
    const destination = new FakeDestination(
      [
        { name: "a.txt", size: 3 },
        { name: "b.txt", size: 2 },
      ],
      {
        publishThrows: new NativeHelperError("cleanup-uncertain", true, undefined, null, "wedged", {
          status: "partial",
          publishedCount: 1,
          total: 2,
          failedIndex: 1,
          reason: "E_ACCESS",
        }),
      },
    );
    const { report } = await receive(object, { destination });
    expect(report.status).toBe("partially-saved");
    if (report.status !== "partially-saved") return;
    expect(report.publishedCount).toBe(1);
    expect(report.residue).toBe(true);
  });

  it("retains the helper when publication succeeded but it would not close", async () => {
    // `settleAfterPublish` throws `cleanup-uncertain` with the receipt when the
    // child did not close after a kill — the process is STILL THERE. Root's
    // probe asserted `registry 0` here and it was red.
    const object = await seal([{ name: "a.txt", data: bytes("abc") }]);
    const cleanups = new CleanupRegistry();
    let cancels = 0;
    const destination = new FakeDestination([{ name: "a.txt", size: 3 }], {
      publishThrows: new NativeHelperError(
        "cleanup-uncertain",
        true,
        undefined,
        null,
        "helper did not close after publication",
        { status: "complete", publishedCount: 1, total: 1 },
      ),
    });
    destination.cancel = async (): Promise<void> => {
      cancels += 1;
      throw new NativeHelperError("cleanup-uncertain", true, undefined, null, "still wedged");
    };
    const { report } = await receive(object, { destination, cleanups });
    // The published prefix survives, and is NOT replaced by a failure.
    expect(report.status).toBe("saved");
    if (report.status !== "saved") return;
    expect(report.publishedCount).toBe(1);
    expect(report.residue).toBe(true);
    // Owned teardown was attempted, and the handle kept when it did not settle.
    expect(cancels).toBe(1);
    expect(report.cleanupTicket).not.toBeNull();
    expect(cleanups.size).toBe(1);
    expect(cleanups.tickets).toEqual([report.cleanupTicket]);
    // And the retained handle is the retryable one.
    await expect(cleanups.retry(report.cleanupTicket ?? "")).resolves.toEqual({
      outcome: "uncertain",
      residue: true,
    });
    expect(cancels).toBe(2);
  });

  it("retains the helper when publication threw with NO receipt", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("abc") }]);
    const cleanups = new CleanupRegistry();
    const destination = new FakeDestination([{ name: "a.txt", size: 3 }], {
      publishThrows: new NativeHelperError("cleanup-uncertain", true, undefined, null, "no answer"),
      cancelThrows: new NativeHelperError("cleanup-uncertain", true),
    });
    const { report } = await receive(object, { destination, cleanups });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("cleanup-uncertain");
    expect(report.failure.residue).toBe(true);
    expect(report.failure.cleanupTicket).not.toBeNull();
    expect(cleanups.size).toBe(1);
    // The publish request stopped being answered, so whether the rename
    // happened is NOT known — and must not be reported as "nothing was saved".
    expect(report.failure.published).toBe("unknown");
  });

  it("calls an unverifiable partial claim unknown, not nothing-saved", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("abc") }]);
    const destination = new FakeDestination([{ name: "a.txt", size: 3 }], {
      // The helper says a prefix landed; the client could not corroborate the
      // claim, so it refused the receipt. That is not proof of no publication.
      publishThrows: new NativeHelperError("publish-failed", false, "E_PARTIAL_PUBLICATION"),
    });
    const { report } = await receive(object, { destination });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("publish-failed");
    expect(report.failure.published).toBe("unknown");
  });

  it("releases the reserved slot when a transfer owes no cleanup", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("abc") }]);
    const cleanups = new CleanupRegistry();
    const { report } = await receive(object, { cleanups });
    expect(report.status).toBe("saved");
    if (report.status !== "saved") return;
    expect(report.cleanupTicket).toBeNull();
    expect(cleanups.size).toBe(0);
  });

  it("reports a refused publication as a failure with nothing saved", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("abc") }]);
    const destination = new FakeDestination([{ name: "a.txt", size: 3 }], {
      publishThrows: new NativeHelperError("publish-failed", false, "E_ACCESS"),
    });
    const { report } = await receive(object, { destination });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("publish-failed");
    expect(report.failure.retryable).toBe(false);
    // A well-formed refusal for the whole batch IS proof.
    expect(report.failure.published).toBe("none");
  });
});

describe("the destination stays the transfer's own", () => {
  it("refuses to write into a lease that belongs to another authority", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("abc") }]);
    const destination = new FakeDestination([{ name: "a.txt", size: 3 }], {
      authorityId: "someone-else",
    });
    const { report } = await receive(object, { destination });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("authority-changed");
    expect(destination.ops).not.toContain("publish");
    expect(destination.ops).toContain("cancel");
  });

  it("reports a destination write failure without claiming a save", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("hello world") }]);
    const destination = new FakeDestination([{ name: "a.txt", size: 11 }], { failWriteAt: 1 });
    const { report } = await receive(object, { destination });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("destination-io");
    expect(report.failure.retryable).toBe(false);
    expect(destination.ops).not.toContain("publish");
  });
});

describe("links this build will not act on", () => {
  it("refuses before a single request", async () => {
    const object = await seal([{ name: "a.txt", data: bytes("a") }]);
    const source = new FakeSource(object);
    const authority = new FakeAuthority();
    for (const link of [
      "https://evil.example/d/abc123#k=VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU",
      "relayium://d/abc123",
      "relayium://cross-network#c=004291",
      "relayium://d/abc%20123#k=VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU",
      "not-a-url",
    ]) {
      const { report } = await receive(object, { source, authority, link });
      expect(report.status, link).toBe("failed");
      if (report.status !== "failed") continue;
      expect(report.failure.code, link).toBe("link-invalid");
    }
    expect(source.calls).toEqual([]);
    expect(authority.asked).toBe(0);
  });
});
