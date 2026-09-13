// The bytes that leave this app, decrypted back to the bytes the user picked.
//
// SCOPE: the REAL producer — `web/src/lib/store-crypto.ts`'s own `encryptFiles`,
// the exact function the Web sender runs — driven exactly as the renderer
// drives it, through the REAL `StoredUploadService`, into a CONTROLLED
// IN-MEMORY transport. The ciphertext is then opened with the shared Web
// `StoreDecryptor` and compared to the plaintext.
//
// ## What this is NOT
//
// There is no server here. `inMemoryTransport()` implements the transport
// interface and keeps bytes in a variable — no `createServer`, no `listen`, no
// HTTP. So this proves the PRODUCER and the ENGINE, and it proves nothing about
// the remote handler or the protocol as a server actually answers it. Real
// server acceptance is owed separately and is not claimed by any assertion
// below.
//
// ## Why this test rather than a shape assertion
//
// "The frames look like frames" is satisfied by any encoder, including a second
// one that disagrees about the nonce schedule. What must be true is stronger
// and only checkable end to end: the object this client uploads is one the
// shared Web `StoreDecryptor` opens. A byte-for-byte round trip is the only
// assertion that says so.
//
// That is a WIRE-COMPATIBILITY statement about this JS module, and deliberately
// not a claim about the Mac: the Mac receiver is an independent Swift
// implementation of the same wire format, not this code, and nothing here
// exercises it.
//
// Nothing here re-implements the format. There is no second encoder, no second
// nonce schedule, and no hand-built frame anywhere in this file.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  StoreDecryptor,
  decodeKey,
  decryptManifest,
  encryptFiles,
  importStoreKey,
} from "../../../../web/src/lib/store-crypto";
import { StoredUploadService } from "../../src/main/stored/upload/service.js";
import type {
  AppendReceipt,
  FinalizeReceipt,
  InitReceipt,
  UploadRetention,
} from "../../src/main/stored/upload/transport.js";
import { SecretStore, type SecretCipher } from "../../src/main/secrets.js";
import { storedRuntime, resetStoredRuntimeForTest } from "../../src/main/stored/runtime.js";
import type { StoredRuntime } from "../../src/main/stored/runtime-contract.js";

/**
 * The REAL built bundle, loaded by its artifact path.
 *
 * The default loader resolves relative to the COMPILED module — correct in
 * `dist/`, and pointing at a file that does not exist when the suite runs from
 * `src/`. Injected here for that reason and no other: this is the same shared
 * code the app loads, not a substitute for it.
 */
async function realRuntime(): Promise<StoredRuntime> {
  resetStoredRuntimeForTest();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const artifact = pathToFileURL(resolve(process.cwd(), "dist/main/stored-runtime.js")).href;
  return storedRuntime(() => import(artifact) as Promise<{ default?: unknown }>);
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "send-ciphertext-"));
  roots.push(root);
  return root;
}

/** Reversible and task-owned. The store's contents are not what is under test. */
const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, "utf8"),
  decrypt: (sealed) => sealed.toString("utf8"),
};

/**
 * A controlled in-memory transport that keeps every byte it is given, in order.
 *
 * Deliberately not a mock that records calls — the assertions are about the
 * BYTES, so it has to actually hold them — and deliberately not a server: it is
 * an object implementing the transport interface, with no socket and no HTTP.
 * It follows the real endpoint's OFFSET RULE (a write must begin where it
 * holds) because that is what makes the engine's offset algebra observable
 * here, not because it stands in for the endpoint's behaviour generally.
 */
function inMemoryTransport() {
  const held: { manifest: Uint8Array; body: Uint8Array; finalized: boolean } = {
    manifest: new Uint8Array(0),
    body: new Uint8Array(0),
    finalized: false,
  };
  const transport = {
    async init(
      sealedManifest: Uint8Array,
      _retention: UploadRetention,
      _declared: number,
    ): Promise<InitReceipt> {
      held.manifest = new Uint8Array(sealedManifest);
      return { uploadId: "upload-1", chunkSize: 1 << 20 };
    },
    async append(_id: string, from: number, _total: number, bytes: Uint8Array): Promise<AppendReceipt> {
      // The held offset is authoritative; a write that does not begin exactly
      // where it holds is refused. That is the rule the engine's offset algebra
      // is checked against here.
      if (from !== held.body.byteLength) {
        return { outcome: "offset", received: held.body.byteLength };
      }
      const next = new Uint8Array(held.body.byteLength + bytes.byteLength);
      next.set(held.body);
      next.set(bytes, held.body.byteLength);
      held.body = next;
      return { outcome: "committed", received: held.body.byteLength };
    },
    async status(): Promise<{ received: number }> {
      return { received: held.body.byteLength };
    },
    async finalize(): Promise<FinalizeReceipt> {
      if (held.finalized) return { outcome: "already-finalized" };
      held.finalized = true;
      return { outcome: "finalized", id: "object-1", expiresAt: 4_000_000_000 };
    },
  };
  return { held, transport };
}

async function serviceOn(root: string, transport: ReturnType<typeof inMemoryTransport>["transport"]) {
  return new StoredUploadService({
    secrets: new SecretStore(join(root, "secrets"), cipher),
    journalDirectory: join(root, "uploads"),
    transportFactory: () => transport as never,
    runtime: realRuntime,
  });
}

const AUTHORITY = {
  accountId: "device-row-1",
  deviceId: "device-row-1",
  documentId: "1",
  origin: "https://relayium.com",
  bearer: "bearer-value",
};

