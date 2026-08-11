import { describe, it, expect } from "vitest";
import {
  CAP_PREUPLOAD,
  HANDOFF_VERSION,
  InvalidHandoffError,
  KIND_STORED_KEYS,
  MAX_HANDOFF_ITEMS,
  decodeHandoff,
  encodeHandoff,
  mergeHandoff,
} from "./preupload-handoff";
import {
  StoredKeysReceiver,
  StoredKeysSender,
  isStoredKeysFrame,
} from "./preupload-handoff";
import { advertisedCaps } from "./peer-caps.svelte";
import { encodeKey } from "./store-crypto";
import { deriveSession, generateKeyPair, ready, seal } from "./crypto";
import { FRAME } from "./transfer";
import { KIND_TEXT_ENC } from "./text-wire";

const key = (fill = 7) => encodeKey(new Uint8Array(32).fill(fill));
const item = (id: string, fill = 7) => ({ id, key: key(fill) });

describe("key-handoff codec", () => {
  it("round-trips a batch", () => {
    const items = [item("a1b2", 1), item("c3d4", 2)];
    expect(decodeHandoff(encodeHandoff(items))).toEqual(items);
  });

  it("emits the versioned shape the protocol fixes, in the fixed key order", () => {
    // Byte-for-byte, because the Swift port freezes fixtures against this and a
    // reordered key would silently invalidate them.
    expect(encodeHandoff([item("zz", 3)])).toBe(
      `{"v":${HANDOFF_VERSION},"items":[{"id":"zz","key":"${key(3)}"}]}`,
    );
  });

  it("refuses an unknown version outright rather than parsing what it recognises", () => {
    const future = JSON.stringify({ v: 2, items: [item("a", 1)] });
    expect(() => decodeHandoff(future)).toThrow(InvalidHandoffError);
  });

  it("refuses ids that would not be inert in a URL path", () => {
    for (const id of ["../me", "a/b", "a#b", "", "a b", "a".repeat(129)]) {
      expect(() => decodeHandoff(JSON.stringify({ v: 1, items: [{ id, key: key() }] })), id).toThrow(
        InvalidHandoffError,
      );
    }
  });

  it("refuses keys that are not exactly 32 base64url bytes", () => {
    const bad = [
      encodeKey(new Uint8Array(31)), // truncated
      encodeKey(new Uint8Array(33)), // overlong
      "not+base64url/", // standard alphabet
      "A", // a length base64 cannot produce
      "",
    ];
    for (const k of bad) {
      expect(() => decodeHandoff(JSON.stringify({ v: 1, items: [{ id: "ok", key: k }] })), k).toThrow(
        InvalidHandoffError,
      );
    }
  });

  it("refuses junk, wrong shapes and an empty or oversized set", () => {
    for (const payload of [
      "not json",
      "[]",
      "null",
      '"a string"',
      JSON.stringify({ v: 1 }),
      JSON.stringify({ v: 1, items: [] }),
      JSON.stringify({ v: 1, items: "nope" }),
      JSON.stringify({ v: 1, items: [null] }),
      JSON.stringify({ v: 1, items: [{ id: "a" }] }),
      JSON.stringify({ v: 1, items: [{ key: key() }] }),
      JSON.stringify({ v: 1, items: [{ id: 5, key: key() }] }),
      JSON.stringify({ v: 1, items: Array.from({ length: MAX_HANDOFF_ITEMS + 1 }, (_, i) => item(`id${i}`)) }),
    ]) {
      expect(() => decodeHandoff(payload), payload.slice(0, 40)).toThrow(InvalidHandoffError);
    }
  });

  it("refuses a duplicate id inside one message — that is malformed, not a retry", () => {
    expect(() => encodeHandoff([item("same", 1), item("same", 2)])).toThrow(InvalidHandoffError);
    expect(() =>
      decodeHandoff(JSON.stringify({ v: 1, items: [item("same", 1), item("same", 2)] })),
    ).toThrow(InvalidHandoffError);
  });

  it("never puts the offending value — an id or a real key — into the message", () => {
    const secret = key(9);
    try {
      decodeHandoff(JSON.stringify({ v: 1, items: [{ id: "../secret-path", key: secret }] }));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-path");
      expect((e as Error).message).not.toContain(secret);
    }
  });
});

