import { describe, it, expect, beforeAll } from "vitest";
import { ready, generateKeyPair, deriveSession, seal } from "./crypto";
import {
  TextSender, TextReceiver, KIND_TEXT_ENC, TEXT_MAX_BYTES, TEXT_FRAME_OVERHEAD,
  TEXT_REQUEST, TEXT_END, textByteLength, isTextFrame, textLifecycleKind,
} from "./text-wire";
import { ACCEPT, REJECT, COMPLETE, FILE_BUSY } from "./transfer";

beforeAll(async () => { await ready(); });

async function pair() {
  const a = generateKeyPair();
  const b = generateKeyPair();
  return {
    ka: await deriveSession("initiator", a, b.publicKey),
    kb: await deriveSession("responder", b, a.publicKey),
  };
}

const seqOf = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset).getUint32(1);

// Exactly the content the invariants promise to preserve: leading and trailing
// whitespace, a tab-indented block, blank lines, CJK, an astral emoji, and a
// bare CR that no normalising layer may turn into a newline.
const GNARLY = "  \tif x:\n\n\t\tprint('你好 🌍')\n   \r\n  trailing   ";

describe("text wire", () => {
  it("recognises exact mixed-link conversation lifecycle frames", () => {
    expect(textLifecycleKind(TEXT_REQUEST.buffer as ArrayBuffer)).toBe("request");
    expect(textLifecycleKind(ACCEPT.buffer as ArrayBuffer)).toBe("accept");
    expect(textLifecycleKind(REJECT.buffer as ArrayBuffer)).toBe("reject");
    expect(textLifecycleKind(TEXT_END.buffer as ArrayBuffer)).toBe("end");
    expect(new Set([
      ACCEPT[0], REJECT[0], COMPLETE[0], FILE_BUSY[0], TEXT_REQUEST[0], TEXT_END[0],
    ]).size).toBe(6);
    expect(isTextFrame(TEXT_REQUEST.buffer as ArrayBuffer)).toBe(false);
    expect(isTextFrame(TEXT_END.buffer as ArrayBuffer)).toBe(false);
    expect(textLifecycleKind(new Uint8Array([TEXT_REQUEST[0], 0]).buffer)).toBeNull();
    expect(textLifecycleKind(new Uint8Array([]).buffer)).toBeNull();
  });

  it("round-trips gnarly content byte for byte", async () => {
    const { ka, kb } = await pair();
    const got = await new TextReceiver().feed(
      await new TextSender().frame(GNARLY, ka.textSend), kb.textRecv,
    );
    expect(got).toBe(GNARLY);
    // Belt and braces: compare the UTF-8 bytes, not just the strings, so a
    // normalisation that happened to compare equal as a string still fails.
    const enc = new TextEncoder();
    expect([...enc.encode(got)]).toEqual([...enc.encode(GNARLY)]);
  });

  it("preserves a message that is only whitespace", async () => {
    const { ka, kb } = await pair();
    expect(await new TextReceiver().feed(
      await new TextSender().frame("   \n\t ", ka.textSend), kb.textRecv,
    )).toBe("   \n\t ");
  });

  it("preserves the empty string", async () => {
    const { ka, kb } = await pair();
    expect(await new TextReceiver().feed(
      await new TextSender().frame("", ka.textSend), kb.textRecv,
    )).toBe("");
  });

  it("preserves a long multiline block across many messages, in order", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    const bodies = ["первый\n\n", "\t\t二番目\t", "🌍🌎🌏", "  \n  ", "last"];
    const got: string[] = [];
    for (const b of bodies) got.push(await r.feed(await s.frame(b, ka.textSend), kb.textRecv));
    expect(got).toEqual(bodies);
  });

  it("frames as [9][seq BE] and advances seq once per message", async () => {
    const { ka } = await pair();
    const s = new TextSender();
    const f0 = await s.frame("a", ka.textSend);
    const f1 = await s.frame("b", ka.textSend);
    const f2 = await s.frame("c", ka.textSend);
    expect(KIND_TEXT_ENC).toBe(9);
    expect(f0[0]).toBe(KIND_TEXT_ENC);
    expect([seqOf(f0), seqOf(f1), seqOf(f2)]).toEqual([0, 1, 2]);
    expect(TEXT_FRAME_OVERHEAD).toBe(21);
    expect(f0.byteLength).toBe(1 + TEXT_FRAME_OVERHEAD);
    expect(isTextFrame(f0.buffer)).toBe(true);
  });

  // Each direction has its own counter starting at 0, so two peers messaging
  // each other do not have to coordinate one.
  it("gives each direction an independent counter from zero", async () => {
    const { ka, kb } = await pair();
    const aOut = new TextSender();
    const bOut = new TextSender();
    const aIn = new TextReceiver();
    const bIn = new TextReceiver();
    expect(await bIn.feed(await aOut.frame("a1", ka.textSend), kb.textRecv)).toBe("a1");
    expect(await aIn.feed(await bOut.frame("b1", kb.textSend), ka.textRecv)).toBe("b1");
    expect(await bIn.feed(await aOut.frame("a2", ka.textSend), kb.textRecv)).toBe("a2");
    expect(await aIn.feed(await bOut.frame("b2", kb.textSend), ka.textRecv)).toBe("b2");
  });

  it("counts limits in UTF-8 bytes, not characters", () => {
    expect(TEXT_MAX_BYTES).toBe(65536);
    expect(textByteLength("abc")).toBe(3);
    expect(textByteLength("你好")).toBe(6);       // 2 characters, 3 bytes each
    expect(textByteLength("🌍")).toBe(4);          // 1 astral character
    expect(textByteLength("e\u0301")).toBe(3);     // combining acute, not normalised
  });

  it("accepts a message of exactly TEXT_MAX_BYTES and refuses one byte more", async () => {
    const { ka, kb } = await pair();
    const atLimit = "a".repeat(TEXT_MAX_BYTES);
    const got = await new TextReceiver().feed(
      await new TextSender().frame(atLimit, ka.textSend), kb.textRecv,
    );
    expect(got).toBe(atLimit);
    await expect(new TextSender().frame("a".repeat(TEXT_MAX_BYTES + 1), ka.textSend))
      .rejects.toThrow(/too large/);
  });

  it("refuses a multibyte message that fits in characters but not in bytes", async () => {
    const { ka } = await pair();
    // 22000 characters, 66000 bytes. A character-based limit would let this through.
    await expect(new TextSender().frame("你".repeat(22000), ka.textSend))
      .rejects.toThrow(/too large/);
  });

  it("does not burn a seq on a refused message", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    await expect(s.frame("x".repeat(TEXT_MAX_BYTES + 1), ka.textSend)).rejects.toThrow();
    const f = await s.frame("first real one", ka.textSend);
    expect(seqOf(f)).toBe(0);
    expect(await new TextReceiver().feed(f, kb.textRecv)).toBe("first real one");
  });

  it("rejects an out-of-order seq", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    await s.frame("never delivered", ka.textSend);      // seq 0
    const f1 = await s.frame("arrives", ka.textSend);   // seq 1
    await expect(r.feed(f1, kb.textRecv)).rejects.toThrow(/out-of-order/);
  });

  it("rejects a replayed frame", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    const f = await s.frame("once", ka.textSend);
    expect(await r.feed(f, kb.textRecv)).toBe("once");
    await expect(r.feed(f, kb.textRecv)).rejects.toThrow(/out-of-order/);
  });

  it("does not advance the counter on a rejected frame", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const r = new TextReceiver();
    const f0 = await s.frame("real", ka.textSend);
    const tampered = f0.slice() as Uint8Array<ArrayBuffer>;
    tampered[tampered.length - 1] ^= 0x01;
    await expect(r.feed(tampered, kb.textRecv)).rejects.toThrow();
    // The receiver is still expecting seq 0, so the genuine frame still opens.
    expect(await r.feed(f0, kb.textRecv)).toBe("real");
  });

  it("rejects a tampered ciphertext and a tampered header", async () => {
    const { ka, kb } = await pair();
    const s = new TextSender();
    const body = await s.frame("hello", ka.textSend);
    const ctFlip = body.slice() as Uint8Array<ArrayBuffer>;
    ctFlip[ctFlip.length - 1] ^= 0x01;
    await expect(new TextReceiver().feed(ctFlip, kb.textRecv)).rejects.toThrow();
    // The seq is in the AEAD nonce, so rewriting it is also an auth failure.
    const seqFlip = body.slice() as Uint8Array<ArrayBuffer>;
    new DataView(seqFlip.buffer).setUint32(1, 7);
    await expect(new TextReceiver().feed(seqFlip, kb.textRecv)).rejects.toThrow();
  });

  it("rejects a frame sealed under the wrong key", async () => {
    const { ka } = await pair();
    const other = await pair();
    const f = await new TextSender().frame("hello", ka.textSend);
    await expect(new TextReceiver().feed(f, other.kb.textRecv)).rejects.toThrow();
  });

  it("rejects invalid UTF-8 rather than substituting U+FFFD", async () => {
    const { ka, kb } = await pair();
    // A lone continuation byte. The sender cannot produce this, but a peer can,
    // and a replacement character would be silent corruption reported as success.
    const ct = await seal(ka.textSend, 0, new Uint8Array([0x80]) as Uint8Array<ArrayBuffer>);
    const frame = new Uint8Array(5 + ct.length) as Uint8Array<ArrayBuffer>;
    frame[0] = KIND_TEXT_ENC;
    new DataView(frame.buffer).setUint32(1, 0);
    frame.set(ct, 5);
    const got = await new TextReceiver().feed(frame, kb.textRecv).catch((e: Error) => e);
    expect(got).toBeInstanceOf(Error);
    expect((got as Error).message).toMatch(/valid UTF-8/);
    expect((got as Error).message).not.toContain("\ufffd");
  });

  it("rejects a truncated frame, a wrong kind, and a header-only frame", async () => {
    const { kb } = await pair();
    const r = new TextReceiver();
    const chunkKind = new Uint8Array([1, 0, 0, 0, 0, ...new Array(16).fill(0)]) as Uint8Array<ArrayBuffer>;
    await expect(r.feed(chunkKind, kb.textRecv)).rejects.toThrow(/not a message frame/);
    await expect(r.feed(new Uint8Array([9, 0, 0]) as Uint8Array<ArrayBuffer>, kb.textRecv))
      .rejects.toThrow(/malformed/);
    // Header plus nothing: too short to hold even a GCM tag.
    await expect(r.feed(new Uint8Array([9, 0, 0, 0, 0]) as Uint8Array<ArrayBuffer>, kb.textRecv))
      .rejects.toThrow(/malformed/);
  });

  it("isTextFrame does not claim a file-stream frame or a control byte", async () => {
    const { ka } = await pair();
    const f = await new TextSender().frame("x", ka.textSend);
    expect(isTextFrame(f.buffer)).toBe(true);
    // KIND_CHUNK, KIND_BATCH_ENC, KIND_DONE_ENC, KIND_ACK, and the 1-byte controls.
    for (const kind of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const other = new Uint8Array(5 + 16) as Uint8Array<ArrayBuffer>;
      other[0] = kind;
      expect(isTextFrame(other.buffer)).toBe(false);
    }
    for (const ctrl of [0xfd, 0xfe, 0xff]) {
      expect(isTextFrame(new Uint8Array([ctrl]).buffer)).toBe(false);
    }
  });

  // Content must not be readable on the wire. The positive control is what stops
  // this passing vacuously if the payload were ever empty.
  it("leaves no plaintext on the wire", async () => {
    const { ka } = await pair();
    const canary = "SECRET-CANARY-你好-🌍";
    const f = await new TextSender().frame(canary, ka.textSend);
    const loose = new TextDecoder("utf-8", { fatal: false });
    expect(loose.decode(f)).not.toContain("SECRET-CANARY");
    expect(loose.decode(f)).not.toContain("你好");
    // positive control: the same decoder DOES find it in the plaintext bytes
    expect(loose.decode(new TextEncoder().encode(canary))).toContain("SECRET-CANARY");
  });

  it("leaks nothing about content but its length", async () => {
    const { ka } = await pair();
    const s = new TextSender();
    const a = await s.frame("aaaaaaaaaa", ka.textSend);
    const b = await s.frame("你你你你你你你你你你", ka.textSend);
    // 10 ASCII bytes vs 30 UTF-8 bytes: the frame length tracks the byte length
    // and nothing else. Length is observable; that is inherent and documented.
    expect(a.byteLength).toBe(10 + TEXT_FRAME_OVERHEAD);
    expect(b.byteLength).toBe(30 + TEXT_FRAME_OVERHEAD);
  });

  it("never puts content into its error messages", async () => {
    const { ka, kb } = await pair();
    const tooBig = await new TextSender().frame("CANARY".repeat(20000), ka.textSend)
      .catch((e: Error) => e);
    expect((tooBig as Error).message).not.toContain("CANARY");
    expect((tooBig as Error).message).toMatch(/\d+/); // reports a byte length

    const s = new TextSender();
    await s.frame("CANARY-dropped", ka.textSend);
    const outOfOrder = await new TextReceiver()
      .feed(await s.frame("CANARY-arrives", ka.textSend), kb.textRecv)
      .catch((e: Error) => e);
    expect((outOfOrder as Error).message).not.toContain("CANARY");
  });
});
