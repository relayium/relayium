// The receive path against the REAL NativeHelperClient.
//
// ## Why this exists next to `stored-receive.test.ts`
//
// That suite injects a destination, which proves the orchestration. It cannot
// prove that the accepted client accepts what this module actually sends: the
// client checks the helper's cumulative byte count against its own, requires
// `begin` before a chunk, bounds a chunk at 256 KiB, refuses an index outside
// the manifest, and validates every publish receipt before it will call
// anything saved. A structural fake agrees with all of that by construction.
//
// So here the destination is `NativeHelperClient.open` — the production factory
// — and what is faked is one layer lower: the child process, speaking the real
// wire (`native/internal/wire`) over stdio. The helper cannot run on this
// machine, so the Windows side of that protocol is proven by its own Go suite
// and by the integrated CI; what is proven here is that the two halves this
// process owns fit together.
//
// The ciphertext is real, from `web/src/lib/store-crypto.ts`.
import { describe, expect, it } from "vitest";

import {
  NativeHelperClient,
  type HelperChild,
} from "../../src/main/io/native-helper-client.js";
import { CleanupRegistry } from "../../src/main/stored/cleanup.js";
import type { DestinationAuthority, DestinationGrant } from "../../src/main/stored/receive.js";
import { receiveStoredLink } from "../../src/main/stored/receive.js";
import type { StoredRuntime } from "../../src/main/stored/runtime-contract.js";
import { resetStoredRuntimeForTest, storedRuntime } from "../../src/main/stored/runtime.js";
import type { StoredBlobBody, StoredObjectMeta, StoredObjectSource } from "../../src/main/stored/transport.js";
import { encodeKey, encryptFiles, encryptManifest, generateStoreKey } from "../../../../web/src/lib/store-crypto";

const ARTIFACT = new URL("../../dist/main/stored-runtime.js", import.meta.url);
const ID = "abc123";
const GRANT: DestinationGrant = { rootPath: "C:\\Users\\someone\\Downloads", authorityId: "auth-1" };
const FAST = { startupMs: 200, requestMs: 200, publishMs: 200, cancelExitMs: 200, closeAfterExitMs: 50 };

async function runtime(): Promise<StoredRuntime> {
  resetStoredRuntimeForTest();
  return storedRuntime(async () => (await import(ARTIFACT.href)) as { default?: unknown });
}

// ---------------------------------------------------------------------------
// The wire, from the host's point of view. Mirrors `native/internal/wire`.
// ---------------------------------------------------------------------------

const KIND_REQUEST = 1;
const KIND_CHUNK = 2;
const KIND_RESPONSE = 3;
const KIND_EVENT = 4;

function frame(kind: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, payload.byteLength + 1, false);
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/**
 * A scripted helper process.
 *
 * It DECODES what the host sends, so the assertions are about the actual bytes
 * on the wire, and it answers the way `serve.go` does — including the
 * cumulative `written` accounting the client cross-checks, which is what makes
 * a host that miscounts a test failure rather than a silent short write.
 */
class FakeHelper implements HelperChild {
  readonly ops: string[] = [];
  stdinEnded = false;
  killCount = 0;
  /** Replace the publish answer. */
  publishAs: ((id: number, files: number) => unknown) | null = null;

  private stdoutListeners: Array<(chunk: Uint8Array) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private closeListeners: Array<() => void> = [];
  private inbound = new Uint8Array(0);
  private manifest: { name: string; size: number }[] = [];
  private written = new Map<number, number>();

  readonly stdin = {
    write: (chunk: Uint8Array): boolean => {
      this.consume(chunk);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
      // `Serve` exits on EOF, not on publish. Exit precedes close.
      this.exit(0);
    },
  };

  readonly stdout = {
    on: (_event: "data", listener: (chunk: Uint8Array) => void): unknown => {
      this.stdoutListeners.push(listener);
      return this;
    },
  };

  readonly stderr = { on: (): unknown => this };

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  onError(): void {
    /* never errors */
  }

