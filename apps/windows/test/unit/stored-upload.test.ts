// The send path: real ciphertext, the real route semantics, and the failures.
//
// ## What is real here
//
// The ciphertext is produced by `web/src/lib/store-crypto.ts`'s `encryptFiles`
// — the encoder the Web client and the CLI use — fed through the real
// `UploadTransport`, `UploadEngine` and `StoredUploadService`, against a fake
// server that implements what `server/account/uploads_resumable.go` actually
// does: partial commits, a 409 with the committed offset, a terminal 409 on a
// repeated finalize, and a 404 status once a session is done. The assembled
// blob is then DECRYPTED by the built runtime and checked against the original
// plaintext, so "the upload works" means a receiver can open it.
//
// `SecretStore` is real too, with a passthrough cipher, so the custody
// ordering (key on disk BEFORE init) is observable rather than asserted about a
// mock.
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { SecretStore, type SecretCipher } from "../../src/main/secrets.js";
import type { StoredRuntime } from "../../src/main/stored/runtime-contract.js";
import { resetStoredRuntimeForTest, storedRuntime } from "../../src/main/stored/runtime.js";
import type { StoredObjectMeta, StoredObjectSource } from "../../src/main/stored/transport.js";
import { captureAuthority, Fence } from "../../src/main/stored/upload/authority.js";
import { UploadEngine } from "../../src/main/stored/upload/engine.js";
import { UploadJournal } from "../../src/main/stored/upload/journal.js";
import { frameGeometry, frameLengthAt, planUpload } from "../../src/main/stored/upload/plan.js";
import { manifestDigest } from "../../src/main/stored/upload/reconcile.js";
import { MAX_ACTIVE_JOBS, StoredUploadService } from "../../src/main/stored/upload/service.js";
import {
  MAX_ACCEPTED_CHUNK_BYTES,
  UploadTransport,
  UploadTransportError as StoredUploadTransportError,
  type UploadByteTransport,
} from "../../src/main/stored/upload/transport.js";
import { encryptFiles } from "../../../../web/src/lib/store-crypto";

const ARTIFACT = new URL("../../dist/main/stored-runtime.js", import.meta.url);
const ORIGIN = "https://relayium.com";
const ACCOUNT = "acct-1";
const OTHER_ACCOUNT = "acct-2";

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

