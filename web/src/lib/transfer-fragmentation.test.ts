import { beforeAll, describe, expect, it } from "vitest";
import { deriveSession, generateKeyPair, ready, seal, type SessionKeys } from "./crypto";
import {
  CHUNK_OVERHEAD,
  CHUNK_SIZE,
  FRAME,
  MANIFEST_MAX_BYTES,
  Receiver,
  Sender,
  isChunkFrame,
  resumePointAligned,
  type FileMeta,
  type ResumePoint,
} from "./transfer";
import { CHROME_MAX_MESSAGE_BYTES, CONSERVATIVE_MAX_MESSAGE_BYTES } from "./wire-limit";
import { TEXT_FRAME_OVERHEAD, TextReceiver, TextSender } from "./text-wire";

beforeAll(async () => { await ready(); });

async function session() {
  const a = generateKeyPair();
  const b = generateKeyPair();
  return {
    ka: await deriveSession("initiator", a, b.publicKey),
    kb: await deriveSession("responder", b, a.publicKey),
  };
}

/**
 * A DataChannel that behaves the way a real one does when handed a message
 * larger than the negotiated maximum: the send fails and the channel is
 * finished. This is the device behaviour the whole fragmentation layer exists
 * for — an Android peer whose SCTP endpoint accepts only 64 KiB drags the limit
 * down for whichever side is sending.
 */
function hardLimitedChannel(limit: number) {
  const sent: Uint8Array[] = [];
  let dead = false;
  return {
    sent,
    get dead() { return dead; },
    send(frame: Uint8Array) {
      if (dead) throw new Error("relayium-test: channel already closed by an oversize send");
      if (frame.byteLength > limit) {
        dead = true;
        throw new TypeError(
          `Failed to execute 'send' on 'RTCDataChannel': message too large (${frame.byteLength} > ${limit})`,
        );
      }
      sent.push(frame);
    },
  };
}

/** Deterministic, incompressible-enough content so a byte-for-byte comparison
 *  actually means something (an all-zero file passes even a broken reassembly). */
function content(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n) as Uint8Array<ArrayBuffer>;
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

const metaOf = (files: File[]): FileMeta[] => files.map((f) => ({ name: f.name, size: f.size }));

/**
 * The App's send/receive loop, reduced to what this file is about: every frame
 * goes through a channel with a hard limit, and the receiver writes and
 * checkpoints only whole logical chunks.
 */
async function transfer(
  files: File[],
  ka: SessionKeys,
  kb: SessionKeys,
  limit: number,
  opts: { sender?: Sender; receiver?: Receiver; sendLimit?: number; resume?: ResumePoint; stopAfterChunks?: number } = {},
) {
  const sender = opts.sender ?? new Sender();
  const receiver = opts.receiver ?? new Receiver();
  const channel = hardLimitedChannel(limit);
  const written: Uint8Array[][] = files.map(() => []);
  const oks: boolean[] = [];
  let index = opts.resume?.index ?? 0;
  let offset = opts.resume?.offset ?? 0;
  let checkpoint: { index: number; offset: number; chain: Uint8Array } =
    { index, offset, chain: receiver.snapshotChain() };
  let chunksSeen = 0;
  let parts = 0;

  const deliver = async (frame: Uint8Array<ArrayBuffer>) => {
    channel.send(frame); // throws exactly where a browser would
    if (frame[0] === FRAME.CHUNK_PART) parts++;
    const out = await receiver.feed(frame, kb);
    if (out.chunk) {
      written[index].push(out.chunk);
      offset += out.chunk.length;
      checkpoint = { index, offset, chain: receiver.snapshotChain() };
      chunksSeen++;
    }
    if (out.done) {
      oks[index] = out.done.ok;
      index++;
      offset = 0;
      checkpoint = { index, offset: 0, chain: new Uint8Array(32) };
    }
  };

  if (!opts.resume) {
    for (const f of await sender.batchFrames(metaOf(files), ka, opts.sendLimit ?? limit)) {
      await deliver(f);
    }
  } else {
    const announce = sender.resumeStartFrame(opts.resume);
    channel.send(announce);
    const out = await receiver.feed(announce, kb);
    receiver.resumeAt(checkpoint.chain, out.resume!.seq);
  }

  let stopped = false;
  for await (const frame of sender.dataFrames(files, ka, opts.resume, opts.sendLimit ?? limit)) {
    await deliver(frame);
    if (opts.stopAfterChunks !== undefined && chunksSeen >= opts.stopAfterChunks) { stopped = true; break; }
  }

  return { sender, receiver, channel, written, oks, checkpoint, parts, stopped, maxFrame: Math.max(0, ...channel.sent.map((f) => f.byteLength)) };
}