/** Read every plaintext byte back out of the frames the producer emitted. */
async function decryptBody(key: CryptoKey, body: Uint8Array, expected: number): Promise<Uint8Array> {
  const decryptor = new StoreDecryptor(key);
  const out: Uint8Array[] = [];
  for await (const piece of decryptor.push(body)) out.push(piece);
  for await (const piece of decryptor.end(expected)) out.push(piece);
  return Buffer.concat(out);
}

describe("the ciphertext this client actually uploads", () => {
  it("is opened by the shared Web decryptor, byte for byte", async () => {
    const root = await tempRoot();
    const { held, transport } = inMemoryTransport();
    const service = await serviceOn(root, transport);

    // Two files, one of them larger than a chunk, so the object spans several
    // frames and the sequence numbering is genuinely exercised.
    const first = new Uint8Array(300 * 1024);
    for (let i = 0; i < first.length; i += 1) first[i] = (i * 7) % 251;
    const second = new TextEncoder().encode("the second file, short");
    const files = [
      new File([first], "big.bin"),
      new File([second], "notes/second.txt"),
    ];

    const started = await service.start({
      authority: AUTHORITY,
      // The SAME array, in the same order, that the producer walks below.
      descriptors: files.map((file) => ({ path: file.name, size: file.size })),
      retention: { burnAfterRead: false, ttlSeconds: 7 * 24 * 60 * 60 },
    });
    // The refusal is spelled into the failure message: a bare `false` here says
    // nothing about which of eleven codes it was.
    expect(started.ok ? "ok" : JSON.stringify(started.refusal)).toBe("ok");
    if (!started.ok) return;

    // ---- the renderer's half, run exactly as the controller runs it --------
    const key = await importStoreKey(decodeKey(started.contentKey));
    let expects = started.expects;
    for await (const bytes of encryptFiles(files, key)) {
      expect(expects).not.toBeNull();
      if (expects === null) break;
      // The engine checks this against its own plan: a frame of the wrong
      // length, sequence or file index is refused rather than uploaded.
      expect(bytes.byteLength).toBe(expects.bytes);
      const answer = await service.feed(started.jobId, {
        fileIndex: expects.fileIndex,
        seq: expects.seq,
        bytes,
      });
      expects = answer.expects;
    }
    expect(expects).toBeNull();

    const outcome = await service.end(started.jobId);
    expect(outcome.status).toBe("published");

    // ---- what the transport ended up holding -------------------------------
    expect(held.body.byteLength).toBe(started.cipherBytes);

    // The manifest frame opens with the SHARED parser and names the files.
    const manifest = await decryptManifest(key, held.manifest);
    expect(manifest.files.map((entry) => entry.name)).toEqual(["big.bin", "notes/second.txt"]);
    expect(manifest.files.map((entry) => entry.size)).toEqual([first.length, second.length]);

    // And the body decrypts to exactly the bytes that were picked, in order.
    const plaintext = await decryptBody(key, held.body, first.length + second.length);
    expect(plaintext.byteLength).toBe(first.length + second.length);
    expect(Buffer.from(plaintext.subarray(0, first.length)).equals(Buffer.from(first))).toBe(true);
    expect(Buffer.from(plaintext.subarray(first.length)).equals(Buffer.from(second))).toBe(true);
  });

  it("gives a re-picked send a different key, never the same one twice", async () => {
    // AES-GCM under a repeated nonce with DIFFERENT plaintext is a break rather
    // than a bug, and the nonce schedule restarts at 1 for every job. So two
    // jobs must never share a key — which is a property of the engine, and this
    // is the assertion that it holds through the surface the renderer uses.
    const root = await tempRoot();
    const { transport } = inMemoryTransport();
    const service = await serviceOn(root, transport);
    const files = [new File([new Uint8Array(16)], "a.bin")];
    const descriptors = files.map((file) => ({ path: file.name, size: file.size }));

    const first = await service.start({
      authority: AUTHORITY,
      descriptors,
      retention: { burnAfterRead: false, ttlSeconds: 86_400 },
    });
    const second = await service.start({
      authority: AUTHORITY,
      descriptors,
      retention: { burnAfterRead: false, ttlSeconds: 86_400 },
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.contentKey).not.toBe(second.contentKey);
    expect(first.jobId).not.toBe(second.jobId);
  });

  it("refuses a frame that does not match the plan", async () => {
    // The producer and the planner are in different processes, so a drift
    // between them has to be caught rather than handed on. A truncated frame is
    // the cheapest way to prove the check is live.
    const root = await tempRoot();
    const { held, transport } = inMemoryTransport();
    const service = await serviceOn(root, transport);
    const files = [new File([new Uint8Array(64)], "a.bin")];

    const started = await service.start({
      authority: AUTHORITY,
      descriptors: files.map((file) => ({ path: file.name, size: file.size })),
      retention: { burnAfterRead: false, ttlSeconds: 86_400 },
    });
    expect(started.ok).toBe(true);
    if (!started.ok || started.expects === null) return;

    const key = await importStoreKey(decodeKey(started.contentKey));
    let real: Uint8Array | null = null;
    for await (const bytes of encryptFiles(files, key)) {
      real = bytes;
      break;
    }
    expect(real).not.toBeNull();
    if (real === null) return;

    await expect(
      service.feed(started.jobId, {
        fileIndex: started.expects.fileIndex,
        seq: started.expects.seq,
        bytes: real.subarray(0, real.byteLength - 1),
      }),
    ).rejects.toBeTruthy();
    // Nothing of a refused frame was handed on.
    expect(held.body.byteLength).toBe(0);
  });
});