  kill(): boolean {
    this.killCount += 1;
    this.exit(null);
    return true;
  }

  ready(): void {
    this.emit(frame(KIND_EVENT, encode({ event: "ready", protocol: 1 })));
  }

  private exit(code: number | null): void {
    for (const listener of this.exitListeners) listener(code, null);
    for (const listener of this.closeListeners) listener();
  }

  private emit(bytes: Uint8Array): void {
    for (const listener of this.stdoutListeners) listener(bytes);
  }

  private reply(value: unknown): void {
    this.emit(frame(KIND_RESPONSE, encode(value)));
  }

  private consume(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.inbound.byteLength + chunk.byteLength);
    merged.set(this.inbound);
    merged.set(chunk, this.inbound.byteLength);
    this.inbound = merged;
    for (;;) {
      if (this.inbound.byteLength < 5) return;
      const length = new DataView(this.inbound.buffer, this.inbound.byteOffset).getUint32(0, false);
      if (this.inbound.byteLength < 4 + length) return;
      const kind = this.inbound[4] ?? 0;
      const payload = this.inbound.slice(5, 4 + length);
      this.inbound = this.inbound.slice(4 + length);
      this.dispatch(kind, payload);
    }
  }

  private dispatch(kind: number, payload: Uint8Array): void {
    if (kind === KIND_CHUNK) {
      const view = new DataView(payload.buffer, payload.byteOffset);
      const id = Number(view.getBigUint64(0, false));
      const index = view.getUint32(8, false);
      const data = payload.byteLength - 12;
      const total = (this.written.get(index) ?? 0) + data;
      this.written.set(index, total);
      this.ops.push(`chunk:${String(index)}:${String(data)}`);
      // Cumulative, as `serve.go` reports it — the number the client compares
      // against its own count.
      this.reply({ id, ok: true, result: { written: total, declared: this.manifest[index]?.size ?? 0 } });
      return;
    }
    if (kind !== KIND_REQUEST) return;
    const request = JSON.parse(new TextDecoder().decode(payload)) as {
      id: number;
      op: string;
      index?: number;
      root?: string;
      manifest?: { name: string; size: number }[];
    };
    switch (request.op) {
      case "open":
        this.manifest = request.manifest ?? [];
        this.ops.push(`open:${String(request.root)}:${this.manifest.map((f) => f.name).join(",")}`);
        this.reply({
          id: request.id,
          ok: true,
          result: { files: this.manifest.length, directories: 0, longPath: false },
        });
        return;
      case "begin":
        this.ops.push(`begin:${String(request.index)}`);
        this.reply({ id: request.id, ok: true, result: {} });
        return;
      case "finish": {
        const index = request.index ?? 0;
        this.ops.push(`finish:${String(index)}`);
        this.reply({ id: request.id, ok: true, result: { bytes: this.written.get(index) ?? 0 } });
        return;
      }
      case "publish":
        this.ops.push("publish");
        this.reply(
          this.publishAs?.(request.id, this.manifest.length) ?? {
            id: request.id,
            ok: true,
            result: { status: "complete", publishedCount: this.manifest.length, total: this.manifest.length },
          },
        );
        return;
      case "cancel":
        this.ops.push("cancel");
        this.reply({ id: request.id, ok: true, result: { removedFiles: 0, residue: false } });
        this.exit(0);
        return;
      default:
        return;
    }
  }
}

// ---------------------------------------------------------------------------

interface Sealed {
  readonly link: string;
  readonly meta: StoredObjectMeta;
  readonly stream: Uint8Array;
}