const joined = (pieces: Uint8Array[]) => {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of pieces) { out.set(p, off); off += p.length; }
  return out;
};

// ── the reported failure ────────────────────────────────────────────────────

describe("a peer that can only take 64 KiB messages", () => {
  it("kills a transfer framed at the old fixed chunk size", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE * 2 + 7, 11);
    const files = [new File([body], "photo.bin")];
    // The manifest is small, so it goes out fine: the receiver sees the accept
    // card, the user accepts — and then the first data frame kills the channel.
    // That is exactly the reported shape (text works, files fail every time).
    await expect(
      transfer(files, ka, kb, CONSERVATIVE_MAX_MESSAGE_BYTES, { sendLimit: CHUNK_SIZE + CHUNK_OVERHEAD }),
    ).rejects.toThrow(/message too large/);
  });

  it("delivers the same multi-chunk file byte for byte when the frames follow the limit", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE * 3 + 1234, 22);
    const files = [new File([body], "photo.bin")];

    const r = await transfer(files, ka, kb, CONSERVATIVE_MAX_MESSAGE_BYTES);

    expect(r.channel.dead).toBe(false);
    expect(r.maxFrame).toBeLessThanOrEqual(CONSERVATIVE_MAX_MESSAGE_BYTES);
    expect(r.parts).toBeGreaterThan(0); // it really did fragment
    expect(joined(r.written[0])).toEqual(body);
    expect(r.oks).toEqual([true]); // the chained SHA-256 still agrees
  });

  it("reassembles into whole CHUNK_SIZE units, so checkpoints stay on the grid", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE * 2 + 5, 33);
    const r = await transfer([new File([body], "a.bin")], ka, kb, CONSERVATIVE_MAX_MESSAGE_BYTES);
    // Three logical chunks arrived, not the ~10 messages that carried them.
    expect(r.written[0].map((c) => c.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 5]);
  });

  it("carries several files and a folder manifest intact", async () => {
    const { ka, kb } = await session();
    const bodies = [content(CHUNK_SIZE + 3, 41), content(9, 42), content(CHUNK_SIZE * 2, 43)];
    const files = bodies.map((b, i) => new File([b], `f${i}.bin`));
    const r = await transfer(files, ka, kb, CONSERVATIVE_MAX_MESSAGE_BYTES);
    expect(r.oks).toEqual([true, true, true]);
    bodies.forEach((b, i) => expect(joined(r.written[i])).toEqual(b));
  });
});

// ── the boundary the bug lived on ───────────────────────────────────────────

