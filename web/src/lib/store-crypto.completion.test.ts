import { describe, it, expect } from "vitest";
import {
  completionProof,
  completionVerifier,
  encodeKey,
  PREUPLOAD_COMPLETE_INFO,
} from "./store-crypto";

/** The pair-room completion capability's shared contract, pinned as a frozen
 *  vector.
 *
 *  The same three constants appear in server/account/pairroom_complete_test.go.
 *  They are duplicated on purpose rather than generated from one side: the
 *  property under test is that two independent implementations — the browser's
 *  WebCrypto HKDF and Go's crypto/hkdf — derive the same bytes from the same key.
 *  A vector either side computed for itself would prove nothing at all. If the
 *  two files ever disagree, a receiver cannot complete an object the sender
 *  uploaded, and every completion 403s. */
const VECTOR_KEY = "5f3a1c9d0e2b47861fa4d8c30b95e27614af8b52c1d093e7a6b4f80c2d517e39";
const VECTOR_PROOF = "9ae23a9d9aa452cad99682066c0a31d380f5365e3d098799434e95eec7225dbc";
const VECTOR_VERIFIER = "4d65d3b38f80783cf6dd042e7620a9c3ddab790f12937cf8486be7b2fecc90c5";

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("pair-room completion vector", () => {
  it("derives the frozen proof and verifier from the frozen key", async () => {
    const key = fromHex(VECTOR_KEY);
    const proof = await completionProof(key);
    expect(toHex(proof)).toBe(VECTOR_PROOF);
    expect(toHex(await completionVerifier(key))).toBe(VECTOR_VERIFIER);
  });

  // The info string is the domain separator, and it is part of the wire: a
  // sender on one string and a receiver on another derive different proofs for
  // the same key. Pinned as its exact ASCII so a plausible-looking rename cannot
  // pass review.
  it("uses exactly the protocol's info string", () => {
    expect(PREUPLOAD_COMPLETE_INFO).toBe("relayium-preupload-complete-v1");
  });

  // What actually goes on the wire: base64url, no padding, 43 characters for 32
  // bytes. The server's parser is strict about all three.
  it("encodes both values as unpadded base64url", async () => {
    const key = fromHex(VECTOR_KEY);
    expect(encodeKey(await completionProof(key))).toBe("muI6nZqkUsrZloIGbAox04D1Nl49CYeZQ06V7sciXbw");
    expect(encodeKey(await completionVerifier(key))).toBe("TWXTs4-AeDz23QQudiCpw92reQ8Sk3z4SGvnsv7MkMU");
  });

  // A proof is a capability for ONE object: derived from that object's own file
  // key, so a sibling in the same batch cannot be completed with it.
  it("derives a different proof for every file key", async () => {
    const a = await completionProof(fromHex(VECTOR_KEY));
    const other = fromHex(VECTOR_KEY);
    other[0] ^= 0x01;
    const b = await completionProof(other);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  // The server stores the verifier and never the proof, so the verifier must not
  // be the thing a receiver sends. Stated as a test because the two are the same
  // shape on the wire and confusing them would let anyone who has read the
  // database complete anybody's transfer.
  it("does not make the verifier equal to the proof", async () => {
    const key = fromHex(VECTOR_KEY);
    expect(toHex(await completionProof(key))).not.toBe(toHex(await completionVerifier(key)));
  });

  it("rejects a file key that is not 32 bytes", async () => {
    await expect(completionProof(new Uint8Array(31))).rejects.toThrow();
    await expect(completionVerifier(new Uint8Array(33))).rejects.toThrow();
  });
});