describe("handoff retry and idempotency", () => {
  // The sender re-sends the WHOLE set on every (re)established link, which is
  // what makes a dropped link cost a re-send instead of a stranded transfer.
  // These are the rules that make blind resending safe.
  it("treats a re-delivered id as a no-op", () => {
    const first = [item("a", 1)];
    expect(mergeHandoff(first, first)).toEqual(first);
    expect(mergeHandoff(first, [...first, item("b", 2)])).toEqual([item("a", 1), item("b", 2)]);
  });

  it("keeps the key it is already downloading with when an id is re-sent with a different one", () => {
    const held = [item("a", 1)];
    expect(mergeHandoff(held, [item("a", 2)])).toEqual(held);
  });

  it("appends genuinely new items in arrival order", () => {
    const merged = mergeHandoff([item("a", 1)], [item("c", 3), item("b", 2)]);
    expect(merged.map((i) => i.id)).toEqual(["a", "c", "b"]);
  });

  it("does not mutate what it was given", () => {
    const held = [item("a", 1)];
    mergeHandoff(held, [item("b", 2)]);
    expect(held).toHaveLength(1);
  });
});

describe("capability gate", () => {
  it("is an exact, versioned capability on its own frame kind", () => {
    expect(CAP_PREUPLOAD).toBe("preupload/1");
    expect(KIND_STORED_KEYS).toBe(12);
  });

  // The bug this file exists to keep dead. The pair-room spec wrote STORED_KEYS
  // down as kind 10 because the realtime-wire kind registry never listed the two
  // transport-fragmentation kinds — and 10/11 have been CHUNK_PART/BATCH_PART on
  // the wire since fragmentation shipped, here and in the Swift port. A handoff
  // sent as kind 10 would not have been a new frame at all: the file receiver
  // would have authenticated it in sequence as a chunk fragment and spliced a
  // JSON list of object ids and keys into the middle of somebody's file.
  it("does not collide with any kind the file or text stream already uses", () => {
    const fileKinds = [
      FRAME.CHUNK, FRAME.CHUNK_PART, FRAME.BATCH, FRAME.DONE, FRAME.RESUME,
    ];
    expect(fileKinds).not.toContain(KIND_STORED_KEYS);
    // The two that were never in the registry, named explicitly so a future kind
    // cannot be chosen by reading the document instead of the code.
    expect(KIND_STORED_KEYS).not.toBe(10); // CHUNK_PART
    expect(KIND_STORED_KEYS).not.toBe(11); // BATCH_PART
    expect(KIND_STORED_KEYS).not.toBe(KIND_TEXT_ENC);
    // And it is distinguishable at the demux without decrypting anything.
    expect(isStoredKeysFrame(new Uint8Array([KIND_STORED_KEYS, 0, 0, 0, 0, ...new Uint8Array(16)]).buffer)).toBe(true);
    for (const k of [...fileKinds, 10, 11, KIND_TEXT_ENC]) {
      expect(isStoredKeysFrame(new Uint8Array([k, 0, 0, 0, 0, ...new Uint8Array(16)]).buffer), String(k)).toBe(false);
    }
    // A one-byte control frame is not one either — the two are structurally
    // disjoint, and reading a 0xfe ACCEPT as a truncated handoff would be a
    // second way to break the same lane.
    expect(isStoredKeysFrame(new Uint8Array([0xfe]).buffer)).toBe(false);
    // But a kind-12 frame TOO SHORT to be valid is still kind 12, and the demux
    // has to say so. The alternative is not "it is refused somewhere else": it
    // is the file receiver being handed a frame that was never part of its
    // sequence, which fails the whole lane. Refusing it belongs to
    // StoredKeysReceiver.open, and it does refuse it — see the case below.
    expect(isStoredKeysFrame(new Uint8Array([KIND_STORED_KEYS]).buffer)).toBe(true);
    expect(isStoredKeysFrame(new ArrayBuffer(0))).toBe(false);
  });

  it("IS advertised now that this build can both send and receive it", () => {
    // It stayed absent for a whole checkpoint on purpose: announcing a
    // capability before the code behind it exists invites a peer to send a frame
    // this side would treat as an unknown kind — a hard error that fails the
    // whole transfer, not a graceful degrade.
    expect(advertisedCaps()).toContain(CAP_PREUPLOAD);
  });
});