describe("frame-size boundaries", () => {
  it("emits the identical unfragmented wire when a whole chunk fits", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE + 10, 51);
    const r = await transfer([new File([body], "a.bin")], ka, kb, CHUNK_SIZE + CHUNK_OVERHEAD);
    expect(r.parts).toBe(0);
    expect(r.maxFrame).toBe(CHUNK_SIZE + CHUNK_OVERHEAD);
    expect(joined(r.written[0])).toEqual(body);
  });

  it("fragments as soon as the limit is one byte short of a whole chunk", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE + 10, 52);
    const limit = CHUNK_SIZE + CHUNK_OVERHEAD - 1;
    const r = await transfer([new File([body], "a.bin")], ka, kb, limit);
    expect(r.parts).toBeGreaterThan(0);
    expect(r.maxFrame).toBeLessThanOrEqual(limit);
    expect(joined(r.written[0])).toEqual(body);
  });

  it("never exceeds the limit on a chunk that divides it exactly", async () => {
    const { ka, kb } = await session();
    // 64 KiB of plaintext per piece exactly: the last piece of a chunk lands on
    // the boundary, and no trailing empty frame may be emitted.
    const limit = 64 * 1024 + CHUNK_OVERHEAD;
    const body = content(CHUNK_SIZE * 2, 53);
    const r = await transfer([new File([body], "a.bin")], ka, kb, limit);
    expect(r.maxFrame).toBe(limit);
    expect(joined(r.written[0])).toEqual(body);
    expect(r.oks).toEqual([true]);
  });

  it("handles an empty file and a one-byte file", async () => {
    const { ka, kb } = await session();
    const files = [new File([new Uint8Array(0)], "empty.bin"), new File([new Uint8Array([7])], "one.bin")];
    const r = await transfer(files, ka, kb, CONSERVATIVE_MAX_MESSAGE_BYTES);
    expect(r.oks).toEqual([true, true]);
    expect(joined(r.written[0]).length).toBe(0);
    expect(joined(r.written[1])).toEqual(new Uint8Array([7]));
  });

  it("refuses a connection too small to transfer over, instead of framing round it", async () => {
    const { ka, kb } = await session();
    await expect(transfer([new File([content(10, 1)], "a.bin")], ka, kb, 512))
      .rejects.toThrow(/too small to send files/);
  });
});

// ── manifests ───────────────────────────────────────────────────────────────

describe("the manifest", () => {
  it("is fragmented too when it does not fit one message", async () => {
    const { ka, kb } = await session();
    // A folder deep enough that the manifest alone exceeds 64 KiB — the second
    // frame the old code could hand a 64 KiB peer and lose.
    const files: FileMeta[] = Array.from({ length: 900 }, (_, i) => ({
      name: `image-${i}.jpg`,
      size: 1000 + i,
      path: `holiday/2026/summer/week-${i % 7}/camera-roll/batch-${i}/image-${i}.jpg`,
    }));
    const sender = new Sender();
    const receiver = new Receiver();
    const frames = await sender.batchFrames(files, ka, CONSERVATIVE_MAX_MESSAGE_BYTES);

    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) expect(f.byteLength).toBeLessThanOrEqual(CONSERVATIVE_MAX_MESSAGE_BYTES);

    let batch;
    for (const f of frames) batch = (await receiver.feed(f, kb)).batch ?? batch;
    expect(batch!.files).toHaveLength(900);
    expect(batch!.files[899].path).toBe(files[899].path);
  });

  it("is one frame on a connection that can carry it", async () => {
    const { ka, kb } = await session();
    const frames = await new Sender().batchFrames([{ name: "a.bin", size: 1 }], ka, CHROME_MAX_MESSAGE_BYTES);
    expect(frames).toHaveLength(1);
    expect(new Receiver().feed(frames[0], kb)).resolves.toBeTruthy();
  });

  it("still refuses one that exceeds the protocol maximum, whatever the connection allows", async () => {
    const { ka } = await session();
    const many: FileMeta[] = Array.from({ length: 4000 }, (_, i) => ({
      name: `${"n".repeat(60)}-${i}.bin`, size: i, path: `${"d".repeat(60)}/${i}`,
    }));
    await expect(new Sender().batchFrames(many, ka, Infinity)).rejects.toThrow(/manifest too large/);
  });

  it("carries a manifest that only just fits, across many frames", async () => {
    const { ka, kb } = await session();
    const files: FileMeta[] = Array.from({ length: 900 }, (_, i) => ({
      name: `${"n".repeat(40)}-${i}.bin`, size: i, path: `${"d".repeat(40)}/${i}`,
    }));
    const frames = await new Sender().batchFrames(files, ka, 8192 + CHUNK_OVERHEAD);
    expect(frames.length).toBeGreaterThan(10);
    const receiver = new Receiver();
    let batch;
    for (const f of frames) batch = (await receiver.feed(f, kb)).batch ?? batch;
    expect(batch!.files).toHaveLength(900);
  });
});