const owned: string[] = [];
afterEach(async () => {
  for (const dir of owned.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relayium-upload-"));
  owned.push(dir);
  return dir;
}

/** A passthrough cipher: this suite is about custody ORDERING, not about DPAPI.
 *  `SecretStore`'s own bounds and atomic write are exercised as they ship. */
const passthrough: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(`sealed:${plaintext}`, "utf8"),
  decrypt: (ciphertext) => {
    const text = ciphertext.toString("utf8");
    if (!text.startsWith("sealed:")) throw new Error("not ours");
    return text.slice("sealed:".length);
  },
};

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

// ---------------------------------------------------------------------------
// A server that behaves like the real one
// ---------------------------------------------------------------------------

interface Session {
  readonly id: string;
  readonly manifest: Uint8Array;
  readonly chunks: Uint8Array[];
  received: number;
  done: boolean;
}

interface StoredObject {
  readonly id: string;
  readonly encManifest: string;
  readonly size: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly blob: Uint8Array;
}

interface ServerOptions {
  /** Commit at most this many bytes per PATCH, forcing partial commits. */
  readonly commitLimit?: number;
  /** Answer init with this chunkSize instead of 8 MiB. */
  readonly chunkSize?: number;
  /** Answer init with this uploadId instead of a generated one. */
  readonly uploadId?: string;
  /** Fail the Nth PATCH (1-based) with this status before committing. */
  readonly failAppend?: { readonly nth: number; readonly status: number };
  /** Reject the Nth PATCH at the transport level (a lost connection). */
  readonly dropAppend?: { readonly nth: number };
  /** Answer every PATCH 409 with this fixed offset. */
  readonly stickyOffset?: number;
  /** Report an offset BEHIND what the client sent. */
  readonly regressAfter?: number;
  /** Report an offset ahead of everything produced. */
  readonly aheadBy?: number;
  /** Finalize: create the object but drop the response. */
  readonly loseFinalize?: boolean;
  /** Finalize: answer 409 on the FIRST attempt (someone else claimed it). */
  readonly finalizeTaken?: boolean;
  /** Called at init, so a test can assert what is already on disk. */
  readonly onInit?: () => Promise<void> | void;
}

class FakeServer {
  readonly requests: string[] = [];
  readonly sessions = new Map<string, Session>();
  readonly objects = new Map<string, StoredObject>();
  private appendCount = 0;
  private finalizeCount = 0;
  private ids = 0;
  now = 1_800_000_000;

  constructor(private readonly options: ServerOptions = {}) {}

  private id(prefix: string): string {
    this.ids += 1;
    return `${prefix}${String(this.ids).padStart(4, "0")}`;
  }

  get blobFor(): (id: string) => Uint8Array | undefined {
    return (id) => this.objects.get(id)?.blob;
  }

  readonly fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(String(url));
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${target.pathname}`);
    // Every authenticated request must carry the bearer and nothing else.
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (target.pathname.startsWith("/api/uploads") || target.pathname === "/api/files") {
      if (headers["authorization"] !== "Bearer token-1") return json(401, { error: "no" });
    }
    if (method === "POST" && target.pathname === "/api/uploads") return this.init(target, init);
    if (method === "PATCH" && target.pathname.startsWith("/api/uploads/")) {
      return this.append(target, init);
    }
    if (method === "POST" && target.pathname.endsWith("/finalize")) return this.finalize(target);
    if (method === "GET" && target.pathname.startsWith("/api/uploads/")) return this.status(target);
    if (method === "GET" && target.pathname === "/api/files") return this.list();
    if (method === "DELETE" && target.pathname.startsWith("/api/files/")) return this.remove(target);
    if (method === "GET" && target.pathname.endsWith("/meta")) return this.meta(target);
    return json(404, { error: "no route" });
  }) as unknown as typeof fetch;

  private async init(target: URL, init?: RequestInit): Promise<Response> {
    await this.options.onInit?.();
    const body = new Uint8Array(init?.body as Uint8Array);
    const declared = new DataView(body.buffer, body.byteOffset).getUint32(0, false);
    if (4 + declared !== body.byteLength) return json(400, { error: "bad manifest frame" });
    if (declared > 64 * 1024) return json(400, { error: "manifest too large" });
    const id = this.options.uploadId ?? this.id("up");
    this.sessions.set(id, {
      id,
      manifest: body.subarray(4),
      chunks: [],
      received: 0,
      done: false,
    });
    void target;
    return json(200, { uploadId: id, chunkSize: this.options.chunkSize ?? 8 * 1024 * 1024 });
  }

  private async append(target: URL, init?: RequestInit): Promise<Response> {
    this.appendCount += 1;
    const id = target.pathname.split("/")[3] ?? "";
    const session = this.sessions.get(id);
    if (!session || session.done) return json(404, { error: "not found" });
    if (this.options.dropAppend?.nth === this.appendCount) {
      const error = new TypeError("fetch failed");
      throw error;
    }
    if (this.options.failAppend?.nth === this.appendCount) {
      return json(this.options.failAppend.status, { error: "later" });
    }
    if (this.options.stickyOffset !== undefined) {
      return json(409, { received: this.options.stickyOffset });
    }
    const range = (init?.headers as Record<string, string>)["content-range"] ?? "";
    const start = Number(/^bytes (\d+)-/.exec(range)?.[1] ?? "-1");
    if (start < session.received) return json(200, { received: session.received });
    if (start > session.received) return json(409, { received: session.received });
    const chunk = new Uint8Array(init?.body as Uint8Array);
    const take =
      this.options.commitLimit === undefined
        ? chunk.byteLength
        : Math.min(chunk.byteLength, this.options.commitLimit);
    session.chunks.push(chunk.subarray(0, take));
    session.received += take;
    if (this.options.regressAfter !== undefined && session.received > this.options.regressAfter) {
      return json(200, { received: this.options.regressAfter });
    }
    if (this.options.aheadBy !== undefined) {
      return json(200, { received: session.received + this.options.aheadBy });
    }
    return json(200, { received: session.received });
  }

  private status(target: URL): Response {
    const id = target.pathname.split("/")[3] ?? "";
    const session = this.sessions.get(id);
    // 404 once terminal, exactly as the real handler does: a done session has
    // nowhere to resume to.
    if (!session || session.done) return json(404, { error: "not found" });
    return json(200, { received: session.received });
  }

  private finalize(target: URL): Response {
    this.finalizeCount += 1;
    const id = target.pathname.split("/")[3] ?? "";
    const session = this.sessions.get(id);
    if (!session) return json(404, { error: "not found" });
    if (session.done) return json(409, { error: "already finalized" });
    if (this.options.finalizeTaken === true && this.finalizeCount === 1) {
      // Claimed by something else: the tombstone answers 409 with no id.
      session.done = true;
      return json(409, { error: "already finalized" });
    }
    session.done = true;
    const blob = concat(session.chunks);
    const objectId = this.id("obj");
    this.objects.set(objectId, {
      id: objectId,
      encManifest: Buffer.from(session.manifest).toString("base64"),
      size: blob.byteLength,
      createdAt: this.now,
      expiresAt: this.now + 86_400,
      blob,
    });
    if (this.options.loseFinalize === true) {
      // The object exists; the answer never arrives.
      const error = new TypeError("fetch failed");
      throw error;
    }
    return json(200, { id: objectId, expiresAt: this.now + 86_400 });
  }

  private list(): Response {
    return json(200, {
      files: [...this.objects.values()].map((object) => ({
        id: object.id,
        size: object.size,
        createdAt: object.createdAt,
        expiresAt: object.expiresAt,
        burnAfterRead: false,
        downloaded: false,
        downloadCount: 0,
      })),
    });
  }

  private remove(target: URL): Response {
    const id = target.pathname.split("/")[3] ?? "";
    if (!this.objects.has(id)) return new Response(null, { status: 404 });
    this.objects.delete(id);
    return new Response(null, { status: 204 });
  }

  private meta(target: URL): Response {
    const id = target.pathname.split("/")[4] ?? "";
    const object = this.objects.get(id);
    if (!object) return json(404, { error: "no" });
    return json(200, {
      encManifest: object.encManifest,
      size: object.size,
      burnAfterRead: false,
      expiresAt: object.expiresAt,
    });
  }

  /** The unauthenticated metadata reader the reconciler uses. */
  source(): StoredObjectSource {
    return {
      meta: async (id: string): Promise<StoredObjectMeta> => {
        const object = this.objects.get(id);
        if (!object) throw new Error("absent");
        return {
          encManifest: object.encManifest,
          size: object.size,
          burnAfterRead: false,
          expiresAt: object.expiresAt,
        };
      },
      blob: async () => {
        throw new Error("not used");
      },
    };
  }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Producing real ciphertext, the way the renderer will
// ---------------------------------------------------------------------------

interface Picked {
  readonly path: string;
  readonly data: Uint8Array;
}

/**
 * The frames one upload owes, from the SHARED encoder.
 *
 * The mapping from frames to file indices is derived from the plan's schedule,
 * which is exactly the coupling the engine enforces: `encryptFiles` walks the
 * same array in the same order, and a zero-byte file contributes no frame.
 */
async function produce(
  picked: readonly Picked[],
  encodedKey: string,
  geometry: { storeChunkSize: number; frameOverhead: number },
): Promise<{ fileIndex: number; seq: number; bytes: Uint8Array }[]> {
  const key = await runtime.importKeyFromFragment(encodedKey);
  const files = picked.map((entry) => new File([entry.data as BlobPart], entry.path));
  const emitted: Uint8Array[] = [];
  for await (const frame of encryptFiles(files, key)) emitted.push(frame);
  const out: { fileIndex: number; seq: number; bytes: Uint8Array }[] = [];
  let cursor = 0;
  let seq = 1;
  picked.forEach((entry, fileIndex) => {
    const file = frameGeometry(entry.data.byteLength, geometry, fileIndex);
    for (let i = 0; i < file.frameCount; i += 1) {
      const expected = frameLengthAt(file, i);
      const frame = emitted[cursor];
      if (frame === undefined || frame.byteLength !== expected) {
        throw new Error(`shared encoder emitted ${String(frame?.byteLength)}, plan expected ${String(expected)}`);
      }
      out.push({ fileIndex, seq, bytes: frame });
      cursor += 1;
      seq += 1;
    }
  });
  if (cursor !== emitted.length) throw new Error("plan and encoder disagree on frame count");
  return out;
}

async function service(
  server: FakeServer,
  options: { readonly onInit?: () => Promise<void> } = {},
): Promise<{ svc: StoredUploadService; secretsDir: string; journalDir: string }> {
  const secretsDir = await tempDir();
  const journalDir = await tempDir();
  void options;
  const svc = new StoredUploadService({
    secrets: new SecretStore(secretsDir, passthrough),
    journalDirectory: journalDir,
    runtime: async () => runtime,
    transportFactory: (authority) =>
      new UploadTransport(authority.origin, authority.bearer, { fetchImpl: server.fetch }),
    sourceFactory: () => server.source(),
    now: () => server.now,
  });
  return { svc, secretsDir, journalDir };
}

const authority = (overrides: Partial<Parameters<typeof captureAuthority>[0]> = {}) => ({
  accountId: ACCOUNT,
  deviceId: "dev-1",
  documentId: "doc-1",
  origin: ORIGIN,
  bearer: "token-1",
  ...overrides,
});

/** What a settled job's journal record says its outcome was. */
function outcomeFromRecord(record: Awaited<ReturnType<StoredUploadService["record"]>>) {
  if (record === null) return null;
  if (record.state === "published" && record.objectId !== null) {
    return { status: "published" as const, objectId: record.objectId, expiresAt: record.expiresAt };
  }
  if (record.state === "ambiguous") return { status: "ambiguous" as const, code: record.note ?? "" };
  return { status: "failed" as const, code: record.note ?? "", status_: null };
}

/** Drive a whole upload: start, produce, feed every frame, end. */
async function upload(
  svc: StoredUploadService,
  picked: readonly Picked[],
  overrides: { readonly burn?: boolean; readonly authority?: ReturnType<typeof authority> } = {},
) {
  const started = await svc.start({
    authority: overrides.authority ?? authority(),
    descriptors: picked.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
    retention: { burnAfterRead: overrides.burn ?? false, ttlSeconds: 86_400 },
  });
  if (!started.ok) return { started, outcome: null };
  const frames = await produce(picked, started.contentKey, runtime.constants);
  for (const frame of frames) {
    try {
      await svc.feed(started.jobId, frame);
    } catch {
      // A refusal settles the job; the settled record is what is asserted.
      const record = await svc.record(started.jobId);
      return { started, outcome: outcomeFromRecord(record) };
    }
  }
  const outcome = await svc.end(started.jobId);
  return { started, outcome };
}

// ---------------------------------------------------------------------------

describe("a complete upload", () => {
  it("produces ciphertext a receive can actually open", async () => {
    const picked: Picked[] = [
      { path: "notes.txt", data: bytes("hello world") },
      { path: "trip/day1/a.bin", data: bytes("xyz") },
    ];
    const server = new FakeServer();
    const { svc } = await service(server);
    const { started, outcome } = await upload(svc, picked);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(outcome?.status).toBe("published");
    if (outcome?.status !== "published") return;

    // The round trip: decrypt what the server assembled, with the built runtime.
    const object = [...server.objects.values()][0];
    expect(object).toBeDefined();
    if (!object) return;
    const key = await runtime.importKeyFromFragment(started.contentKey);
    const manifest = await runtime.decryptManifest(
      key,
      new Uint8Array(Buffer.from(object.encManifest, "base64")),
    );
    // Folder structure survives in `name`, which is the convention the CLI and
    // the macOS client use and the one a Windows receive splits.
    expect(manifest.files).toEqual([
      { name: "notes.txt", size: 11 },
      { name: "trip/day1/a.bin", size: 3 },
    ]);
    const decryptor = runtime.createDecryptor(key);
    const parts: Uint8Array[] = [];
    for await (const part of decryptor.push(object.blob)) parts.push(part);
    for await (const part of decryptor.end(14)) parts.push(part);
    expect(new TextDecoder().decode(concat(parts))).toBe("hello worldxyz");
  });

  it("sends exactly the documented request sequence and nothing else", async () => {
    const server = new FakeServer();
    const { svc } = await service(server);
    await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    expect(server.requests).toEqual([
      "POST /api/uploads",
      "PATCH /api/uploads/up0001",
      "POST /api/uploads/up0001/finalize",
    ]);
    // There is no `DELETE /api/uploads/{id}` in the API, and a share never
    // sends `POST /api/files/{id}/complete`.
    expect(server.requests.some((request) => request.startsWith("DELETE /api/uploads"))).toBe(false);
    expect(server.requests.some((request) => request.endsWith("/complete"))).toBe(false);
  });

  it("carries a multi-frame file and empty entries through one frame sequence", async () => {
    const big = new Uint8Array(runtime.constants.storeChunkSize + 100).fill(7);
    const picked: Picked[] = [
      { path: "big.bin", data: big },
      { path: "empty1.txt", data: new Uint8Array(0) },
      { path: "tail.txt", data: bytes("z") },
      { path: "empty2.txt", data: new Uint8Array(0) },
    ];
    const server = new FakeServer();
    const { svc } = await service(server);
    const { started, outcome } = await upload(svc, picked);
    expect(outcome?.status).toBe("published");
    if (!started.ok) return;
    // Two frames for the big file, one for the tail, none for either empty:
    // the global sequence never resets and never skips.
    const frames = await produce(picked, started.contentKey, runtime.constants);
    expect(frames.map((frame) => frame.seq)).toEqual([1, 2, 3]);
    expect(frames.map((frame) => frame.fileIndex)).toEqual([0, 0, 2]);
    const object = [...server.objects.values()][0];
    const key = await runtime.importKeyFromFragment(started.contentKey);
    const decryptor = runtime.createDecryptor(key);
    let total = 0;
    for await (const part of decryptor.push(object?.blob ?? new Uint8Array())) total += part.byteLength;
    for await (const part of decryptor.end(big.byteLength + 1)) total += part.byteLength;
    expect(total).toBe(big.byteLength + 1);
  });
});

describe("the offset algebra", () => {
  it("replays the exact unacknowledged suffix after a partial commit", async () => {
    const data = new Uint8Array(runtime.constants.storeChunkSize + 500).fill(3);
    // The server takes 1000 bytes per PATCH, so almost every append is partial.
    const server = new FakeServer({ commitLimit: 1000, chunkSize: 64 * 1024 });
    const { svc } = await service(server);
    const { started, outcome } = await upload(svc, [{ path: "a.bin", data }]);
    expect(outcome?.status).toBe("published");
    if (!started.ok) return;
    // The bytes the server assembled are the bytes the encoder produced —
    // replays were byte-identical, never re-encrypted.
    const frames = await produce([{ path: "a.bin", data }], started.contentKey, runtime.constants);
    const object = [...server.objects.values()][0];
    expect(Buffer.from(object?.blob ?? new Uint8Array())).toEqual(
      Buffer.from(concat(frames.map((frame) => frame.bytes))),
    );
  });

  it("recovers from a 409 gap by resyncing to the server's offset", async () => {
    // A dropped connection, then a 409: the engine re-reads the offset and
    // replays from it.
    const server = new FakeServer({ chunkSize: 64 * 1024, dropAppend: { nth: 1 } });
    const { svc } = await service(server);
    const data = new Uint8Array(100_000).fill(9);
    const { outcome } = await upload(svc, [{ path: "a.bin", data }]);
    expect(outcome?.status).toBe("published");
    expect(server.requests).toContain("GET /api/uploads/up0001");
  });

  it("fails rather than re-encrypting when the server's offset regresses", async () => {
    const server = new FakeServer({ chunkSize: 64 * 1024, regressAfter: 10 });
    const { svc } = await service(server);
    const { outcome } = await upload(svc, [{ path: "a.bin", data: new Uint8Array(80_000).fill(1) }]);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status !== "failed") return;
    // Those bytes are no longer retained, and re-encrypting them under the
    // retained key would repeat a nonce over different plaintext.
    expect(outcome.code).toBe("offset-regressed");
    expect(server.requests.some((request) => request.endsWith("/finalize"))).toBe(false);
  });

  it("fails when the server claims an offset past everything produced", async () => {
    const server = new FakeServer({ chunkSize: 64 * 1024, aheadBy: 5_000 });
    const { svc } = await service(server);
    const { outcome } = await upload(svc, [{ path: "a.bin", data: new Uint8Array(70_000).fill(1) }]);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status !== "failed") return;
    expect(outcome.code).toBe("offset-ahead");
  });

  it("stops asking when a server makes no progress", async () => {
    const server = new FakeServer({ chunkSize: 64 * 1024, stickyOffset: 0 });
    const { svc } = await service(server);
    const { outcome } = await upload(svc, [{ path: "a.bin", data: new Uint8Array(70_000).fill(1) }]);
    expect(outcome?.status).toBe("failed");
    if (outcome?.status !== "failed") return;
    expect(outcome.code).toBe("no-progress");
    // Bounded: not a spin.
    expect(server.requests.filter((request) => request.startsWith("PATCH")).length).toBeLessThan(8);
  });
});

describe("the producer contract", () => {
  const picked: Picked[] = [{ path: "a.txt", data: bytes("hello world") }];

  async function started(server: FakeServer) {
    const { svc } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: picked.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) throw new Error("start refused");
    const frames = await produce(picked, start.contentKey, runtime.constants);
    return { svc, start, frames };
  }

  it("tells the producer exactly what it owes next", async () => {
    const { svc, start, frames } = await started(new FakeServer());
    expect(svc.expects(start.jobId)).toEqual({
      fileIndex: 0,
      seq: 1,
      bytes: frames[0]?.bytes.byteLength,
    });
    await svc.feed(start.jobId, frames[0]!);
    expect(svc.expects(start.jobId)).toBeNull();
  });

  it("refuses a duplicated frame", async () => {
    const { svc, start, frames } = await started(new FakeServer());
    await svc.feed(start.jobId, frames[0]!);
    await expect(svc.feed(start.jobId, frames[0]!)).rejects.toMatchObject({ code: "producer-overrun" });
  });

  it("refuses a frame with the wrong sequence number", async () => {
    const { svc, start, frames } = await started(new FakeServer());
    await expect(
      svc.feed(start.jobId, { ...frames[0]!, seq: 2 }),
    ).rejects.toMatchObject({ code: "frame-sequence" });
  });

  it("refuses a frame attributed to the wrong file", async () => {
    const { svc, start, frames } = await started(new FakeServer());
    await expect(
      svc.feed(start.jobId, { ...frames[0]!, fileIndex: 1 }),
    ).rejects.toMatchObject({ code: "frame-index" });
  });

  it("refuses a frame of the wrong length", async () => {
    const { svc, start, frames } = await started(new FakeServer());
    const short = frames[0]!.bytes.subarray(0, frames[0]!.bytes.byteLength - 1);
    await expect(
      svc.feed(start.jobId, { ...frames[0]!, bytes: short }),
    ).rejects.toMatchObject({ code: "frame-length" });
    // A refusal is terminal for the job: this engine cannot produce the bytes
    // it was expecting, so there is nothing to resynchronise to.
    await expect(svc.feed(start.jobId, frames[0]!)).rejects.toMatchObject({ code: "internal" });
  });

  it("refuses a frame whose length prefix lies", async () => {
    // Right byte count, wrong header. A receiver reassembles by that prefix, so
    // this frame would decrypt as garbage at the far end.
    const { svc, start, frames } = await started(new FakeServer());
    const lying = frames[0]!.bytes.slice();
    new DataView(lying.buffer).setUint32(0, 999, false);
    await expect(
      svc.feed(start.jobId, { ...frames[0]!, bytes: lying }),
    ).rejects.toMatchObject({ code: "frame-length" });
  });

  it("refuses two concurrent feeds instead of queueing them", async () => {
    const two: Picked[] = [
      { path: "a.txt", data: new Uint8Array(runtime.constants.storeChunkSize + 10).fill(1) },
      { path: "b.txt", data: bytes("z") },
    ];
    const server = new FakeServer({ chunkSize: 64 * 1024 });
    const { svc } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: two.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) return;
    const frames = await produce(two, start.contentKey, runtime.constants);
    const first = svc.feed(start.jobId, frames[0]!);
    // A queue here would let the producer run ahead of the acknowledged offset.
    await expect(svc.feed(start.jobId, frames[1]!)).rejects.toMatchObject({
      code: "concurrent-feed",
    });
    await first.catch(() => undefined);
  });

  it("refuses to finalize a short producer", async () => {
    const two: Picked[] = [
      { path: "a.txt", data: bytes("abc") },
      { path: "b.txt", data: bytes("de") },
    ];
    const server = new FakeServer();
    const { svc } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: two.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) return;
    const frames = await produce(two, start.contentKey, runtime.constants);
    await svc.feed(start.jobId, frames[0]!);
    const outcome = await svc.end(start.jobId);
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.code).toBe("producer-short");
    expect(server.requests.some((request) => request.endsWith("/finalize"))).toBe(false);
  });
});

describe("what the server is allowed to say", () => {
  it("refuses an uploadId that is not one inert token", async () => {
    // Interpolated into three URLs; `../me` would compose a request at an
    // endpoint this upload never authorised.
    const server = new FakeServer({ uploadId: "../me" });
    const { svc } = await service(server);
    const { started } = await upload(svc, [{ path: "a.txt", data: bytes("a") }]);
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.refusal.code).toBe("server-refused");
  });

  it("clamps a hostile chunkSize instead of allocating for it", async () => {
    const server = new FakeServer({ chunkSize: 2 ** 40 });
    const { svc } = await service(server);
    const data = new Uint8Array(runtime.constants.storeChunkSize + 5).fill(4);
    const { outcome } = await upload(svc, [{ path: "a.bin", data }]);
    // It still works, and the buffer it worked through is bounded by the clamp.
    expect(outcome?.status).toBe("published");
    expect(MAX_ACCEPTED_CHUNK_BYTES).toBe(8 * 1024 * 1024);
  });

  it("refuses a manifest too large for init", async () => {
    // 64 KiB is the server's `maxManifestBytes`, read before anything else.
    const many = Array.from({ length: 900 }, (_, i) => ({
      path: `folder/${String(i).padStart(4, "0")}-${"n".repeat(60)}.bin`,
      size: 1,
    }));
    const server = new FakeServer();
    const { svc } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: many,
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    expect(start.ok).toBe(false);
    if (start.ok) return;
    expect(start.refusal.code).toBe("manifest-too-large-to-send");
    // Refused before a request was made.
    expect(server.requests).toEqual([]);
  });

  it("refuses a manifest Windows could not receive, before any request", async () => {
    const server = new FakeServer();
    const { svc } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: [{ path: "..\\evil.txt", size: 1 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    expect(start.ok).toBe(false);
    if (start.ok) return;
    expect(start.refusal.code).toBe("manifest-refused");
    expect(start.refusal.refusal).toEqual({ kind: "path", reason: "backslash-in-segment" });
    expect(server.requests).toEqual([]);
  });
});

describe("key custody and the journal", () => {
  it("persists the key BEFORE init", async () => {
    // Asserted from inside the init handler: if the slot is not on disk yet,
    // a crash here would leave ciphertext nobody can open.
    let slotAtInit: string[] = [];
    const secretsDir = await tempDir();
    const journalDir = await tempDir();
    const server = new FakeServer({
      onInit: async () => {
        const { readdir } = await import("node:fs/promises");
        slotAtInit = await readdir(secretsDir);
      },
    });
    const svc = new StoredUploadService({
      secrets: new SecretStore(secretsDir, passthrough),
      journalDirectory: journalDir,
      runtime: async () => runtime,
      transportFactory: (auth) =>
        new UploadTransport(auth.origin, auth.bearer, { fetchImpl: server.fetch }),
      sourceFactory: () => server.source(),
    });
    await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    expect(slotAtInit.filter((name) => name.startsWith("stored-upload-key-"))).toHaveLength(1);
  });

  it("keeps no secret and no filename in the journal on disk", async () => {
    const server = new FakeServer();
    const { svc, journalDir } = await service(server);
    const { started } = await upload(svc, [{ path: "tax-return-2025.pdf", data: bytes("abc") }]);
    if (!started.ok) return;
    const raw = await readFile(join(journalDir, "stored-uploads.json"), "utf8");
    expect(raw).not.toContain(started.contentKey);
    expect(raw).not.toContain("tax-return");
    expect(raw).not.toContain("#k=");
    // What it DOES contain is the digest that makes reconciliation exact.
    const record = await svc.record(started.jobId);
    expect(record?.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hands the link out only for a published record, and never stores it", async () => {
    const server = new FakeServer();
    const { svc } = await service(server);
    const { started, outcome } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok || outcome?.status !== "published") return;
    const link = await svc.linkFor(started.jobId, ACCOUNT, ORIGIN);
    expect(link).toBe(`${ORIGIN}/d/${outcome.objectId}#k=${started.contentKey}`);
    // Another account cannot read it.
    expect(await svc.linkFor(started.jobId, OTHER_ACCOUNT, ORIGIN)).toBeNull();
  });

  it("keeps history account-isolated", async () => {
    const server = new FakeServer();
    const { svc } = await service(server);
    await upload(svc, [{ path: "mine.txt", data: bytes("a") }]);
    await upload(svc, [{ path: "theirs.txt", data: bytes("b") }], {
      authority: authority({ accountId: OTHER_ACCOUNT }),
    });
    expect(await svc.history(ACCOUNT)).toHaveLength(1);
    expect(await svc.history(OTHER_ACCOUNT)).toHaveLength(1);
    const mine = (await svc.history(ACCOUNT))[0];
    expect(mine?.accountId).toBe(ACCOUNT);
  });

  it("retires a key only after the server confirms the object is gone", async () => {
    const server = new FakeServer();
    const { svc, secretsDir } = await service(server);
    const { started, outcome } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok || outcome?.status !== "published") return;
    const slot = join(secretsDir, `stored-upload-key-${started.jobId.slice(2)}.bin`);
    const slotName = (await import("node:fs/promises")).readdir;
    const before = (await slotName(secretsDir)).filter((f) => f.startsWith("stored-upload-key-"));
    expect(before).toHaveLength(1);
    void slot;

    const result = await svc.deleteObject(started.jobId, ACCOUNT, {
      origin: ORIGIN,
      bearer: "token-1",
    });
    expect(result).toBe("deleted");
    const after = (await slotName(secretsDir)).filter((f) => f.startsWith("stored-upload-key-"));
    expect(after).toHaveLength(0);
    expect((await svc.record(started.jobId))?.state).toBe("closed");
  });
});

