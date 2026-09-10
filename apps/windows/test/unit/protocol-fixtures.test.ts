// The reuse claim, executed rather than asserted.
//
// This suite imports the SHIPPING web protocol modules — the same files the
// browser client runs — and drives them against the frozen cross-language
// fixtures under `apps/RelayiumKit/Tests/Fixtures/`. Those fixtures already have
// Swift, Kotlin, TypeScript and Go consumers; this adds the Windows client as
// one more, on the same bytes.
//
// Two things are being proven at once:
//
//   1. **The import works at all.** `apps/windows` compiles and runs
//      `web/src/lib/*` directly, with no vendored copy and no re-typing. A
//      vendored copy is silent divergence with a green board on both sides.
//   2. **What it computes is the frozen wire**, not merely something
//      self-consistent. Every expected value below comes from the fixture file,
//      so a change to the protocol fails here rather than at interop time.

import { describe, expect, it, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import * as crypto from "../../../../web/src/lib/crypto";
import * as transfer from "../../../../web/src/lib/transfer";
import { normalizeCode, isValidCode } from "../../../../web/src/lib/pair-code";

const fixture = (name: string): Record<string, never> =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../RelayiumKit/Tests/Fixtures/${name}`, import.meta.url)),
      "utf8",
    ),
  );

const cryptoVectors = fixture("crypto-vectors.json") as never as {
  alice: { pub: string; sec: string };
  bob: { pub: string; sec: string };
  session: { aliceSend: string; aliceRecv: string; bobSend: string; bobRecv: string };
  sas: string;
  commit: { nonce: string; value: string };
  aead: { keyHex: string; seq: number; ptHex: string; ctHex: string };
  textKeys: { domain: string; aliceTextSend: string; aliceTextRecv: string };
};

const wireVectors = fixture("realtime-wire-vectors.json") as never as {
  kinds: Record<string, number>;
  limits: { chunkSize: number; chunkOverhead: number; minPieceBytes: number };
  ackHex: string;
  controlHex: { accept: string; reject: string; complete: string };
};

// A plain `Uint8Array<ArrayBuffer>`, not `Uint8Array.from(Buffer)`. A Buffer's
// backing store is typed `ArrayBufferLike`, which the protocol's `Bytes` alias
// rejects because it may be a `SharedArrayBuffer`.
const hex = (s: string): Uint8Array<ArrayBuffer> => {
  const source = Buffer.from(s, "hex");
  const out = new Uint8Array(source.byteLength);
  out.set(source);
  return out;
};
const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

beforeAll(async () => {
  // libsodium is WASM and loads asynchronously. This is also the first proof
  // that the WASM half of the web client runs under Node in the main process.
  await crypto.ready();
});

const importAes = (raw: Uint8Array): Promise<CryptoKey> =>
  globalThis.crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);

describe("crypto, against the frozen vectors", () => {
  // `SessionKeys` are non-extractable `CryptoKey`s by design, so the derivation
  // is checked by the property that actually matters — one peer's `send` opens
  // under the other peer's `recv` — rather than by reading key bytes the API
  // deliberately does not expose.
  it("derives crossing session keys for the two fixture peers", async () => {
    const alice = await crypto.deriveSession(
      "initiator",
      { publicKey: hex(cryptoVectors.alice.pub), privateKey: hex(cryptoVectors.alice.sec) },
      hex(cryptoVectors.bob.pub),
    );
    const bob = await crypto.deriveSession(
      "responder",
      { publicKey: hex(cryptoVectors.bob.pub), privateKey: hex(cryptoVectors.bob.sec) },
      hex(cryptoVectors.alice.pub),
    );

    const plaintext = hex(cryptoVectors.aead.ptHex);
    const sealed = await crypto.seal(alice.send, 1, plaintext);
    expect(toHex(await crypto.open(bob.recv, 1, sealed))).toBe(cryptoVectors.aead.ptHex);

    const back = await crypto.seal(bob.send, 1, plaintext);
    expect(toHex(await crypto.open(alice.recv, 1, back))).toBe(cryptoVectors.aead.ptHex);

    // The directions are genuinely separate: Alice's own recv key must NOT open
    // what Alice sealed to send, or both directions share one nonce space.
    await expect(crypto.open(alice.recv, 1, sealed)).rejects.toThrow();
  });

  it("computes the fixture's six-digit SAS, and both peers read the same digits", () => {
    const a = crypto.sas(hex(cryptoVectors.alice.pub), hex(cryptoVectors.bob.pub));
    const b = crypto.sas(hex(cryptoVectors.bob.pub), hex(cryptoVectors.alice.pub));
    expect(a).toBe(cryptoVectors.sas);
    expect(b).toBe(cryptoVectors.sas);
    expect(a).toHaveLength(6);
  });

  it("computes and verifies the fixture's commitment", () => {
    const value = crypto.commitKey(hex(cryptoVectors.alice.pub), hex(cryptoVectors.commit.nonce));
    expect(toHex(value)).toBe(cryptoVectors.commit.value);
    expect(
      crypto.verifyCommit(value, hex(cryptoVectors.alice.pub), hex(cryptoVectors.commit.nonce)),
    ).toBe(true);
    // A different nonce must not verify, or commit-reveal is decorative.
    expect(
      crypto.verifyCommit(value, hex(cryptoVectors.alice.pub), new Uint8Array(32).fill(9)),
    ).toBe(false);
  });

  it("seals to the fixture's exact ciphertext at the fixture's sequence number", async () => {
    const key = await importAes(hex(cryptoVectors.aead.keyHex));
    const sealed = await crypto.seal(key, cryptoVectors.aead.seq, hex(cryptoVectors.aead.ptHex));
    expect(toHex(sealed)).toBe(cryptoVectors.aead.ctHex);
    const opened = await crypto.open(key, cryptoVectors.aead.seq, hex(cryptoVectors.aead.ctHex));
    expect(toHex(opened)).toBe(cryptoVectors.aead.ptHex);
  });

  it("refuses a frame at the wrong sequence number", async () => {
    const key = await importAes(hex(cryptoVectors.aead.keyHex));
    await expect(
      crypto.open(key, cryptoVectors.aead.seq + 1, hex(cryptoVectors.aead.ctHex)),
    ).rejects.toThrow();
  });

  it("refuses a tampered frame", async () => {
    const key = await importAes(hex(cryptoVectors.aead.keyHex));
    const tampered = hex(cryptoVectors.aead.ctHex);
    tampered[0] ^= 0x01;
    await expect(crypto.open(key, cryptoVectors.aead.seq, tampered)).rejects.toThrow();
  });

  // The single most likely porting bug in this protocol: the domain is 17 bytes
  // INCLUDING the trailing NUL. Two protocol documents said 18 until
  // 2026-09-07, and the Android port hard-asserts 17 at class init.
  it("uses the 17-byte text-key domain, NUL included", () => {
    expect(crypto.TEXT_KEY_DOMAIN).toBe(cryptoVectors.textKeys.domain);
    expect(new TextEncoder().encode(crypto.TEXT_KEY_DOMAIN)).toHaveLength(17);
  });

  it("derives the fixture's text keys, per direction and unsorted", () => {
    expect(toHex(crypto.textKeyBytes(hex(cryptoVectors.session.aliceSend)))).toBe(
      cryptoVectors.textKeys.aliceTextSend,
    );
    expect(toHex(crypto.textKeyBytes(hex(cryptoVectors.session.aliceRecv)))).toBe(
      cryptoVectors.textKeys.aliceTextRecv,
    );
    // Unsorted: the two directions must differ, or one key covers both nonce
    // spaces.
    expect(cryptoVectors.textKeys.aliceTextSend).not.toBe(cryptoVectors.textKeys.aliceTextRecv);
  });
});

describe("realtime wire constants, against the frozen vectors", () => {
  it("agrees on every frame kind", () => {
    expect(transfer.FRAME.CHUNK).toBe(wireVectors.kinds["chunk"]);
    expect(transfer.FRAME.CHUNK_PART).toBe(wireVectors.kinds["chunkPart"]);
    expect(transfer.FRAME.BATCH).toBe(wireVectors.kinds["batchEnc"]);
    expect(transfer.FRAME.DONE).toBe(wireVectors.kinds["doneEnc"]);
    expect(transfer.FRAME.RESUME).toBe(wireVectors.kinds["resumeStart"]);
  });

  it("agrees on the size limits the receiver enforces", () => {
    expect(transfer.CHUNK_SIZE).toBe(wireVectors.limits.chunkSize);
    expect(transfer.CHUNK_OVERHEAD).toBe(wireVectors.limits.chunkOverhead);
    expect(transfer.MIN_PIECE_BYTES).toBe(wireVectors.limits.minPieceBytes);
  });

  it("emits and parses the fixture's ACK frame", () => {
    const parsed = transfer.parseAck(hex(wireVectors.ackHex).buffer as ArrayBuffer);
    expect(parsed).not.toBeNull();
    expect(toHex(transfer.ackFrame(parsed!))).toBe(wireVectors.ackHex);
  });

  it("emits the fixture's control bytes", () => {
    expect(toHex(transfer.ACCEPT)).toBe(wireVectors.controlHex.accept);
    expect(toHex(transfer.REJECT)).toBe(wireVectors.controlHex.reject);
    expect(toHex(transfer.COMPLETE)).toBe(wireVectors.controlHex.complete);
  });
});

describe("pairing codes", () => {
  // Leading zeros are significant. A client that parses a code as a number
  // destroys a tenth of the code space.
  it("keeps a leading zero", () => {
    expect(isValidCode("012345")).toBe(true);
    expect(normalizeCode("012345")).toBe("012345");
    expect(Number("012345").toString()).not.toBe("012345");
  });

  it("refuses the retired alphabet and wrong lengths", () => {
    expect(isValidCode("ACDEFH")).toBe(false);
    expect(isValidCode("12345")).toBe(false);
    expect(isValidCode("1234567")).toBe(false);
  });
});
