// Conformance of the BUILT artifact against the runtime contract.
//
// ## Why this test is not redundant with the `satisfies` in the entry
//
// Two different failures, and each check catches only one:
//
//  - `satisfies InboxRuntime` in `build/inbox-runtime.entry.ts`, verified by
//    `tsconfig.inbox.json`, catches a SHAPE drift at compile time. Vite only
//    transpiles, so without that typecheck a mismatched entry emits happily.
//  - This test catches an artifact that typechecks but does not LOAD or RUN —
//    a bad external, a missing export, a crypto path that fails under Node.
//
// A runtime arity check is not type proof, and a compile-time `satisfies` is not
// proof the artifact works. Both exist on purpose.
//
// The artifact is built by `pretest`, so it is present whenever this runs.
import { describe, expect, it } from "vitest";

import {
  artifactURL,
  inboxRuntime,
  resetInboxRuntimeForTest,
  InboxRuntimeUnavailableError,
} from "../../src/main/inbox/runtime.js";
import type { InboxRuntime } from "../../src/main/inbox/runtime-contract.js";

/** Load the real built artifact by explicit path. */
async function builtRuntime(): Promise<InboxRuntime> {
  resetInboxRuntimeForTest();
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const artifact = pathToFileURL(resolve(process.cwd(), "dist/main/inbox-runtime.js")).href;
  return inboxRuntime(() => import(artifact) as Promise<{ default?: unknown }>);
}

describe("inbox runtime artifact location", () => {
  it("resolves one directory UP from the compiled module, not beside it", () => {
    // dist/main/inbox/runtime.js -> dist/main/inbox-runtime.js
    const compiled = new URL("file:///app/dist/main/inbox/runtime.js");
    expect(artifactURL(compiled).href).toBe("file:///app/dist/main/inbox-runtime.js");
    // The mistake this pins: `./` would have looked inside dist/main/inbox/.
    expect(artifactURL(compiled).href).not.toBe("file:///app/dist/main/inbox/inbox-runtime.js");
  });
});

