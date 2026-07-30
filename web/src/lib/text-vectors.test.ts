import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { ready, textKeyBytes, TEXT_KEY_DOMAIN, seal, generateKeyPair, deriveSession, signResume, verifyResume } from "./crypto";
import { TextSender, TEXT_MAX_BYTES, KIND_TEXT_ENC } from "./text-wire";

// The Swift port is verified against fixtures generated HERE, by the web
// implementation, so they are a cross-check between the two ports rather than a
// restatement of either. This suite is the other half of that: it recomputes the
// committed fixtures and fails if the web side drifts from them, so the two can
// never silently diverge.
//
// To regenerate after a deliberate change: PRINT_TEXT_VECTORS=1 npx vitest run
// src/lib/text-vectors.test.ts   — then paste the printed blocks into the fixtures.

const CRYPTO = "../apps/RelayiumKit/Tests/Fixtures/crypto-vectors.json";
const WIRE = "../apps/RelayiumKit/Tests/Fixtures/realtime-wire-vectors.json";
const load = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, never>;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) =>
  new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16))) as Uint8Array<ArrayBuffer>;

// The bodies the fixtures pin: plain ASCII, a multibyte mix, and content whose
// whitespace must survive byte for byte.
const BODIES = [
  "relayium message",
  "你好 مرحبا 🌍 e\u0301",
  "  \tif x:\n\n\t\tprintf %s hello\n   \r\n  trailing   ",
];

beforeAll(async () => { await ready(); });

describe("text vectors (web is the generator, Swift the consumer)", () => {
  it("matches the committed crypto-vectors text keys", async () => {
    const v = load(CRYPTO) as unknown as { session: Record<string, string>; textKeys?: Record<string, string> };
    const want = {
      domain: TEXT_KEY_DOMAIN,
      aliceTextSend: hex(textKeyBytes(unhex(v.session.aliceSend))),
      aliceTextRecv: hex(textKeyBytes(unhex(v.session.aliceRecv))),
      bobTextSend: hex(textKeyBytes(unhex(v.session.bobSend))),
      bobTextRecv: hex(textKeyBytes(unhex(v.session.bobRecv))),
    };
    if (process.env.PRINT_TEXT_VECTORS) {
      console.log("crypto-vectors.json → textKeys:\n" + JSON.stringify({ textKeys: want }, null, 2));
    }
    expect(v.textKeys, "crypto-vectors.json has no textKeys block").toBeTruthy();
    expect(v.textKeys).toEqual(want);
  });

  it("matches the committed realtime-wire-vectors text frames", async () => {
    const v = load(WIRE) as unknown as {
      sessionKeyHex: string;
      text?: { kind: number; maxBytes: number; keyHex: string; frames: { seq: number; body: string; frameHex: string }[] };
    };
    // Derived FROM the existing session key, so the fixture shows the whole chain:
    // session key → text key → sealed frame.
    const keyRaw = textKeyBytes(unhex(v.sessionKeyHex));
    const key = await crypto.subtle.importKey("raw", keyRaw as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]);
    const sender = new TextSender();
    const frames: { seq: number; body: string; frameHex: string }[] = [];
    for (const [i, body] of BODIES.entries()) {
      frames.push({ seq: i, body, frameHex: hex(await sender.frame(body, key)) });
    }
    const want = { kind: KIND_TEXT_ENC, maxBytes: TEXT_MAX_BYTES, keyHex: hex(keyRaw), frames };
    if (process.env.PRINT_TEXT_VECTORS) {
      console.log("realtime-wire-vectors.json → text:\n" + JSON.stringify({ text: want }, null, 2));
    }
    expect(v.text, "realtime-wire-vectors.json has no text block").toBeTruthy();
    expect(v.text).toEqual(want);
  });

  // The seq is in the AEAD nonce, so the fixture's frames also pin nonceFromSeq.
  it("pins the per-direction counter starting at zero", async () => {
    const v = load(WIRE) as unknown as { text?: { frames: { seq: number }[] } };
    expect(v.text!.frames.map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  // deriveResumeAuth is unexported and yields a non-extractable CryptoKey, so it is
  // pinned transitively: derive a session from the fixture keypairs, sign the
  // fixture payload with the resulting key, and require the committed mac. Swift
  // pins the same mac from resumeAuth.keyHex, so the two ports cross-check.
  //
  // This is what makes passing the explicit `null` key to crypto_generichash
  // provably semantics-preserving rather than merely plausible.
  it("still derives the committed resume-auth key", async () => {
    const v = load(CRYPTO) as unknown as {
      alice: { pub: string; sec: string };
      bob: { pub: string };
      resumeAuth: { payload: string; mac: string };
    };
    const alice = { publicKey: unhex(v.alice.pub), privateKey: unhex(v.alice.sec) };
    const keys = await deriveSession("initiator", alice, unhex(v.bob.pub));
    expect(await signResume(keys.resumeAuth, v.resumeAuth.payload)).toBe(v.resumeAuth.mac);
    expect(await verifyResume(keys.resumeAuth, v.resumeAuth.payload, v.resumeAuth.mac)).toBe(true);
  });

  // verifyResume's base64 decode is the other typecheck site that moved; a
  // malformed tag must still be a refusal rather than a throw.
  it("still refuses a malformed or absent resume tag", async () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const keys = await deriveSession("initiator", a, b.publicKey);
    expect(await verifyResume(keys.resumeAuth, "p", undefined)).toBe(false);
    expect(await verifyResume(keys.resumeAuth, "p", "not-base64!!")).toBe(false);
    expect(await verifyResume(keys.resumeAuth, "p", "")).toBe(false);
  });

  // Old fixture entries must keep working untouched: the Swift file-stream tests
  // read them, and this change adds keys rather than editing any.
  it("leaves the pre-existing fixture keys in place", () => {
    const c = load(CRYPTO);
    for (const k of ["alice", "bob", "session", "sas", "commit", "aead", "resumeAuth"]) {
      expect(c[k], `crypto-vectors.${k} disappeared`).toBeTruthy();
    }
    const w = load(WIRE);
    for (const k of ["sessionKeyHex", "manifest", "batchFrameHex", "files", "frameStreamHex", "framesHex", "ackHex", "controlHex", "doneHashes", "sanitizedNames"]) {
      expect(w[k], `realtime-wire-vectors.${k} disappeared`).toBeTruthy();
    }
  });
});