describe("a finalize whose answer is lost", () => {
  it("is ambiguous, keeps the key, and never claims success or failure", async () => {
    const server = new FakeServer({ loseFinalize: true });
    const { svc, secretsDir } = await service(server);
    const { started, outcome } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok) return;
    expect(outcome?.status).toBe("ambiguous");
    // The object DOES exist server-side; this client just never heard the id.
    expect(server.objects.size).toBe(1);
    const record = await svc.record(started.jobId);
    expect(record?.state).toBe("ambiguous");
    expect(record?.objectId).toBeNull();
    // The key is retained: it is the only thing that can ever open that object.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(secretsDir)).filter((f) => f.startsWith("stored-upload-key-"))).toHaveLength(1);
  });

  it("treats a terminal 409 as ambiguous, not as success", async () => {
    const server = new FakeServer({ finalizeTaken: true });
    const { svc } = await service(server);
    const { started, outcome } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok) return;
    expect(outcome?.status).toBe("ambiguous");
    // 409 carries no id, and no request in this API can recover one.
    expect((await svc.record(started.jobId))?.objectId).toBeNull();
    expect(await svc.linkFor(started.jobId, ACCOUNT, ORIGIN)).toBeNull();
  });

  it("resolves by EXACT manifest digest, and refuses a same-sized impostor", async () => {
    const server = new FakeServer({ loseFinalize: true });
    const { svc } = await service(server);
    const { started } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok) return;

    // A decoy of exactly the same ciphertext size, from a different manifest.
    const real = [...server.objects.values()][0];
    server.objects.set("obj9999", {
      id: "obj9999",
      encManifest: Buffer.from(new Uint8Array(real?.encManifest.length ?? 40).fill(9)).toString("base64"),
      size: real?.size ?? 0,
      createdAt: server.now + 1,
      expiresAt: server.now + 100,
      blob: new Uint8Array(0),
    });

    const resolved = await svc.reconcile(started.jobId, ACCOUNT, {
      origin: ORIGIN,
      bearer: "token-1",
    });
    expect(resolved.result).toBe("resolved");
    if (resolved.result !== "resolved") return;
    expect(resolved.record.objectId).toBe(real?.id);
    // And now a link is available, from the proven id.
    expect(await svc.linkFor(started.jobId, ACCOUNT, ORIGIN)).toContain(`/d/${String(real?.id)}#k=`);
  });

  it("reports no-match without claiming the object is absent", async () => {
    const server = new FakeServer({ loseFinalize: true });
    const { svc } = await service(server);
    const { started } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok) return;
    // The object is deleted behind this client's back: a burn, a TTL, another
    // device. Indistinguishable from "never created" — so nothing is claimed.
    server.objects.clear();
    const outcome = await svc.reconcile(started.jobId, ACCOUNT, { origin: ORIGIN, bearer: "token-1" });
    expect(outcome.result).toBe("no-match");
    const record = await svc.record(started.jobId);
    expect(record?.state).toBe("ambiguous");
  });

  it("lists unresolved uploads as recoverable inventory", async () => {
    const server = new FakeServer({ loseFinalize: true });
    const { svc } = await service(server);
    await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    const inventory = await svc.inventory(ACCOUNT);
    expect(inventory.unresolved).toHaveLength(1);
    expect(inventory.liveJobs).toEqual([]);
  });
});