// ── what a hostile peer can make the receiver do ────────────────────────────

describe("receiver bounds on fragments", () => {
  /** One hand-built frame, the way a peer that is not this code would send it. */
  async function rawFrame(kind: number, seq: number, plain: Uint8Array, key: CryptoKey) {
    const sealed = await seal(key, seq, plain as Uint8Array<ArrayBuffer>);
    const out = new Uint8Array(5 + sealed.length);
    out[0] = kind;
    new DataView(out.buffer).setUint32(1, seq);
    out.set(sealed, 5);
    return out as Uint8Array<ArrayBuffer>;
  }

  it("refuses to buffer more than one logical chunk of fragments", async () => {
    const { ka, kb } = await session();
    const receiver = new Receiver();
    const piece = new Uint8Array(64 * 1024);
    let seq = 0;
    // Pieces that never terminate. Three of them exactly fill one logical chunk;
    // the fourth would take the receiver past it, and must not be buffered.
    for (let i = 0; i < 3; i++) {
      await receiver.feed(await rawFrame(FRAME.CHUNK_PART, seq++, piece, ka.send), kb);
    }
    await expect(receiver.feed(await rawFrame(FRAME.CHUNK_PART, seq++, piece, ka.send), kb))
      .rejects.toThrow(/oversized fragmented frame/);
  });

  // The bound above is only half a bound if a peer can skip the PART kinds
  // entirely. One authenticated terminal frame is the cheapest way to hand the
  // receiver an arbitrarily large plaintext: it is decrypted, held whole, then
  // hashed (a chunk) or JSON-parsed (a manifest) — all before any consent.
  it("refuses one unfragmented chunk frame larger than a logical chunk", async () => {
    const { ka, kb } = await session();
    const receiver = new Receiver();
    await expect(receiver.feed(await rawFrame(FRAME.CHUNK, 0, new Uint8Array(CHUNK_SIZE + 1), ka.send), kb))
      .rejects.toThrow(/oversized frame/);
  });

  it("refuses one unfragmented manifest frame larger than the protocol maximum", async () => {
    const { ka, kb } = await session();
    const receiver = new Receiver();
    await expect(receiver.feed(await rawFrame(FRAME.BATCH, 0, new Uint8Array(MANIFEST_MAX_BYTES + 1), ka.send), kb))
      .rejects.toThrow(/oversized frame/);
  });

  it("still accepts a terminal frame that lands exactly on the limit", async () => {
    const { ka, kb } = await session();
    // A whole chunk, unfragmented: the common desktop case, and one byte below
    // what the check above refuses.
    const chunk = await new Receiver().feed(
      await rawFrame(FRAME.CHUNK, 0, new Uint8Array(CHUNK_SIZE), ka.send), kb,
    );
    expect(chunk.chunk!.length).toBe(CHUNK_SIZE);

    // JSON tolerates trailing whitespace, so a real manifest can be padded to
    // the exact byte the limit allows and must still parse.
    const body = JSON.stringify({ files: [{ name: "a.bin", size: 1 }] });
    const padded = body + " ".repeat(MANIFEST_MAX_BYTES - body.length);
    const out = await new Receiver().feed(
      await rawFrame(FRAME.BATCH, 0, new TextEncoder().encode(padded), ka.send), kb,
    );
    expect(out.batch!.files).toHaveLength(1);
  });

  it("still accepts an empty terminal frame", async () => {
    const { ka, kb } = await session();
    const out = await new Receiver().feed(await rawFrame(FRAME.CHUNK, 0, new Uint8Array(0), ka.send), kb);
    expect(out.chunk!.length).toBe(0);
  });

  it("counts buffered fragments and the terminal frame against one limit", async () => {
    const { ka, kb } = await session();
    const receiver = new Receiver();
    await receiver.feed(await rawFrame(FRAME.CHUNK_PART, 0, new Uint8Array(CHUNK_SIZE - 1), ka.send), kb);
    await expect(receiver.feed(await rawFrame(FRAME.CHUNK, 1, new Uint8Array(2), ka.send), kb))
      .rejects.toThrow(/oversized frame/);
  });

  it("refuses fragments of two different things interleaved", async () => {
    const { ka, kb } = await session();
    const receiver = new Receiver();
    await receiver.feed(await rawFrame(FRAME.CHUNK_PART, 0, new Uint8Array(16), ka.send), kb);
    await expect(receiver.feed(await rawFrame(11 /* BATCH_PART */, 1, new Uint8Array(16), ka.send), kb))
      .rejects.toThrow(/interleaved partial frames/);
  });

  it("holds fragments to the same nonce order as whole frames", async () => {
    const { ka, kb } = await session();
    const receiver = new Receiver();
    await expect(receiver.feed(await rawFrame(FRAME.CHUNK_PART, 7, new Uint8Array(16), ka.send), kb))
      .rejects.toThrow(/out-of-order/);
  });

  it("throws away half a chunk when a resume rewinds to a durable checkpoint", async () => {
    const { ka, kb } = await session();
    const receiver = new Receiver();
    await receiver.feed(await rawFrame(FRAME.CHUNK_PART, 0, new Uint8Array(1024), ka.send), kb);
    // The replacement transport restarts at the last whole chunk; the orphaned
    // piece must not be prepended to whatever arrives next.
    receiver.resumeAt(new Uint8Array(32), 1);
    const out = await receiver.feed(await rawFrame(FRAME.CHUNK, 1, new Uint8Array([1, 2, 3]), ka.send), kb);
    expect(out.chunk).toEqual(new Uint8Array([1, 2, 3]));
  });
});

