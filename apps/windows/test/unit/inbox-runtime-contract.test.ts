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
