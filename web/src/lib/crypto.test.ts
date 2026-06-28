import { describe, it, expect, beforeAll } from "vitest";
import {
  ready, generateKeyPair, deriveSession, sas, seal, open,
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

  it("fails to open with a wrong sequence number (nonce binding)", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const ka = await deriveSession("initiator", a, b.publicKey);
    const kb = await deriveSession("responder", b, a.publicKey);
    const ct = await seal(ka.send, 5, new Uint8Array([1, 2, 3]));
    await expect(open(kb.recv, 6, ct)).rejects.toThrow();
  });
});