// ── resume, treated as adversarial ──────────────────────────────────────────

describe("resume across a change of message size", () => {
  it("finishes byte-for-byte when the replacement connection allows LESS", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE * 4 + 99, 61);
    const files = [new File([body], "big.bin")];

    // First attempt on a desktop-class connection; drop after two chunks.
    const first = await transfer(files, ka, kb, CHROME_MAX_MESSAGE_BYTES, { stopAfterChunks: 2 });
    expect(first.stopped).toBe(true);
    expect(first.parts).toBe(0);
    expect(first.checkpoint.offset).toBe(CHUNK_SIZE * 2);

    // The peer comes back on a path that negotiates only 64 KiB.
    const second = await transfer(files, ka, kb, CONSERVATIVE_MAX_MESSAGE_BYTES, {
      sender: first.sender, receiver: first.receiver,
      resume: { index: first.checkpoint.index, offset: first.checkpoint.offset },
    });
    expect(second.parts).toBeGreaterThan(0);
    expect(second.maxFrame).toBeLessThanOrEqual(CONSERVATIVE_MAX_MESSAGE_BYTES);

    const got = joined([...first.written[0], ...second.written[0]]);
    expect(got.length).toBe(body.length); // no skipped and no duplicated bytes
    expect(got).toEqual(body);
    expect(second.oks).toEqual([true]); // the chain hash survived the size change
  });

  it("finishes byte-for-byte when the replacement connection allows MORE", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE * 3 + 5, 62);
    const files = [new File([body], "big.bin")];

    const first = await transfer(files, ka, kb, CONSERVATIVE_MAX_MESSAGE_BYTES, { stopAfterChunks: 1 });
    expect(first.parts).toBeGreaterThan(0);
    const second = await transfer(files, ka, kb, CHROME_MAX_MESSAGE_BYTES, {
      sender: first.sender, receiver: first.receiver,
      resume: { index: first.checkpoint.index, offset: first.checkpoint.offset },
    });
    expect(second.parts).toBe(0);

    expect(joined([...first.written[0], ...second.written[0]])).toEqual(body);
    expect(second.oks).toEqual([true]);
  });

  it("never rewinds a nonce across the size change", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE * 2 + 3, 63);
    const files = [new File([body], "big.bin")];
    const first = await transfer(files, ka, kb, CHROME_MAX_MESSAGE_BYTES, { stopAfterChunks: 1 });
    const seqs = first.channel.sent.filter(isChunkFrame)
      .map((f) => new DataView(f.buffer, f.byteOffset).getUint32(1));
    const second = await transfer(files, ka, kb, CONSERVATIVE_MAX_MESSAGE_BYTES, {
      sender: first.sender, receiver: first.receiver,
      resume: { index: first.checkpoint.index, offset: first.checkpoint.offset },
    });
    const resumed = second.channel.sent.filter(isChunkFrame)
      .map((f) => new DataView(f.buffer, f.byteOffset).getUint32(1));
    expect(Math.min(...resumed)).toBeGreaterThan(Math.max(...seqs));
    expect(new Set(resumed).size).toBe(resumed.length);
  });

  it("refuses a resume point that is not on the chunk grid", async () => {
    const { ka } = await session();
    const body = content(CHUNK_SIZE * 2, 64);
    const files = [new File([body], "big.bin")];
    const sizes = [body.length];

    expect(resumePointAligned({ index: 0, offset: 0 }, sizes)).toBe(true);
    expect(resumePointAligned({ index: 0, offset: CHUNK_SIZE }, sizes)).toBe(true);
    expect(resumePointAligned({ index: 0, offset: body.length }, sizes)).toBe(true);
    expect(resumePointAligned({ index: 0, offset: 100_000 }, sizes)).toBe(false);
    expect(resumePointAligned({ index: 4, offset: 0 }, sizes)).toBe(false);

    // Honouring an unaligned point would silently skip the bytes between it and
    // the next boundary, so the sender refuses to start at all.
    const gen = new Sender().dataFrames(files, ka, { index: 0, offset: 100_000 });
    await expect(gen.next()).rejects.toThrow(/not on a chunk boundary/);
  });

  it("rejects a mid-chunk end of file rather than hashing a short chunk", async () => {
    const { ka, kb } = await session();
    const body = content(CHUNK_SIZE + 100, 65);
    const sender = new Sender();
    const receiver = new Receiver();
    const frames: Uint8Array<ArrayBuffer>[] = [];
    for await (const f of sender.dataFrames([new File([body], "a.bin")], ka, undefined, CONSERVATIVE_MAX_MESSAGE_BYTES)) {
      frames.push(f);
    }
    // Drop the frame that terminates the first logical chunk, keeping its parts.
    const firstChunkAt = frames.findIndex((f) => f[0] === FRAME.CHUNK);
    const doctored = frames.filter((_, i) => i !== firstChunkAt);
    await expect((async () => {
      for (const f of doctored) await receiver.feed(f, kb);
    })()).rejects.toThrow();
  });
});