describe("built artifact conformance", () => {
  it("reports a usable failure when the artifact cannot be loaded", async () => {
    resetInboxRuntimeForTest();
    const failing = inboxRuntime(() => Promise.reject(new Error("ENOENT")));
    await expect(failing).rejects.toBeInstanceOf(InboxRuntimeUnavailableError);
    // Names the artifact and the build script, never a resolved install path.
    await failing.catch((error: unknown) => {
      const message = (error as Error).message;
      expect(message).toContain("../inbox-runtime.js");
      expect(message).toContain("build:inbox");
      expect(message).not.toContain(process.cwd());
    });
  });

  it("refuses an artifact with no default export", async () => {
    resetInboxRuntimeForTest();
    await expect(inboxRuntime(() => Promise.resolve({}))).rejects.toBeInstanceOf(
      InboxRuntimeUnavailableError,
    );
  });

  it("is retryable after a failed load", async () => {
    resetInboxRuntimeForTest();
    await expect(inboxRuntime(() => Promise.reject(new Error("transient")))).rejects.toThrow();
    // A memoised rejection would make the retry fail identically.
    const runtime = await builtRuntime();
    expect(runtime.constants.protocolVersion).toBe(3);
  });

  it("carries every wire constant the contract declares", async () => {
    const r = await builtRuntime();
    expect(r.constants).toMatchObject({
      manifestVersion: 3,
      protocolVersion: 3,
      capReceiveV3: "inbox.receive.v3",
      capTextV1: "inbox.text.v1",
      keyAlgorithm: "x25519-sealedbox-v1",
      sealedBoxBytes: 80,
      contentKeyBytes: 32,
      publicKeyBytes: 32,
    });
    // Sanity on the framing numbers rather than restating them: a chunk plus its
    // overhead must be a positive, bounded frame.
    expect(r.constants.storeChunkSize).toBeGreaterThan(0);
    expect(r.constants.frameOverhead).toBeGreaterThan(0);
    expect(r.constants.minTextBytes).toBeLessThan(r.constants.maxTextBytes);
  });

  it("builds v3 manifests for files and text", async () => {
    const r = await builtRuntime();
    expect(r.fileManifest([{ name: "a/b.bin", size: 4 }])).toEqual({
      v: 3,
      items: [{ kind: "file", name: "a/b.bin", size: 4 }],
    });
    expect(r.textManifest(12)).toEqual({ v: 3, items: [{ kind: "text", size: 12 }] });
  });

  it("round-trips a sealed content key — the receive half the shared library lacks", async () => {
    // `web/src/lib/device-seal.ts` is sender-only: it seals and never opens,
    // because a browser never receives. This proves the two libsodium calls the
    // entry adds actually pair up.
    const r = await builtRuntime();
    const pair = await r.generateKeyPair();
    expect(pair.publicKey.byteLength).toBe(r.constants.publicKeyBytes);
    expect(pair.privateKey.byteLength).toBe(r.constants.publicKeyBytes);

    const contentKey = new Uint8Array(r.constants.contentKeyBytes);
    for (let i = 0; i < contentKey.length; i += 1) contentKey[i] = (i * 7) & 0xff;

    const sealed = await r.sealContentKey(contentKey, r.constants.keyAlgorithm, r.encodeKey(pair.publicKey));
    const opened = await r.openSealedContentKey(r.decodeKey(sealed), pair.privateKey);
    expect(opened).toEqual(contentKey);
  });

  it("refuses a sealed key of the wrong length rather than guessing", async () => {
    const r = await builtRuntime();
    const pair = await r.generateKeyPair();
    await expect(r.openSealedContentKey(new Uint8Array(10), pair.privateKey)).rejects.toThrow();
  });

  it("refuses to open with a wrong-length private key", async () => {
    const r = await builtRuntime();
    await expect(
      r.openSealedContentKey(new Uint8Array(80), new Uint8Array(5)),
    ).rejects.toThrow();
  });

  it("round-trips the AEAD manifest framing under Node", async () => {
    const r = await builtRuntime();
    const raw = new Uint8Array(32).fill(9);
    const key = await r.importStoreKey(raw);
    const manifest = { files: [{ name: "x.bin", size: 7 }] };
    const sealed = await r.sealManifestBytes(key, new TextEncoder().encode(JSON.stringify(manifest)));
    expect(await r.decryptManifest(key, sealed)).toEqual(manifest);
  });

  // The receive-half members. `openManifestBytes` duplicates one wire detail —
  // frame 0's nonce — because `nonce` is module-private in the shared source and
  // `web/src/lib` is frozen. This is the test that keeps the duplicate honest:
  // it seals with the SHARED encoder and opens with ours, so a change to the
  // shared derivation fails here instead of diverging in silence.
  it("opens frame 0 to raw bytes, agreeing with the shared sealer", async () => {
    const r = await builtRuntime();
    const key = await r.importStoreKey(new Uint8Array(32).fill(5));
    const document = new TextEncoder().encode('{"v":3,"items":[{"kind":"text","size":4}]}');
    const sealed = await r.sealManifestBytes(key, document);
    expect(await r.openManifestBytes(key, sealed)).toEqual(document);
  });

  it("refuses a frame 0 that does not authenticate", async () => {
    const r = await builtRuntime();
    const key = await r.importStoreKey(new Uint8Array(32).fill(5));
    const sealed = await r.sealManifestBytes(key, new TextEncoder().encode("{}"));
    sealed[0] ^= 0x01;
    await expect(r.openManifestBytes(key, sealed)).rejects.toThrow();
  });

  it("decodes a v3 manifest canonically and refuses one that is not", async () => {
    const r = await builtRuntime();
    const manifest = r.textManifest(12);
    const canonical = new TextEncoder().encode(JSON.stringify({ v: 3, items: [{ kind: "text", size: 12 }] }));
    expect(r.decodeInboxManifest(canonical)).toEqual(manifest);
    // Reordered keys are the same document to a JSON parser and a DIFFERENT one
    // to this codec, which re-encodes what it parsed and requires equality.
    const reordered = new TextEncoder().encode('{"items":[{"kind":"text","size":12}],"v":3}');
    expect(() => r.decodeInboxManifest(reordered)).toThrow();
  });

  it("decrypts framed data and catches a truncation on a frame boundary", async () => {
    const r = await builtRuntime();
    const raw = new Uint8Array(32).fill(3);
    const key = await r.importStoreKey(raw);

    // Two frames, seq 1 and 2, exactly as the sender writes them.
    const frames: Uint8Array[] = [];
    for (let seq = 1; seq <= 2; seq += 1) {
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setUint32(8, seq);
      const piece = new Uint8Array(8).fill(seq);
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, piece));
      const framed = new Uint8Array(4 + ct.byteLength);
      new DataView(framed.buffer).setUint32(0, ct.byteLength);
      framed.set(ct, 4);
      frames.push(framed);
    }

    const whole = r.createStoreDecryptor(key);
    const out: number[] = [];
    for (const frame of frames) for await (const pt of whole.push(frame)) out.push(...pt);
    for await (const _ of whole.end(16)) { /* no trailing plaintext */ }
    expect(out.length).toBe(16);
    expect(whole.decryptedBytes).toBe(16);

    // One whole frame short. The stream ends cleanly on a boundary, so only the
    // expected total detects it.
    const truncated = r.createStoreDecryptor(key);
    for await (const _ of truncated.push(frames[0]!)) { /* drain */ }
    await expect(async () => {
      for await (const _ of truncated.end(16)) { /* unreachable */ }
    }).rejects.toThrow();
  });

  it("refuses a frame whose declared length is past the ceiling", async () => {
    const r = await builtRuntime();
    const key = await r.importStoreKey(new Uint8Array(32).fill(1));
    const hostile = new Uint8Array(8);
    // A length prefix is attacker-controlled; without the cap this would be an
    // unbounded allocation waiting for a frame that never completes.
    new DataView(hostile.buffer).setUint32(0, r.constants.maxFrameCt + 1);
    const decryptor = r.createStoreDecryptor(key);
    await expect(async () => {
      for await (const _ of decryptor.push(hostile)) { /* unreachable */ }
    }).rejects.toThrow();
  });

  it("normalises device names through the shared rule", async () => {
    const r = await builtRuntime();
    expect(r.normalizeDeviceName("  My  PC \n")).toBe("My PC");
    expect(r.constants.deviceNameMax).toBe(64);
  });
});