describe("authority and cancellation", () => {
  it("cancels before finalize, retires the key, and claims no server erase", async () => {
    const server = new FakeServer({ chunkSize: 64 * 1024 });
    const { svc, secretsDir } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: [{ path: "a.bin", size: 70_000 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) return;
    const outcome = await svc.cancel(start.jobId);
    expect(outcome.status).toBe("cancelled");
    // Nothing was published — finalize is the only publisher and it was never
    // called — so the key is retired on proof rather than kept forever.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(secretsDir)).filter((f) => f.startsWith("stored-upload-key-"))).toHaveLength(0);
    // And no DELETE was sent, because the API has none: the session is left to
    // the server's own reaper.
    expect(server.requests.some((request) => request.startsWith("DELETE"))).toBe(false);
  });

  it("revokes a job when the signed-in account changes", async () => {
    const server = new FakeServer({ chunkSize: 64 * 1024 });
    const { svc } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: [{ path: "a.bin", size: 70_000 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) return;
    await svc.reconcileAccount({ accountId: OTHER_ACCOUNT, deviceId: "dev-1" });
    expect((await svc.inventory(ACCOUNT)).liveJobs).toEqual([]);
    // The job is gone, so no further frame can start a request.
    await expect(svc.feed(start.jobId, { fileIndex: 0, seq: 1, bytes: new Uint8Array(24) })).rejects.toThrow();
  });

  it("refuses to hand the key to a document that does not own the job", () => {
    const fence = new Fence(captureAuthority(authority()));
    expect(fence.exposeKey("doc-1", "AAA")).toBe("AAA");
    expect(() => fence.exposeKey("doc-2", "AAA")).toThrow(/document-revoked/);
    fence.revoke("document-revoked");
    expect(() => fence.exposeKey("doc-1", "AAA")).toThrow(/document-revoked/);
  });

  it("keeps the first revocation reason", () => {
    const fence = new Fence(captureAuthority(authority()));
    fence.revoke("cancelled");
    fence.revoke("account-changed");
    expect(fence.reason).toBe("cancelled");
  });
});

describe("the plan", () => {
  it("derives the frame geometry the encoder actually emits", () => {
    const chunk = runtime.constants.storeChunkSize;
    const overhead = runtime.constants.frameOverhead;
    const lengths = (size: number): number[] => {
      const file = frameGeometry(size, runtime.constants);
      return Array.from({ length: file.frameCount }, (_, i) => frameLengthAt(file, i) ?? -1);
    };
    // A zero-byte file owes no frames at all.
    expect(lengths(0)).toEqual([]);
    expect(lengths(1)).toEqual([1 + overhead]);
    // Exactly one full chunk is one frame; one byte more is two.
    expect(lengths(chunk)).toEqual([chunk + overhead]);
    expect(lengths(chunk + 1)).toEqual([chunk + overhead, 1 + overhead]);
    expect(lengths(2 * chunk)).toEqual([chunk + overhead, chunk + overhead]);
    // Out of range in either direction is null, not a wrong number.
    expect(frameLengthAt(frameGeometry(chunk, runtime.constants), 1)).toBeNull();
    expect(frameLengthAt(frameGeometry(chunk, runtime.constants), -1)).toBeNull();
  });

  it("plans a HUGE valid descriptor without materialising its frames", () => {
    // The defect this pins: the schedule used to be one number per frame, so a
    // single valid 2**50-byte descriptor allocated billions of numbers
    // synchronously — before the server was asked anything, before a quota,
    // before init. No file-size cap was added to fix it (that would narrow
    // parity with macOS); the geometry is simply not materialised.
    const size = 2 ** 50;
    const chunk = runtime.constants.storeChunkSize;
    const overhead = runtime.constants.frameOverhead;
    const before = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    const planned = planUpload([{ path: "huge.bin", size }], runtime.constants);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const grew = process.memoryUsage().heapUsed - before;

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const file = planned.plan.frames[0];
    // Four numbers, not a list. `lengths` does not exist any more.
    expect(file).toEqual({
      index: 0,
      fullFrames: Math.floor(size / chunk),
      fullBytes: chunk + overhead,
      tailBytes: (size % chunk) + overhead,
      frameCount: Math.floor(size / chunk) + 1,
    });
    expect((file as unknown as { lengths?: unknown }).lengths).toBeUndefined();
    expect(planned.plan.frameCount).toBe(Math.floor(size / chunk) + 1);
    expect(planned.plan.cipherBytes).toBe(size + overhead * Math.ceil(size / chunk));
    // ~5.7 billion frames would be tens of gigabytes of numbers and minutes of
    // pushing. Both bounds are loose on purpose: what they exclude is any
    // per-frame work at all.
    expect(elapsedMs).toBeLessThan(50);
    expect(grew).toBeLessThan(4 * 1024 * 1024);
  });

  it("answers `expects` in O(1) for a huge descriptor", () => {
    const planned = planUpload([{ path: "huge.bin", size: 2 ** 50 }], runtime.constants);
    if (!planned.ok) return;
    const file = planned.plan.frames[0]!;
    const chunk = runtime.constants.storeChunkSize;
    const overhead = runtime.constants.frameOverhead;
    // A frame in the middle of billions, without touching the ones before it.
    expect(frameLengthAt(file, 3_000_000_000)).toBe(chunk + overhead);
    expect(frameLengthAt(file, file.frameCount - 1)).toBe((2 ** 50 % chunk) + overhead);
    expect(frameLengthAt(file, file.frameCount)).toBeNull();
  });

  it("keeps descriptor order, which is what binds names to bytes", () => {
    const planned = planUpload(
      [
        { path: "b.txt", size: 2 },
        { path: "a.txt", size: 1 },
      ],
      runtime.constants,
    );
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // NOT sorted. The producer encrypts this array in this order, and the
    // receiver splits one frame sequence by these sizes.
    expect(planned.plan.manifest.map((entry) => entry.name)).toEqual(["b.txt", "a.txt"]);
  });
});

describe("the journal on disk", () => {
  it("refuses a corrupt document rather than resetting it", async () => {
    const dir = await tempDir();
    const journal = new UploadJournal(dir);
    await journal.admit({
      jobId: "u-1",
      accountId: ACCOUNT,
      manifestDigest: "a".repeat(64),
      fileCount: 1,
      totalBytes: 1,
      cipherBytes: 21,
      burnAfterRead: false,
    });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "stored-uploads.json"), '{"v":1,"records":[{"jobId":"u-1"}]}', "utf8");
    journal.resetCacheForTest();
    await expect(journal.list(ACCOUNT)).rejects.toMatchObject({ code: "corrupt" });
  });

  it("refuses a new upload at capacity rather than dropping an unknown one", async () => {
    const dir = await tempDir();
    // Two slots, both taken by unknown finalizations. The rule is what is
    // tested, not the constant.
    const journal = new UploadJournal(dir, () => 1, 2);
    for (let i = 0; i < 2; i += 1) {
      await journal.admit({
        jobId: `u-${String(i)}`,
        accountId: ACCOUNT,
        manifestDigest: "b".repeat(64),
        fileCount: 1,
        totalBytes: 1,
        cipherBytes: 21,
        burnAfterRead: false,
      });
      await journal.update(`u-${String(i)}`, { state: "ambiguous", note: "lost" });
    }
    await expect(
      journal.admit({
        jobId: "u-overflow",
        accountId: ACCOUNT,
        manifestDigest: "c".repeat(64),
        fileCount: 1,
        totalBytes: 1,
        cipherBytes: 21,
        burnAfterRead: false,
      }),
    ).rejects.toMatchObject({ code: "at-capacity" });
  });

  it("survives a reload and keeps every unresolved record", async () => {
    const dir = await tempDir();
    const first = new UploadJournal(dir, () => 7);
    await first.admit({
      jobId: "u-keep",
      accountId: ACCOUNT,
      manifestDigest: "d".repeat(64),
      fileCount: 2,
      totalBytes: 5,
      cipherBytes: 45,
      burnAfterRead: true,
    });
    await first.update("u-keep", { state: "ambiguous", note: "network" });
    const second = new UploadJournal(dir, () => 8);
    const records = await second.unresolved(ACCOUNT);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ jobId: "u-keep", state: "ambiguous", burnAfterRead: true });
  });
});

