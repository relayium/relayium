import { describe, it, expect, beforeAll } from "vitest";
import sodium from "libsodium-wrappers";
import {
  ready, generateKeyPair, deriveSession, textKeyBytes, TEXT_KEY_DOMAIN, seal, open,
} from "./crypto";

beforeAll(async () => {
  await ready();
  await sodium.ready; // for the un-domained hash this suite compares against
});

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (...v: number[]) => new Uint8Array(v) as Uint8Array<ArrayBuffer>;

async function peers() {
  const a = generateKeyPair();
  const b = generateKeyPair();
  return {
    ka: await deriveSession("initiator", a, b.publicKey),
    kb: await deriveSession("responder", b, a.publicKey),
  };
}

describe("text key derivation", () => {
  it("is 32 bytes and deterministic for a given session key", () => {
    const k = new Uint8Array(32).fill(7);
    expect(textKeyBytes(k).length).toBe(32);
    expect(hex(textKeyBytes(k))).toBe(hex(textKeyBytes(k)));
  });

  it("pins the domain string, because changing it is a wire break", () => {
    expect(TEXT_KEY_DOMAIN).toBe("relayium-text-v1\0");
  });

  // The domain is the whole point: without it this would be a bare hash of a
  // session secret, replayable into any other context that hashes the same
  // secret. Assert the domain actually participates rather than trusting the
  // constant is referenced somewhere.
  it("is genuinely domain-separated, not a bare hash of the session key", () => {
    const k = new Uint8Array(32).fill(7);
    const undomained = sodium.crypto_generichash(32, k, null);
    expect(hex(textKeyBytes(k))).not.toBe(hex(undomained));
  });

  it("differs for different session keys", () => {
    expect(hex(textKeyBytes(new Uint8Array(32).fill(1))))
      .not.toBe(hex(textKeyBytes(new Uint8Array(32).fill(2))));
  });

  // crypto_kx hands the two sides mirrored secrets (one's tx is the other's rx),
  // so hashing each locally already lines the directions up. This is what lets
  // the derivation skip the sort deriveResumeAuth needs, with no round trip.
  it("mirrors across the peers: A's textSend opens under B's textRecv", async () => {
    const { ka, kb } = await peers();
    const back = await open(kb.textRecv, 0, await seal(ka.textSend, 0, bytes(1, 2, 3, 4)));
    expect([...back]).toEqual([1, 2, 3, 4]);
  });

  it("mirrors the other way too: B's textSend opens under A's textRecv", async () => {
    const { ka, kb } = await peers();
    const back = await open(ka.textRecv, 0, await seal(kb.textSend, 0, bytes(9, 8, 7)));
    expect([...back]).toEqual([9, 8, 7]);
  });

  // The property the whole nonce argument rests on. Two independent counters on
  // one key is how AES-GCM nonces get reused; two counters are only safe here
  // because they are two keys.
  it("is a different key from the file-transfer send key at the same seq", async () => {
    const { ka, kb } = await peers();
    const ct = await seal(ka.textSend, 5, bytes(9, 9, 9));
    await expect(open(kb.recv, 5, ct)).rejects.toThrow();
  });

  it("is a different key from the file-transfer recv key at the same seq", async () => {
    const { ka, kb } = await peers();
    const ct = await seal(kb.send, 5, bytes(4, 4, 4));
    await expect(open(ka.textRecv, 5, ct)).rejects.toThrow();
  });

  // And the two directions of the text stream are themselves distinct, so a
  // frame cannot be reflected back at its sender and opened.
  it("keeps the two text directions distinct within one peer", async () => {
    const { ka } = await peers();
    const ct = await seal(ka.textSend, 0, bytes(1, 1, 1));
    await expect(open(ka.textRecv, 0, ct)).rejects.toThrow();
  });

  it("gives the two peers different send keys", async () => {
    const { ka, kb } = await peers();
    const ct = await seal(ka.textSend, 0, bytes(2, 2, 2));
    await expect(open(kb.textRecv, 0, ct)).resolves.toBeInstanceOf(Uint8Array);
    await expect(open(ka.textRecv, 0, ct)).rejects.toThrow();
  });

  it("still derives the three pre-existing session keys", async () => {
    const { ka } = await peers();
    expect(ka.send).toBeTruthy();
    expect(ka.recv).toBeTruthy();
    expect(ka.resumeAuth).toBeTruthy();
  });
});