describe("the production encryptor, through the built artifact", () => {
  /**
   * These exercise the SHARED `encryptFiles`, not a copy of it.
   *
   * The point is byte-level: the frames a main-side caller gets must be the
   * frames the Web sender produces and the Mac/Web receivers decrypt. So each
   * case round-trips through `createStoreDecryptor`, which is the same shared
   * module's counterpart, and checks the exact plaintext back.
   */
  async function framesOf(files: File[], key: CryptoKey, r: InboxRuntime): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for await (const frame of r.encryptFiles(files, key)) out.push(frame);
    return out;
  }

  const bytesOf = (frames: readonly Uint8Array[]): Uint8Array => {
    const total = frames.reduce((n, f) => n + f.byteLength, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const f of frames) {
      joined.set(f, at);
      at += f.byteLength;
    }
    return joined;
  };

  /**
   * A deterministic buffer of any size.
   *
   * `crypto.getRandomValues` caps at 65536 bytes and the shared chunk is 192 KiB,
   * so a chunk-crossing case cannot be built from it. A pattern is better
   * evidence anyway: a frame reassembled in the wrong order fails visibly.
   */
  const filled = (n: number, seed: number): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(new ArrayBuffer(n));
    for (let i = 0; i < n; i += 1) out[i] = (i * 31 + seed) & 0xff;
    return out;
  };

  async function drain(r: InboxRuntime, key: CryptoKey, ciphertext: Uint8Array, expected: number): Promise<Uint8Array> {
    const decryptor = r.createStoreDecryptor(key);
    const parts: Uint8Array[] = [];
    for await (const part of decryptor.push(ciphertext)) parts.push(part);
    for await (const part of decryptor.end(expected)) parts.push(part);
    return bytesOf(parts);
  }

  it("frames a nonzero file and decrypts back to the same bytes", async () => {
    const r = await builtRuntime();
    const key = await r.importStoreKey(crypto.getRandomValues(new Uint8Array(32)));
    const body = filled(1024, 3);
    const file = new File([body], "a.bin");

    const frames = await framesOf([file], key, r);

    expect(frames).toHaveLength(1);
    // The length prefix is the frame's own, and the overhead is the shared one.
    expect(frames[0]!.byteLength).toBe(body.byteLength + r.constants.frameOverhead);
    expect(new DataView(frames[0]!.buffer, frames[0]!.byteOffset).getUint32(0, false)).toBe(
      frames[0]!.byteLength - 4,
    );
    expect(await drain(r, key, bytesOf(frames), body.byteLength)).toEqual(body);
  });

  it("crosses a chunk boundary with a global sequence that never resets", async () => {
    const r = await builtRuntime();
    const key = await r.importStoreKey(crypto.getRandomValues(new Uint8Array(32)));
    const chunk = r.constants.storeChunkSize;
    // One file spanning two chunks, then a second file: the counter must carry
    // ACROSS files. A per-file reset would repeat a nonce under one key, which
    // with different plaintext is a break rather than a glitch — so this is the
    // one property worth asserting through the artifact rather than trusting.
    const first = filled(chunk + 7, 1);
    const second = filled(5, 2);
    const files = [new File([first], "big.bin"), new File([second], "small.bin")];

    const frames = await framesOf(files, key, r);

    expect(frames).toHaveLength(3);
    expect(frames[0]!.byteLength).toBe(chunk + r.constants.frameOverhead);
    expect(frames[1]!.byteLength).toBe(7 + r.constants.frameOverhead);
    expect(frames[2]!.byteLength).toBe(5 + r.constants.frameOverhead);
    const back = await drain(r, key, bytesOf(frames), first.byteLength + second.byteLength);
    expect(back.subarray(0, first.byteLength)).toEqual(first);
    expect(back.subarray(first.byteLength)).toEqual(second);
  });

  it("gives a zero-byte file no frames at all", async () => {
    const r = await builtRuntime();
    const key = await r.importStoreKey(crypto.getRandomValues(new Uint8Array(32)));
    const body = new Uint8Array([9, 9, 9]);

    // A leading empty entry owes nothing, and the next file's frame is still
    // the FIRST frame. Every empty-file bug in this product starts here.
    const frames = await framesOf([new File([], "empty.bin"), new File([body], "b.bin")], key, r);

    expect(frames).toHaveLength(1);
    expect(await drain(r, key, bytesOf(frames), body.byteLength)).toEqual(body);
  });

  it("declares the exact ciphertext total the frames come to", async () => {
    const r = await builtRuntime();
    const key = await r.importStoreKey(crypto.getRandomValues(new Uint8Array(32)));
    const files = [
      new File([], "empty.bin"),
      new File([filled(r.constants.storeChunkSize + 3, 4)], "big.bin"),
      new File([filled(11, 5)], "small.bin"),
    ];

    const declared = r.cipherSizeFor(files);
    const produced = (await framesOf(files, key, r)).reduce((n, f) => n + f.byteLength, 0);

    // `?size=` is this number. A mismatch would make finalize refuse the object.
    expect(declared).toBe(produced);
  });

  it("carries UTF-8 text through the same path a message uses", async () => {
    const r = await builtRuntime();
    const key = await r.importStoreKey(crypto.getRandomValues(new Uint8Array(32)));
    // Multi-byte on purpose: the manifest declares BYTES, and a per-character
    // bound would let one emoji past a check the seal then refuses.
    const message = "你好 — Relayium ✅ 消息";
    const body = new TextEncoder().encode(message);
    const files = [new File([body], "message")];

    const frames = await framesOf(files, key, r);
    const back = await drain(r, key, bytesOf(frames), body.byteLength);

    expect(new TextDecoder().decode(back)).toBe(message);
    expect(r.textManifest(body.length).items).toEqual([{ kind: "text", size: body.length }]);
  });
});