describe("the engine's own bounds", () => {
  it("never allocates from an unvalidated chunk size", async () => {
    // The buffer is chunkSize + one frame, and chunkSize comes from
    // `UploadTransport.init`, which clamps. This asserts the contract that
    // makes that safe rather than the allocation itself.
    const server = new FakeServer({ chunkSize: -1 });
    const { svc } = await service(server);
    const { outcome } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    expect(outcome?.status).toBe("published");
  });

  it("reports progress as SERVER-acknowledged bytes", async () => {
    const server = new FakeServer({ commitLimit: 1000, chunkSize: 64 * 1024 });
    const { svc } = await service(server);
    const seen: number[] = [];
    const data = new Uint8Array(5_000).fill(2);
    const start = await svc.start({
      authority: authority(),
      descriptors: [{ path: "a.bin", size: data.byteLength }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
      onProgress: (committed) => seen.push(committed),
    });
    if (!start.ok) return;
    for (const frame of await produce([{ path: "a.bin", data }], start.contentKey, runtime.constants)) {
      await svc.feed(start.jobId, frame);
    }
    await svc.end(start.jobId);
    expect(seen.length).toBeGreaterThan(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen[seen.length - 1]).toBe(data.byteLength + runtime.constants.frameOverhead);
  });

  it("exposes the engine directly for a fenced start", async () => {
    // The engine refuses to open under a revoked authority, before init.
    const server = new FakeServer();
    const fence = new Fence(captureAuthority(authority()));
    fence.revoke("document-revoked");
    const planned = planUpload([{ path: "a.txt", size: 3 }], runtime.constants);
    if (!planned.ok) return;
    const generated = await runtime.generateKey();
    const sealed = await runtime.sealManifest(generated.key, { files: planned.plan.manifest });
    await expect(
      UploadEngine.open({
        runtime,
        key: generated.key,
        sealedManifest: sealed,
        plan: planned.plan,
        retention: { burnAfterRead: false, ttlSeconds: 60 },
        transport: new UploadTransport(ORIGIN, "token-1", { fetchImpl: server.fetch }),
        fence,
      }),
    ).rejects.toThrow(/revoked/);
    expect(server.requests).toEqual([]);
  });

  it("digests the sealed manifest the way the reconciler compares it", async () => {
    const generated = await runtime.generateKey();
    const sealed = await runtime.sealManifest(generated.key, { files: [{ name: "a.txt", size: 1 }] });
    expect(manifestDigest(sealed)).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestDigest(sealed)).toBe(manifestDigest(sealed));
  });
});