async function seal(files: readonly { name: string; data: Uint8Array }[]): Promise<Sealed> {
  const key = await generateStoreKey();
  const manifest = { files: files.map((file) => ({ name: file.name, size: file.data.byteLength })) };
  const sealedManifest = await encryptManifest(key.key, manifest);
  const frames: Uint8Array[] = [];
  for await (const part of encryptFiles(
    files.map((file) => new File([file.data as BlobPart], file.name)),
    key.key,
  )) {
    frames.push(part);
  }
  const total = frames.reduce((n, part) => n + part.byteLength, 0);
  const stream = new Uint8Array(total);
  let at = 0;
  for (const part of frames) {
    stream.set(part, at);
    at += part.byteLength;
  }
  return {
    link: `relayium://d/${ID}#k=${encodeKey(key.raw)}`,
    meta: {
      encManifest: Buffer.from(sealedManifest).toString("base64"),
      size: total,
      burnAfterRead: false,
      expiresAt: 1_800_000_000,
    },
    stream,
  };
}

class OneObjectSource implements StoredObjectSource {
  constructor(
    private readonly object: Sealed,
    private readonly chunk = Number.POSITIVE_INFINITY,
  ) {}

  async meta(): Promise<StoredObjectMeta> {
    return this.object.meta;
  }

  async blob(): Promise<StoredBlobBody> {
    let at = 0;
    const size = Number.isFinite(this.chunk) ? this.chunk : this.object.stream.byteLength;
    return {
      read: async (): Promise<Uint8Array | null> => {
        if (at >= this.object.stream.byteLength) return null;
        const next = this.object.stream.subarray(at, at + size);
        at += next.byteLength;
        return next;
      },
      close: async (): Promise<void> => undefined,
    };
  }
}

const authority: DestinationAuthority = { grant: async () => GRANT };

/** One receive whose destination is the real client over a fake child. */
async function receiveThroughHelper(
  object: Sealed,
  helper: FakeHelper,
  options: { readonly stream?: Uint8Array; readonly chunk?: number } = {},
): Promise<Awaited<ReturnType<typeof receiveStoredLink>>> {
  const loaded = await runtime();
  const source = new OneObjectSource(
    options.stream ? { ...object, stream: options.stream } : object,
    options.chunk,
  );
  return receiveStoredLink({
    link: object.link,
    authority,
    transport: source,
    runtime: async () => loaded,
    cleanups: new CleanupRegistry(),
    destination: async (request) => {
      const opening = NativeHelperClient.open({
        authorityId: request.authorityId,
        rootPath: request.rootPath,
        manifest: request.manifest,
        spawnHelper: () => helper,
        deadlines: FAST,
      });
      // The client requires the `ready` event before it will send `open`.
      helper.ready();
      return opening;
    },
  });
}