describe("the sealed handoff frame", () => {
  const keys = async () => {
    await ready();
    const a = generateKeyPair();
    const b = generateKeyPair();
    return {
      a: await deriveSession("initiator", a, b.publicKey),
      b: await deriveSession("responder", b, a.publicKey),
    };
  };

  it("round-trips a set through the peer's receiver", async () => {
    const { a, b } = await keys();
    const items = [item("obj1", 1), item("obj2", 2)];
    const frame = await new StoredKeysSender().frame(items, a.preuploadSend);
    expect(new Uint8Array(frame)[0]).toBe(KIND_STORED_KEYS);
    await expect(new StoredKeysReceiver().open(frame.buffer, b.preuploadRecv)).resolves.toEqual(items);
  });

  it("does not put the object ids or the keys on the wire in the clear", async () => {
    // The whole reason this is a SEALED frame and not a control frame: the relay
    // stores the ciphertext these ids name, and an id plus that ciphertext is
    // most of a transfer.
    const { a } = await keys();
    const secret = key(5);
    const frame = await new StoredKeysSender().frame([{ id: "sensitive-id", key: secret }], a.preuploadSend);
    const onWire = new TextDecoder("utf-8", { fatal: false }).decode(frame);
    expect(onWire).not.toContain("sensitive-id");
    expect(onWire).not.toContain(secret);
  });

  it("uses a key nobody else on the link holds", async () => {
    // Its own derived key, not the file stream's session key — which is what
    // lets it have its own counter and therefore be sent at any moment, ahead of
    // a batch, during a resume, without ordering against either.
    const { a, b } = await keys();
    const frame = await new StoredKeysSender().frame([item("x", 1)], a.preuploadSend);
    await expect(new StoredKeysReceiver().open(frame.buffer, b.recv)).rejects.toThrow();
    await expect(new StoredKeysReceiver().open(frame.buffer, b.textRecv)).rejects.toThrow();
  });

  it("advances one seq per frame and refuses a replay", async () => {
    const { a, b } = await keys();
    const sender = new StoredKeysSender();
    const first = await sender.frame([item("a", 1)], a.preuploadSend);
    const second = await sender.frame([item("a", 1), item("b", 2)], a.preuploadSend);
    const recv = new StoredKeysReceiver();
    await expect(recv.open(first.buffer, b.preuploadRecv)).resolves.toHaveLength(1);
    // A replay of a key list this side already consumed is refused outright.
    await expect(recv.open(first.buffer, b.preuploadRecv)).rejects.toThrow(InvalidHandoffError);
    await expect(recv.open(second.buffer, b.preuploadRecv)).resolves.toHaveLength(2);
  });

  it("accepts an authenticated frame that skipped a seq nobody ever received", async () => {
    // A seq is taken SYNCHRONOUSLY, before the seal and long before the send, so
    // a transport that dies (or a generation guard that fires, or a send that
    // throws) between those two moments burns it — the frame exists and is never
    // delivered. A receiver that insisted on the exact next seq would then refuse
    // every later whole-set resend for the life of the link, which is precisely
    // the transfer the resend rule exists to rescue. A gap is not a downgrade:
    // the frame still has to open under a key only the peer holds.
    const { a, b } = await keys();
    const sender = new StoredKeysSender();
    await sender.frame([item("a", 1)], a.preuploadSend); // burns seq 0, never delivered
    const second = await sender.frame([item("b", 2)], a.preuploadSend);
    const recv = new StoredKeysReceiver();
    await expect(recv.open(second.buffer, b.preuploadRecv)).resolves.toHaveLength(1);
    // And the stream is genuinely resynchronised, not just tolerant once.
    const third = await sender.frame([item("b", 2), item("c", 3)], a.preuploadSend);
    await expect(recv.open(third.buffer, b.preuploadRecv)).resolves.toHaveLength(2);
  });

  it("refuses a frame BEHIND what it has consumed, including the skipped one", async () => {
    // Forward tolerance is not backward tolerance. Everything at or before the
    // last consumed seq is a replay of a key list, and the burned frame that
    // finally turns up late is indistinguishable from one.
    const { a, b } = await keys();
    const sender = new StoredKeysSender();
    const burned = await sender.frame([item("a", 1)], a.preuploadSend); // seq 0
    const second = await sender.frame([item("b", 2)], a.preuploadSend); // seq 1
    const recv = new StoredKeysReceiver();
    await expect(recv.open(second.buffer, b.preuploadRecv)).resolves.toHaveLength(1);
    await expect(recv.open(burned.buffer, b.preuploadRecv)).rejects.toThrow(InvalidHandoffError);
    await expect(recv.open(second.buffer, b.preuploadRecv)).rejects.toThrow(InvalidHandoffError);
  });

  /** One handoff frame at an arbitrary seq, sealed by hand.
   *
   *  `StoredKeysSender` only ever produces VALID payloads and only ever counts
   *  upward, so the cases below — an authenticated frame carrying junk, and the
   *  legitimate frame that comes after it — cannot both come from one. Each seq
   *  here is sealed exactly ONCE: two ciphertexts under one nonce and one key is
   *  the AES-GCM failure this stream's separate key exists to prevent, and a test
   *  that arranges it is demonstrating the wrong thing. */
  const sealedFrame = async (key: CryptoKey, seq: number, payload: string) => {
    const sealed = await seal(key, seq, new TextEncoder().encode(payload) as Uint8Array<ArrayBuffer>);
    const frame = new Uint8Array(5 + sealed.length);
    frame[0] = KIND_STORED_KEYS;
    new DataView(frame.buffer).setUint32(1, seq);
    frame.set(sealed, 5);
    return frame;
  };

  it("spends the seq of a frame that authenticated but did not decode", async () => {
    // The seq IS the nonce, and the sender takes it BEFORE it seals: by the time
    // a payload turns out to be junk, that number is spent on the sending side
    // for good — no retry can ever reuse it, because reusing it under the same
    // derived key is exactly the AES-GCM catastrophe this stream is built to
    // avoid. So "authenticated" is what the counter has to move on. Waiting for
    // a successful DECODE instead leaves the number live on this side only, and
    // the frame carrying it can then be replayed at will.
    const { a, b } = await keys();
    const junk = await sealedFrame(a.preuploadSend, 0, "{not json");
    const recv = new StoredKeysReceiver();
    await expect(recv.open(junk.buffer, b.preuploadRecv)).rejects.toThrow(InvalidHandoffError);
    // The same frame again is a REPLAY now, not a fresh refusal — the point of
    // the whole rule, and the one assertion that can tell the two apart.
    await expect(recv.open(junk.buffer, b.preuploadRecv)).rejects.toThrow(/replayed/);
    // And the stream is not wedged: the sender's next frame, at a higher seq,
    // is taken exactly as it would have been.
    const good = await sealedFrame(a.preuploadSend, 1, encodeHandoff([item("a", 1)]));
    await expect(recv.open(good.buffer, b.preuploadRecv)).resolves.toHaveLength(1);
  });

  it("does not spend a seq for a frame that fails authentication", async () => {
    // The other side of the same rule. A frame that does not open was not
    // authored by the peer at all, so it says nothing about what the peer has
    // sent — and moving the expectation on it would let anyone who can put bytes
    // on this channel push the receiver past the seq the real frame is carrying.
    const { a, b } = await keys();
    const sender = new StoredKeysSender();
    const real = await sender.frame([item("a", 1)], a.preuploadSend); // seq 0
    const forged = new Uint8Array(real);
    forged[forged.length - 1] ^= 0xff;
    const recv = new StoredKeysReceiver();
    await expect(recv.open(forged.buffer, b.preuploadRecv)).rejects.toThrow();
    // Seq 0 was never the peer's to spend, and the genuine frame still lands.
    await expect(recv.open(real.buffer, b.preuploadRecv)).resolves.toHaveLength(1);
  });

  it("refuses a tampered frame instead of parsing what survived", async () => {
    const { a, b } = await keys();
    const frame = await new StoredKeysSender().frame([item("a", 1)], a.preuploadSend);
    const bad = new Uint8Array(frame);
    bad[bad.length - 1] ^= 0xff;
    await expect(new StoredKeysReceiver().open(bad.buffer, b.preuploadRecv)).rejects.toThrow();
  });

  it("refuses a frame of another kind, and a frame too short to be one", async () => {
    const { b } = await keys();
    const recv = new StoredKeysReceiver();
    await expect(recv.open(new Uint8Array([1, 0, 0, 0, 0, ...new Uint8Array(16)]).buffer, b.preuploadRecv))
      .rejects.toThrow(InvalidHandoffError);
    await expect(recv.open(new Uint8Array([KIND_STORED_KEYS, 0, 0]).buffer, b.preuploadRecv))
      .rejects.toThrow(InvalidHandoffError);
  });

  it("burns no seq on a set it refuses to encode", async () => {
    // A rejected message must not desynchronise the stream: the next legitimate
    // frame has to be the one the peer is expecting.
    const { a, b } = await keys();
    const sender = new StoredKeysSender();
    await expect(sender.frame([], a.preuploadSend)).rejects.toThrow(InvalidHandoffError);
    const frame = await sender.frame([item("a", 1)], a.preuploadSend);
    await expect(new StoredKeysReceiver().open(frame.buffer, b.preuploadRecv)).resolves.toHaveLength(1);
  });
});