describe("a revocation that lands DURING start", () => {
  // The window root named: `start` awaits the runtime, the key generation, the
  // seal, the journal write and the key persistence before init. If admission
  // is not synchronous, none of `reconcileAccount`, `revoke` or `inventory` can
  // see the job — and a sign-out during key persistence would still let init go
  // out under the old bearer and hand a content key back.
  //
  // Each test PARKS a step, revokes, then releases, and asserts that no init
  // was sent and no key was returned.

  /** A `SecretStore` whose `putIfAbsent` blocks until released. */
  function parkedSecrets(dir: string) {
    let release!: () => void;
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const arrived = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const store = new SecretStore(dir, passthrough);
    const original = store.putIfAbsent.bind(store);
    (store as unknown as { putIfAbsent: SecretStore["putIfAbsent"] }).putIfAbsent = async (
      key: string,
      value: string,
    ) => {
      entered();
      await parked;
      return original(key, value);
    };
    return { store, arrived, release };
  }

  async function parkedService(server: FakeServer) {
    const secretsDir = await tempDir();
    const journalDir = await tempDir();
    const parked = parkedSecrets(secretsDir);
    const svc = new StoredUploadService({
      secrets: parked.store,
      journalDirectory: journalDir,
      runtime: async () => runtime,
      transportFactory: (auth) =>
        new UploadTransport(auth.origin, auth.bearer, { fetchImpl: server.fetch }),
      sourceFactory: () => server.source(),
    });
    return { svc, secretsDir, ...parked };
  }

  it("is visible in inventory before its first await has returned", async () => {
    const server = new FakeServer();
    const { svc, arrived, release } = await parkedService(server);
    const running = svc.start({
      authority: authority(),
      descriptors: [{ path: "a.txt", size: 3 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    await arrived;
    // Registered synchronously, so a start in progress is a job the host can
    // see and stop.
    expect((await svc.inventory(ACCOUNT)).liveJobs).toHaveLength(1);
    release();
    await running;
  });

  it("a sign-out during key persistence sends NO init and returns NO key", async () => {
    const server = new FakeServer();
    const { svc, arrived, release, secretsDir } = await parkedService(server);
    const running = svc.start({
      authority: authority(),
      descriptors: [{ path: "a.txt", size: 3 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    await arrived;
    const revoked = svc.reconcileAccount({ accountId: OTHER_ACCOUNT, deviceId: "dev-1" });
    release();
    const [result] = await Promise.all([running, revoked]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("authority");
    // The whole point: the old bearer never reached the server.
    expect(server.requests).toEqual([]);
    // And the key that was mid-write is retired, because no object can exist.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(secretsDir)).filter((f) => f.startsWith("stored-upload-key-"))).toHaveLength(0);
    expect((await svc.inventory(OTHER_ACCOUNT)).liveJobs).toEqual([]);
  });

  it("a document revocation during key persistence does the same", async () => {
    const server = new FakeServer();
    const { svc, arrived, release } = await parkedService(server);
    const running = svc.start({
      authority: authority(),
      descriptors: [{ path: "a.txt", size: 3 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    await arrived;
    const revoked = svc.revokeDocument("doc-1");
    release();
    const [result] = await Promise.all([running, revoked]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("authority");
    expect(server.requests).toEqual([]);
    const record = await svc.record((await svc.history(ACCOUNT))[0]?.jobId ?? "none");
    // The record exists and says closed — not pending, and not published.
    expect(record?.state).toBe("closed");
    expect(record?.note).toBe("authority");
  });

  it("revokes every mismatched job's fence BEFORE joining any of them", async () => {
    // Two jobs parked in key persistence. An implementation that awaited each
    // teardown inside the loop would leave the second fence valid — and
    // therefore able to init under the old bearer — until the first finished.
    const server = new FakeServer();
    const secretsDir = await tempDir();
    const journalDir = await tempDir();
    let holds = 0;
    let releaseAll!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const store = new SecretStore(secretsDir, passthrough);
    const original = store.putIfAbsent.bind(store);
    (store as unknown as { putIfAbsent: SecretStore["putIfAbsent"] }).putIfAbsent = async (
      key: string,
      value: string,
    ) => {
      holds += 1;
      await parked;
      return original(key, value);
    };
    const svc = new StoredUploadService({
      secrets: store,
      journalDirectory: journalDir,
      runtime: async () => runtime,
      transportFactory: (auth) =>
        new UploadTransport(auth.origin, auth.bearer, { fetchImpl: server.fetch }),
    });
    const first = svc.start({
      authority: authority(),
      descriptors: [{ path: "a.txt", size: 3 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    const second = svc.start({
      authority: authority({ documentId: "doc-2" }),
      descriptors: [{ path: "b.txt", size: 3 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    // Polled rather than slept: the journal write between admission and
    // custody includes an fsync, so a fixed delay is a flake waiting to happen.
    for (let i = 0; i < 200 && holds < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(holds).toBe(2);
    expect((await svc.inventory(ACCOUNT)).liveJobs).toHaveLength(2);
    const revoked = svc.reconcileAccount({ accountId: OTHER_ACCOUNT, deviceId: "dev-1" });
    releaseAll();
    const [a, b] = await Promise.all([first, second, revoked]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(server.requests).toEqual([]);
  });

  it("joins a start that is still running when a cancel arrives", async () => {
    const server = new FakeServer();
    const { svc, arrived, release } = await parkedService(server);
    const running = svc.start({
      authority: authority(),
      descriptors: [{ path: "a.txt", size: 3 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    await arrived;
    const jobId = (await svc.inventory(ACCOUNT)).liveJobs[0] ?? "";
    const stopping = svc.cancel(jobId);
    release();
    const [, outcome] = await Promise.all([running, stopping]);
    // Nothing was sent, so nothing was published — and the cancel waited for
    // the start rather than resolving alongside it.
    expect(outcome.status).toBe("cancelled");
    expect(server.requests).toEqual([]);
    expect((await svc.inventory(ACCOUNT)).liveJobs).toEqual([]);
  });
});

describe("outcomes after a job has settled", () => {
  it("a second cancel of an ambiguous job does NOT claim it was cancelled", async () => {
    // The bug this pins: `cancel` used to answer `cancelled` for any job that
    // was no longer live, which turns a durable unknown — an object that may
    // well exist — into a false "provably absent".
    const server = new FakeServer({ loseFinalize: true });
    const { svc } = await service(server);
    const { started, outcome } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok) return;
    expect(outcome?.status).toBe("ambiguous");
    const again = await svc.cancel(started.jobId);
    expect(again.status).toBe("ambiguous");
    expect(server.objects.size).toBe(1);
  });

  it("a cancel of a published job reports the object, not a cancellation", async () => {
    const server = new FakeServer();
    const { svc } = await service(server);
    const { started, outcome } = await upload(svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok || outcome?.status !== "published") return;
    const again = await svc.cancel(started.jobId);
    expect(again).toEqual({
      status: "published",
      objectId: outcome.objectId,
      expiresAt: outcome.expiresAt,
    });
  });

  it("keeps live-job inventory account-scoped", async () => {
    const server = new FakeServer({ chunkSize: 64 * 1024 });
    const { svc } = await service(server);
    const mine = await svc.start({
      authority: authority(),
      descriptors: [{ path: "a.bin", size: 70_000 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    const theirs = await svc.start({
      authority: authority({ accountId: OTHER_ACCOUNT }),
      descriptors: [{ path: "b.bin", size: 70_000 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!mine.ok || !theirs.ok) return;
    // One account must not learn another's job ids from this surface.
    expect((await svc.inventory(ACCOUNT)).liveJobs).toEqual([mine.jobId]);
    expect((await svc.inventory(OTHER_ACCOUNT)).liveJobs).toEqual([theirs.jobId]);
    await svc.cancel(mine.jobId);
    await svc.cancel(theirs.jobId);
  });
});

describe("holding operations: what a quiesce can actually observe", () => {
  /** A journal whose write parks, so a settlement can be caught mid-flight. */
  function parkedJournalService(server: FakeServer, secretsDir: string, journalDir: string) {
    let hold: Promise<void> | null = null;
    let release: (() => void) | null = null;
    let arrived: (() => void) | null = null;
    const at = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const secrets = new SecretStore(secretsDir, passthrough);
    const svc = new StoredUploadService({
      secrets,
      journalDirectory: journalDir,
      runtime: async () => runtime,
      transportFactory: (auth) =>
        new UploadTransport(auth.origin, auth.bearer, { fetchImpl: server.fetch }),
      sourceFactory: () => server.source(),
    });
    // Park only the settlement write, identified by the state it carries.
    const journal = (svc as unknown as { journal: UploadJournal }).journal;
    const update = journal.update.bind(journal);
    (journal as unknown as { update: UploadJournal["update"] }).update = async (jobId, patch) => {
      if (patch.state !== undefined && hold !== null) {
        arrived?.();
        await hold;
      }
      return update(jobId, patch);
    };
    return {
      svc,
      secrets,
      park: () => {
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      arrived: at,
      release: () => release?.(),
    };
  }

  it("a cancel joins a settlement that is still being written", async () => {
    const server = new FakeServer({ loseFinalize: true });
    const secretsDir = await tempDir();
    const journalDir = await tempDir();
    const harness = parkedJournalService(server, secretsDir, journalDir);
    const picked: Picked[] = [{ path: "a.txt", data: bytes("abc") }];
    const start = await harness.svc.start({
      authority: authority(),
      descriptors: picked.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) return;
    for (const frame of await produce(picked, start.contentKey, runtime.constants)) {
      await harness.svc.feed(start.jobId, frame);
    }
    // The finalize answer is lost, so the outcome is ambiguous — and the
    // journal write of that outcome is parked.
    harness.park();
    const ending = harness.svc.end(start.jobId);
    await harness.arrived;
    // A cancel arriving mid-settlement must WAIT for it, not answer from a
    // record that has not been written yet.
    const cancelling = harness.svc.cancel(start.jobId);
    harness.release();
    const [ended, cancelled] = await Promise.all([ending, cancelling]);
    expect(ended.status).toBe("ambiguous");
    // The joined answer is the durable one, not a fresh "cancelled".
    expect(cancelled.status).toBe("ambiguous");
    expect((await harness.svc.record(start.jobId))?.state).toBe("ambiguous");
    // And the key is still there: an object may exist.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(secretsDir)).filter((f) => f.startsWith("stored-upload-key-"))).toHaveLength(1);
  });

  it("an `end` racing a live feed settles nothing and keeps the key", async () => {
    // `end` while a feed is in flight refuses with `concurrent-feed` and the
    // engine settles NOTHING. Writing a failed record there would close the
    // journal and retire the key of an upload still being fed.
    const picked: Picked[] = [
      { path: "big.bin", data: new Uint8Array(runtime.constants.storeChunkSize + 10).fill(5) },
      { path: "tail.txt", data: bytes("z") },
    ];
    const server = new FakeServer({ chunkSize: 64 * 1024 });
    const { svc, secretsDir } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: picked.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) return;
    const frames = await produce(picked, start.contentKey, runtime.constants);
    const feeding = svc.feed(start.jobId, frames[0]!);
    await expect(svc.end(start.jobId)).rejects.toMatchObject({ code: "concurrent-feed" });
    // The job is untouched: still live, record still pending, key still held.
    expect((await svc.record(start.jobId))?.state).toBe("pending");
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(secretsDir)).filter((f) => f.startsWith("stored-upload-key-"))).toHaveLength(1);
    await feeding;
    // And the upload can still be completed normally afterwards.
    for (const frame of frames.slice(1)) await svc.feed(start.jobId, frame);
    expect((await svc.end(start.jobId)).status).toBe("published");
  });

  it("a revocation reaches the init request itself", async () => {
    // `UploadEngine.open` sends init before the engine's own AbortController
    // exists, so the fence carries the signal. Without it, a quiesce during
    // init could only be noticed after the answer came back.
    let seen: AbortSignal | null = null;
    let releaseInit!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    const secretsDir = await tempDir();
    const journalDir = await tempDir();
    const svc = new StoredUploadService({
      secrets: new SecretStore(secretsDir, passthrough),
      journalDirectory: journalDir,
      runtime: async () => runtime,
      transportFactory: () =>
        ({
          init: async (
            _manifest: Uint8Array,
            _retention: unknown,
            _size: number,
            signal?: AbortSignal,
          ) => {
            seen = signal ?? null;
            await parked;
            if (signal?.aborted === true) {
              const error = new Error("aborted");
              error.name = "AbortError";
              throw error;
            }
            return { uploadId: "abc123", chunkSize: 65_536 };
          },
        }) as unknown as UploadTransport,
    });
    const starting = svc.start({
      authority: authority(),
      descriptors: [{ path: "a.txt", size: 3 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    for (let i = 0; i < 200 && seen === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(seen).not.toBeNull();
    expect((seen as unknown as AbortSignal).aborted).toBe(false);
    const revoking = svc.revokeDocument("doc-1");
    // The in-flight init is aborted, not merely checked afterwards.
    expect((seen as unknown as AbortSignal).aborted).toBe(true);
    releaseInit();
    const [result] = await Promise.all([starting, revoking]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("authority");
  });
});

describe("bounds and unwinding at admission", () => {
  it("refuses past the active bound before doing any key work", async () => {
    // The journal's cap is consulted after the runtime load, the key
    // generation and the seal, so it cannot bound a burst of starts. This one
    // is checked in the synchronous block.
    const server = new FakeServer({ chunkSize: 64 * 1024 });
    const { svc } = await service(server);
    let generated = 0;
    const counting = {
      ...runtime,
      generateKey: async () => {
        generated += 1;
        return runtime.generateKey();
      },
    } as unknown as StoredRuntime;
    const bounded = new StoredUploadService({
      secrets: new SecretStore(await tempDir(), passthrough),
      journalDirectory: await tempDir(),
      runtime: async () => counting,
      transportFactory: (auth) =>
        new UploadTransport(auth.origin, auth.bearer, { fetchImpl: server.fetch }),
    });
    void svc;
    const started = [];
    for (let i = 0; i < MAX_ACTIVE_JOBS; i += 1) {
      started.push(
        await bounded.start({
          authority: authority(),
          descriptors: [{ path: `f${String(i)}.bin`, size: 70_000 }],
          retention: { burnAfterRead: false, ttlSeconds: 60 },
        }),
      );
    }
    expect(started.every((result) => result.ok)).toBe(true);
    expect(generated).toBe(MAX_ACTIVE_JOBS);

    const refused = await bounded.start({
      authority: authority(),
      descriptors: [{ path: "over.bin", size: 70_000 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.refusal.code).toBe("at-capacity");
    // No key was generated for the refused start: it cost nothing.
    expect(generated).toBe(MAX_ACTIVE_JOBS);

    for (const result of started) if (result.ok) await bounded.cancel(result.jobId);
  });

  it("unwinds the owned job when key generation throws", async () => {
    const server = new FakeServer();
    const broken = {
      ...runtime,
      generateKey: async () => {
        throw new Error("no entropy");
      },
    } as unknown as StoredRuntime;
    const svc = new StoredUploadService({
      secrets: new SecretStore(await tempDir(), passthrough),
      journalDirectory: await tempDir(),
      runtime: async () => broken,
      transportFactory: (auth) =>
        new UploadTransport(auth.origin, auth.bearer, { fetchImpl: server.fetch }),
    });
    const result = await svc.start({
      authority: authority(),
      descriptors: [{ path: "a.txt", size: 3 }],
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("internal");
    // The entry is gone: a registered job nothing would ever stop is exactly
    // what the synchronous registration must not leave behind.
    const inventory = await svc.inventory(ACCOUNT);
    expect(inventory.liveJobs).toEqual([]);
    expect(server.requests).toEqual([]);
  });
});

describe("auxiliary operations have a lifecycle too", () => {
  /** A service whose journal read for history parks, so an auxiliary operation
   *  can be caught between reading local state and using the bearer. */
  async function parkedHistory(server: FakeServer) {
    const secretsDir = await tempDir();
    const journalDir = await tempDir();
    const svc = new StoredUploadService({
      secrets: new SecretStore(secretsDir, passthrough),
      journalDirectory: journalDir,
      runtime: async () => runtime,
      transportFactory: (auth) =>
        new UploadTransport(auth.origin, auth.bearer, { fetchImpl: server.fetch }),
      sourceFactory: () => server.source(),
    });
    const journal = (svc as unknown as { journal: UploadJournal }).journal;
    const get = journal.get.bind(journal);
    let hold: Promise<void> | null = null;
    let release: (() => void) | null = null;
    let arrived: (() => void) | null = null;
    const at = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    (journal as unknown as { get: UploadJournal["get"] }).get = async (jobId) => {
      const record = await get(jobId);
      if (hold !== null) {
        arrived?.();
        await hold;
      }
      return record;
    };
    return {
      svc,
      secretsDir,
      park: () => {
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      arrived: at,
      release: () => release?.(),
    };
  }

  it("stops a delete parked after its journal read, before the bearer goes out", async () => {
    const server = new FakeServer();
    const harness = await parkedHistory(server);
    const { started, outcome } = await upload(harness.svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok || outcome?.status !== "published") return;
    const requestsBefore = server.requests.length;

    harness.park();
    const deleting = harness.svc.deleteObject(started.jobId, ACCOUNT, {
      origin: ORIGIN,
      bearer: "token-1",
    });
    await harness.arrived;
    // Visible while it runs, and account-scoped.
    expect((await harness.svc.inventory(ACCOUNT)).activeOperations).toHaveLength(1);
    expect((await harness.svc.inventory(OTHER_ACCOUNT)).activeOperations).toEqual([]);

    const reconciling = harness.svc.reconcileAccount({
      accountId: OTHER_ACCOUNT,
      deviceId: "dev-1",
    });
    harness.release();
    await expect(deleting).rejects.toThrow(/revoked/);
    await reconciling;
    // The old account's bearer never went out, and the object is untouched.
    expect(server.requests.length).toBe(requestsBefore);
    expect(server.objects.size).toBe(1);
    // Joined: nothing of the old account is still running.
    expect((await harness.svc.inventory(ACCOUNT)).activeOperations).toEqual([]);
  });

  it("stops a link parked after its journal read, before the key is read", async () => {
    const server = new FakeServer();
    const harness = await parkedHistory(server);
    const { started, outcome } = await upload(harness.svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok || outcome?.status !== "published") return;
    harness.park();
    const linking = harness.svc.linkFor(started.jobId, ACCOUNT, ORIGIN);
    await harness.arrived;
    const reconciling = harness.svc.reconcileAccount({
      accountId: OTHER_ACCOUNT,
      deviceId: "dev-1",
    });
    harness.release();
    // No link is produced for an account that has signed out.
    await expect(linking).rejects.toThrow(/revoked/);
    await reconciling;
  });

  it("honours a caller's own signal", async () => {
    const server = new FakeServer();
    const harness = await parkedHistory(server);
    const { started } = await upload(harness.svc, [{ path: "a.txt", data: bytes("abc") }]);
    if (!started.ok) return;
    const controller = new AbortController();
    harness.park();
    const linking = harness.svc.linkFor(started.jobId, ACCOUNT, ORIGIN, controller.signal);
    await harness.arrived;
    controller.abort();
    harness.release();
    await expect(linking).rejects.toThrow(/revoked/);
  });
});

describe("a finalize that is held", () => {
  it("is ambiguous when a revocation lands mid-finalize, and keeps the key", async () => {
    // Finalize is the one request whose interruption cannot be called "nothing
    // happened": the session may already be claimed.
    let releaseFinalize!: () => void;
    const parked = new Promise<void>((resolve) => {
      releaseFinalize = resolve;
    });
    let arrivedAt!: () => void;
    const arrived = new Promise<void>((resolve) => {
      arrivedAt = resolve;
    });
    const server = new FakeServer();
    const secretsDir = await tempDir();
    const svc = new StoredUploadService({
      secrets: new SecretStore(secretsDir, passthrough),
      journalDirectory: await tempDir(),
      runtime: async () => runtime,
      transportFactory: (auth) => {
        const transport = new UploadTransport(auth.origin, auth.bearer, { fetchImpl: server.fetch });
        const finalize = transport.finalize.bind(transport);
        (transport as unknown as { finalize: UploadTransport["finalize"] }).finalize = async (
          uploadId,
          signal,
        ) => {
          arrivedAt();
          await parked;
          if (signal?.aborted === true) {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
          }
          return finalize(uploadId, signal);
        };
        return transport;
      },
    });
    const picked: Picked[] = [{ path: "a.txt", data: bytes("abc") }];
    const start = await svc.start({
      authority: authority(),
      descriptors: picked.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) return;
    for (const frame of await produce(picked, start.contentKey, runtime.constants)) {
      await svc.feed(start.jobId, frame);
    }
    const ending = svc.end(start.jobId);
    await arrived;
    const revoking = svc.revokeDocument("doc-1");
    releaseFinalize();
    const [outcome] = await Promise.all([ending, revoking]);
    expect(outcome.status).toBe("ambiguous");
    expect((await svc.record(start.jobId))?.state).toBe("ambiguous");
    // The key is retained: the session may have been claimed, so an object may
    // exist and this key is the only thing that could ever open it.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(secretsDir)).filter((f) => f.startsWith("stored-upload-key-"))).toHaveLength(1);
  });
});

describe("the byte-engine seam", () => {
  it("drives the engine from a foreign structural transport", async () => {
    // The seam a second sender needs: the offset algebra, the retained replay
    // window and the frame schedule are reused, while `init` — the only call
    // that decides what an object IS — belongs to the implementer. This fake
    // is not a `UploadTransport` and has none of its private state.
    const sent: string[] = [];
    let received = 0;
    const foreign: UploadByteTransport = {
      init: async (sealedManifest, retention, declared) => {
        sent.push(`init:${String(sealedManifest.byteLength)}:${String(declared)}:${String(retention.ttlSeconds)}`);
        return { uploadId: "foreign01", chunkSize: 64 * 1024 };
      },
      append: async (uploadId, from, total, bytes) => {
        sent.push(`append:${uploadId}:${String(from)}/${String(total)}:${String(bytes.byteLength)}`);
        // A partial commit, so the replay path is exercised through the seam.
        received = from + Math.min(bytes.byteLength, 1_000);
        return { outcome: "committed", received };
      },
      status: async () => ({ received }),
      finalize: async () => ({ outcome: "finalized", id: "foreignobj", expiresAt: 5 }),
    };
    const picked: Picked[] = [
      { path: "a.bin", data: new Uint8Array(3_000).fill(1) },
      { path: "empty.txt", data: new Uint8Array(0) },
      { path: "b.txt", data: bytes("tail") },
    ];
    const planned = planUpload(
      picked.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
      runtime.constants,
    );
    if (!planned.ok) return;
    const generated = await runtime.generateKey();
    const sealed = await runtime.sealManifest(generated.key, { files: planned.plan.manifest });
    const engine = await UploadEngine.open({
      runtime,
      key: generated.key,
      sealedManifest: sealed,
      plan: planned.plan,
      retention: { burnAfterRead: false, ttlSeconds: 60 },
      transport: foreign,
      fence: new Fence(captureAuthority(authority())),
    });
    for (const frame of await produce(picked, generated.encoded, runtime.constants)) {
      await engine.feed(frame);
    }
    const outcome = await engine.end();
    expect(outcome).toEqual({ status: "published", objectId: "foreignobj", expiresAt: 5 });
    // The engine did the chunking and the replay; the transport only answered.
    expect(sent[0]).toBe(`init:${String(sealed.byteLength)}:${String(planned.plan.cipherBytes)}:60`);
    expect(sent.filter((entry) => entry.startsWith("append:")).length).toBeGreaterThan(1);
  });

  it("classifies a foreign transport's UploadTransportError like its own", async () => {
    const foreign: UploadByteTransport = {
      init: async () => {
        throw new StoredUploadTransportError("http", 503);
      },
      append: async () => ({ outcome: "committed", received: 0 }),
      status: async () => "gone",
      finalize: async () => ({ outcome: "already-finalized" }),
    };
    const planned = planUpload([{ path: "a.txt", size: 3 }], runtime.constants);
    if (!planned.ok) return;
    const generated = await runtime.generateKey();
    const sealed = await runtime.sealManifest(generated.key, { files: planned.plan.manifest });
    // The closed error set is the contract: a foreign shape would arrive as
    // `internal` instead.
    await expect(
      UploadEngine.open({
        runtime,
        key: generated.key,
        sealedManifest: sealed,
        plan: planned.plan,
        retention: { burnAfterRead: false, ttlSeconds: 60 },
        transport: foreign,
        fence: new Fence(captureAuthority(authority())),
      }),
    ).rejects.toMatchObject({ code: "http", status: 503 });
  });
});

describe("empty entries in every position", () => {
  // The cursor bug this section exists for: it started on file 0 and only
  // skipped zero-byte files AFTER a frame had been consumed, so a manifest
  // whose FIRST entry was empty answered `expects === null` — "nothing is
  // owed" — while the next file's frame was still required. Every case below
  // uses the real shared encoder, so the frame the plan expects is the frame
  // `encryptFiles` actually emits.
  const cases: readonly (readonly [string, () => Picked[]])[] = [
    [
      "a leading empty file",
      () => [
        { path: "a-empty.txt", data: new Uint8Array(0) },
        { path: "b-data.txt", data: bytes("x") },
      ],
    ],
    [
      "several empties before the first real file",
      () => [
        { path: "e1.txt", data: new Uint8Array(0) },
        { path: "folder/e2.txt", data: new Uint8Array(0) },
        { path: "folder/e3.txt", data: new Uint8Array(0) },
        { path: "real.bin", data: bytes("hello world") },
      ],
    ],
    [
      "empties at both ends and in the middle",
      () => [
        { path: "lead.txt", data: new Uint8Array(0) },
        { path: "one.txt", data: bytes("abc") },
        { path: "mid.txt", data: new Uint8Array(0) },
        { path: "two.txt", data: bytes("de") },
        { path: "tail.txt", data: new Uint8Array(0) },
      ],
    ],
    [
      "a leading empty before a MULTI-frame file",
      () => [
        { path: "lead.txt", data: new Uint8Array(0) },
        { path: "big.bin", data: new Uint8Array(runtime.constants.storeChunkSize + 9).fill(4) },
      ],
    ],
  ];

  for (const [what, build] of cases) {
    it(`uploads and decrypts with ${what}`, async () => {
      const picked = build();
      const server = new FakeServer({ chunkSize: 64 * 1024 });
      const { svc } = await service(server);
      const start = await svc.start({
        authority: authority(),
        descriptors: picked.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
        retention: { burnAfterRead: false, ttlSeconds: 60 },
      });
      expect(start.ok).toBe(true);
      if (!start.ok) return;
      const frames = await produce(picked, start.contentKey, runtime.constants);
      // The FIRST expectation must name the first file that owes a frame, and
      // the global sequence must start at 1 whichever file that is.
      expect(start.expects).toEqual({
        fileIndex: frames[0]?.fileIndex,
        seq: 1,
        bytes: frames[0]?.bytes.byteLength,
      });
      for (const frame of frames) await svc.feed(start.jobId, frame);
      expect(svc.expects(start.jobId)).toBeNull();
      const outcome = await svc.end(start.jobId);
      expect(outcome.status).toBe("published");

      // And the object opens: the manifest keeps every entry, empties included,
      // and the plaintext splits back to the exact bytes.
      const object = [...server.objects.values()][0];
      const key = await runtime.importKeyFromFragment(start.contentKey);
      const manifest = await runtime.decryptManifest(
        key,
        new Uint8Array(Buffer.from(object?.encManifest ?? "", "base64")),
      );
      expect(manifest.files).toEqual(
        picked.map((entry) => ({ name: entry.path, size: entry.data.byteLength })),
      );
      const decryptor = runtime.createDecryptor(key);
      const parts: Uint8Array[] = [];
      for await (const part of decryptor.push(object?.blob ?? new Uint8Array())) parts.push(part);
      const total = picked.reduce((n, entry) => n + entry.data.byteLength, 0);
      for await (const part of decryptor.end(total)) parts.push(part);
      const stream = concat(parts);
      let at = 0;
      for (const entry of picked) {
        expect(
          Buffer.from(stream.subarray(at, at + entry.data.byteLength)),
          entry.path,
        ).toEqual(Buffer.from(entry.data));
        at += entry.data.byteLength;
      }
      expect(at).toBe(stream.byteLength);
    });
  }

  it("publishes a manifest of nothing but empty files", async () => {
    // No frames at all: the cursor settles past the end at construction, so
    // `expects` is null from the start and `end()` is not a short producer.
    const picked: Picked[] = [
      { path: "a.txt", data: new Uint8Array(0) },
      { path: "b/c.txt", data: new Uint8Array(0) },
      { path: "b/d.txt", data: new Uint8Array(0) },
    ];
    const server = new FakeServer();
    const { svc } = await service(server);
    const start = await svc.start({
      authority: authority(),
      descriptors: picked.map((entry) => ({ path: entry.path, size: entry.data.byteLength })),
      retention: { burnAfterRead: false, ttlSeconds: 60 },
    });
    if (!start.ok) return;
    expect(start.cipherBytes).toBe(0);
    expect(start.expects).toBeNull();
    const outcome = await svc.end(start.jobId);
    expect(outcome.status).toBe("published");
    // No PATCH at all — there were no bytes to send.
    expect(server.requests).toEqual(["POST /api/uploads", "POST /api/uploads/up0001/finalize"]);
    const object = [...server.objects.values()][0];
    const key = await runtime.importKeyFromFragment(start.contentKey);
    const manifest = await runtime.decryptManifest(
      key,
      new Uint8Array(Buffer.from(object?.encManifest ?? "", "base64")),
    );
    expect(manifest.files).toEqual(picked.map((entry) => ({ name: entry.path, size: 0 })));
  });
});