describe("the real client, over the real wire", () => {
  it("opens, stages by index, publishes, and closes the lease", async () => {
    const object = await seal([
      { name: "hello.txt", data: new TextEncoder().encode("hello world") },
      { name: "sub/xyz.bin", data: new TextEncoder().encode("xyz") },
    ]);
    const helper = new FakeHelper();
    const report = await receiveThroughHelper(object, helper);
    expect(report.status).toBe("saved");
    if (report.status !== "saved") return;
    expect(report.publishedCount).toBe(2);
    expect(report.residue).toBe(false);
    // The root came from the grant, and the names are the validated manifest's.
    expect(helper.ops).toEqual([
      `open:${GRANT.rootPath}:hello.txt,sub/xyz.bin`,
      "begin:0",
      "chunk:0:11",
      "finish:0",
      "begin:1",
      "chunk:1:3",
      "finish:1",
      "publish",
    ]);
    // Publication closes the lease: stdin is ended and the exit joined, so no
    // child process is leaked per transfer.
    expect(helper.stdinEnded).toBe(true);
    expect(helper.killCount).toBe(0);
  });

  it("creates trailing empty files through the real client", async () => {
    const object = await seal([
      { name: "a.txt", data: new TextEncoder().encode("abc") },
      { name: "empty.txt", data: new Uint8Array(0) },
    ]);
    const helper = new FakeHelper();
    const report = await receiveThroughHelper(object, helper);
    expect(report.status).toBe("saved");
    // `begin` then `finish` with no chunk between them: the client's finish
    // check compares the helper's byte count against the declared 0.
    expect(helper.ops).toEqual([
      "open:C:\\Users\\someone\\Downloads:a.txt,empty.txt",
      "begin:0",
      "chunk:0:3",
      "finish:0",
      "begin:1",
      "finish:1",
      "publish",
    ]);
  });

  it("survives a body delivered in one-byte reads", async () => {
    const object = await seal([{ name: "a.txt", data: new TextEncoder().encode("hello world") }]);
    const helper = new FakeHelper();
    const report = await receiveThroughHelper(object, helper, { chunk: 1 });
    expect(report.status).toBe("saved");
    // One plaintext frame, so one chunk on the wire however finely the network
    // delivered it.
    expect(helper.ops).toContain("chunk:0:11");
  });

  it("maps a validated partial receipt to a preserved prefix", async () => {
    const object = await seal([
      { name: "a.txt", data: new TextEncoder().encode("abc") },
      { name: "b.txt", data: new TextEncoder().encode("de") },
    ]);
    const helper = new FakeHelper();
    // Exactly the shape `serve.go` sends: ok:false with the partial code and a
    // receipt whose every field corroborates the prefix claim.
    helper.publishAs = (id, files) => ({
      id,
      ok: false,
      code: "E_PARTIAL_PUBLICATION",
      result: {
        status: "partial",
        publishedCount: 1,
        total: files,
        failed: { index: 1, code: "E_EXISTS" },
        unattempted: { from: 2, to: files - 1 },
      },
    });
    const report = await receiveThroughHelper(object, helper);
    expect(report.status).toBe("partially-saved");
    if (report.status !== "partially-saved") return;
    expect(report).toMatchObject({ publishedCount: 1, total: 2, failedIndex: 1, reason: "E_EXISTS" });
  });

  it("refuses a receipt that contradicts itself, rather than reporting a save", async () => {
    const object = await seal([
      { name: "a.txt", data: new TextEncoder().encode("abc") },
      { name: "b.txt", data: new TextEncoder().encode("de") },
    ]);
    const helper = new FakeHelper();
    // Claims two files published while naming file one as the failure. Both
    // cannot be true: publication runs in manifest order and stops at the first
    // failure.
    helper.publishAs = (id, files) => ({
      id,
      ok: false,
      code: "E_PARTIAL_PUBLICATION",
      result: { status: "partial", publishedCount: 2, total: files, failed: { index: 1, code: "E_EXISTS" } },
    });
    const report = await receiveThroughHelper(object, helper);
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("publish-failed");
  });

  it("cancels the real lease on a tampered stream and never publishes", async () => {
    const object = await seal([{ name: "a.txt", data: new TextEncoder().encode("hello world") }]);
    const tampered = object.stream.slice();
    tampered[6] = (tampered[6] ?? 0) ^ 0x01;
    const helper = new FakeHelper();
    const report = await receiveThroughHelper(object, helper, { stream: tampered });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    expect(report.failure.residue).toBe(false);
    expect(helper.ops).toContain("cancel");
    expect(helper.ops).not.toContain("publish");
  });

  it("cancels the real lease when the manifest and the stream disagree", async () => {
    const object = await seal([
      { name: "a.txt", data: new TextEncoder().encode("hello world") },
      { name: "b.txt", data: new TextEncoder().encode("xyz") },
    ]);
    const helper = new FakeHelper();
    // The second frame never arrives, and nothing about the bytes says so.
    const report = await receiveThroughHelper(object, helper, {
      stream: object.stream.subarray(0, 4 + 11 + 16),
    });
    expect(report.status).toBe("failed");
    if (report.status !== "failed") return;
    expect(report.failure.code).toBe("integrity");
    // The first file was staged and finished, and staging is not saving.
    expect(helper.ops).toContain("finish:0");
    expect(helper.ops).toContain("cancel");
    expect(helper.ops).not.toContain("publish");
  });
});