// ── what must NOT change ────────────────────────────────────────────────────

describe("unaffected paths", () => {
  it("leaves an ordinary text message one small frame", async () => {
    const { ka } = await session();
    const body = "hello from the other device";
    const frame = await new TextSender().frame(body, ka.textSend);
    expect(frame.byteLength).toBe(new TextEncoder().encode(body).length + TEXT_FRAME_OVERHEAD);
    expect(frame.byteLength).toBeLessThan(CONSERVATIVE_MAX_MESSAGE_BYTES);
  });

  it("round-trips text over a 64 KiB channel untouched", async () => {
    const { ka, kb } = await session();
    const channel = hardLimitedChannel(CONSERVATIVE_MAX_MESSAGE_BYTES);
    const body = "跨设备发一段文字 " + "x".repeat(4000);
    const frame = await new TextSender().frame(body, ka.textSend);
    channel.send(frame);
    expect(channel.dead).toBe(false);
    expect(await new TextReceiver().feed(frame, kb.textRecv)).toBe(body);
  });

  it("gives fragments kind bytes no earlier build ever accepted", async () => {
    // A build that predates fragmentation parsed kinds 1..8 and threw
    // "unknown frame kind" on everything else. Keeping PART outside that set is
    // what makes a mixed-version pair fail loudly instead of writing a fragment
    // as if it were a whole chunk.
    expect(FRAME.CHUNK_PART).toBeGreaterThan(9);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9]).not.toContain(FRAME.CHUNK_PART);
  });
});
