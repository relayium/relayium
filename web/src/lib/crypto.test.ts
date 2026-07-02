import { describe, it, expect, beforeAll } from "vitest";
import {
  ready, generateKeyPair, deriveSession, sas, seal, open,
  commitKey, verifyCommit, randomNonce,
} from "./crypto";

beforeAll(async () => { await ready(); });

describe("crypto", () => {
  it("derives matching session keys across the two roles", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ka = await deriveSession("initiator", a, b.publicKey);
    const kb = await deriveSession("responder", b, a.publicKey);
    // a seals with its send key; b must open with its recv key.
    const msg = new TextEncoder().encode("hello relayium");
    const ct = await seal(ka.send, 0, msg);
    const pt = await open(kb.recv, 0, ct);
    expect(new TextDecoder().decode(pt)).toBe("hello relayium");
  });

  it("produces an order-independent 6-digit SAS that differs per pair", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const c = generateKeyPair();
    expect(sas(a.publicKey, b.publicKey)).toMatch(/^\d{6}$/);
    expect(sas(a.publicKey, b.publicKey)).toBe(sas(b.publicKey, a.publicKey));
    expect(sas(a.publicKey, b.publicKey)).not.toBe(sas(a.publicKey, c.publicKey));
  });

  it("opens a commitment only with the exact key and nonce", () => {
    const kp = generateKeyPair();
    const nonce = randomNonce();
    expect(nonce.length).toBe(32);
    const commit = commitKey(kp.publicKey, nonce);
    expect(commit.length).toBe(32);
    // Honest reveal verifies.
    expect(verifyCommit(commit, kp.publicKey, nonce)).toBe(true);
    // A forged reveal (attacker's key, real nonce) is rejected — this is what
    // stops a MITM from post-selecting a colliding-SAS key after the commit.
    const attacker = generateKeyPair();
    expect(verifyCommit(commit, attacker.publicKey, nonce)).toBe(false);
    // Wrong nonce is rejected too.
    expect(verifyCommit(commit, kp.publicKey, randomNonce())).toBe(false);
    // Malformed (short) commitment is rejected, not thrown.
    expect(verifyCommit(new Uint8Array(8), kp.publicKey, nonce)).toBe(false);
  });

  it("both sides of a commit-then-reveal handshake compute the same SAS", () => {
    // Simulate the wire protocol at the crypto layer: each side commits, then
    // reveals; both verify the peer's reveal against its commit before hashing.
    const i = generateKeyPair(), iN = randomNonce();
    const r = generateKeyPair(), rN = randomNonce();
    const iCommit = commitKey(i.publicKey, iN);
    const rCommit = commitKey(r.publicKey, rN);
    // responder verifies initiator's reveal against iCommit; initiator verifies rCommit.
    expect(verifyCommit(iCommit, i.publicKey, iN)).toBe(true);
    expect(verifyCommit(rCommit, r.publicKey, rN)).toBe(true);
    expect(sas(i.publicKey, r.publicKey)).toBe(sas(r.publicKey, i.publicKey));
  });

  it("fails to open with a wrong sequence number (nonce binding)", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ka = await deriveSession("initiator", a, b.publicKey);
    const kb = await deriveSession("responder", b, a.publicKey);
    const ct = await seal(ka.send, 5, new Uint8Array([1, 2, 3]));
    await expect(open(kb.recv, 6, ct)).rejects.toThrow();
  });
});
