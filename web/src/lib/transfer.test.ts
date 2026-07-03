import { describe, it, expect, beforeAll } from "vitest";
import { ready, generateKeyPair, deriveSession } from "./crypto";
import {
  Sender, Receiver, FRAME, CHUNK_SIZE, CHUNK_OVERHEAD, FLOW_WINDOW, FLOW_ACK_INTERVAL,
  ackFrame, parseAck, type ResumePoint,
} from "./transfer";

beforeAll(async () => { await ready(); });

const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
};
const seqOf = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset).getUint32(1);

// Drive a batch, cut the connection after `dropAfterChunks` chunks are durably
// handled, optionally lose `loss` further chunks in flight (the sender advanced
// its nonce for them but the receiver never saw them), then resume from the
// receiver's checkpoint and finish. Mirrors the App's receiver bookkeeping:
// the checkpoint is taken only after a chunk is "written".
async function driveWithDrop(
  files: File[],
  ka: Awaited<ReturnType<typeof session>>["ka"],
  kb: Awaited<ReturnType<typeof session>>["kb"],
  dropAfterChunks: number,
  loss = 0,
) {
  const sender = new Sender();
  const receiver = new Receiver();
  const written: Uint8Array[][] = files.map(() => []);
  const oks: boolean[] = [];
  const seqsUsed: number[] = [];
  let fileIndex = 0;
  let offset = 0;
  let checkpoint: { index: number; offset: number; chain: Uint8Array } = { index: 0, offset: 0, chain: new Uint8Array(32) };

  await receiver.feed(sender.batchFrame(files.map((f) => ({ name: f.name, size: f.size }))), kb);

  const handle = async (f: Uint8Array<ArrayBuffer>) => {
    if (f[0] === FRAME.CHUNK) seqsUsed.push(seqOf(f));
    const out = await receiver.feed(f, kb);
    if (out.chunk) {
      written[fileIndex].push(out.chunk);
      offset += out.chunk.length;
      checkpoint = { index: fileIndex, offset, chain: receiver.snapshotChain() };
    }
    if (out.done) {
      oks[fileIndex] = out.done.ok;
      fileIndex++;
      offset = 0;
      checkpoint = { index: fileIndex, offset: 0, chain: new Uint8Array(32) };
    }
  };

  // Phase 1: stream until the drop point.
  const gen1 = sender.dataFrames(files, ka);
  let handled = 0;
  for (;;) {
    const { value, done } = await gen1.next();
    if (done) break;
    await handle(value);
    if (value[0] === FRAME.CHUNK && ++handled >= dropAfterChunks) break;
  }
  // Simulate `loss` chunks the sender put on the wire that never arrived: pull
  // them so the sender's nonce advances, but don't feed the receiver.
  for (let i = 0; i < loss; i++) {
    const { value, done } = await gen1.next();
    if (done) break;
    if (value[0] === FRAME.CHUNK) seqsUsed.push(seqOf(value));
  }
  // gen1 abandoned — the connection is gone.

  // Phase 2: resume from the receiver's last durable checkpoint.
  const rp: ResumePoint = { index: checkpoint.index, offset: checkpoint.offset };
  const rout = await receiver.feed(sender.resumeStartFrame(rp), kb);
  receiver.resumeAt(checkpoint.chain, rout.resume!.seq);
  fileIndex = checkpoint.index;
  offset = checkpoint.offset;
  for await (const f of sender.dataFrames(files, ka, rp)) await handle(f);

  return { joined: written.map(concat), oks, seqsUsed };
}

async function session() {
  const a = generateKeyPair();
  const b = generateKeyPair();
  const ka = await deriveSession("initiator", a, b.publicKey);
  const kb = await deriveSession("responder", b, a.publicKey);
  return { ka, kb };
}

// Drive a whole batch through Sender -> Receiver, reconstructing each file and
// collecting the per-file integrity verdicts. Returns one Uint8Array per file.
async function roundTrip(
  files: File[],
  ka: Awaited<ReturnType<typeof session>>["ka"],
  kb: Awaited<ReturnType<typeof session>>["kb"],
) {
  const sender = new Sender();
  const receiver = new Receiver();

  const manifestOut = await receiver.feed(
    sender.batchFrame(files.map((f) => ({ name: f.name, size: f.size }))),
    kb,
  );

  const parts: Uint8Array[][] = [[]];
  const oks: boolean[] = [];
  let idx = 0;
  for await (const frame of sender.dataFrames(files, ka)) {
    const out = await receiver.feed(frame, kb);
    if (out.chunk) (parts[idx] ??= []).push(out.chunk);
    if (out.done) { oks.push(out.done.ok); idx++; }
  }

  const joined = parts.map((chunks) => {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.length; }
    return buf;
  });
  return { manifest: manifestOut.batch!, oks, joined };
}

describe("transfer", () => {
  it("round-trips a multi-file batch with per-file integrity", async () => {
    const { ka, kb } = await session();
    const a = new Uint8Array(200_000).map((_, i) => i % 251);
    const b = new Uint8Array(5_000).map((_, i) => (i * 7) % 256);
    const files = [new File([a], "build.tar.gz"), new File([b], "notes.txt")];

    const { manifest, oks, joined } = await roundTrip(files, ka, kb);

    expect(manifest.files).toEqual([
      { name: "build.tar.gz", size: 200_000 },
      { name: "notes.txt", size: 5_000 },
    ]);
    expect(oks).toEqual([true, true]);
    expect(joined[0]).toEqual(a);
    expect(joined[1]).toEqual(b);
  });

  it("handles a zero-byte file in the batch", async () => {
    const { ka, kb } = await session();
    const files = [new File([], "empty.bin"), new File([new Uint8Array(100)], "x.bin")];
    const { oks } = await roundTrip(files, ka, kb);
    expect(oks).toEqual([true, true]);
  });

  it("carries a folder-relative path through the manifest", async () => {
    const { kb } = await session();
    const sender = new Sender();
    const out = await new Receiver().feed(
      sender.batchFrame([{ name: "a.jpg", size: 3, path: "trip/day1/a.jpg" }]),
      kb,
    );
    expect(out.batch!.files[0].path).toBe("trip/day1/a.jpg");
  });

  it("rejects a manifest that would exceed the DataChannel message ceiling", () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({
      name: `file-${i}.bin`,
      size: i,
      path: `deeply/nested/folder/path/segment/file-${i}.bin`,
    }));
    expect(() => new Sender().batchFrame(many)).toThrow(/manifest too large/);
  });

  it("reports integrity failure when a chunk is corrupted", async () => {
    const { ka, kb } = await session();
    const file = new File([new Uint8Array(100_000)], "x.bin");
    const sender = new Sender();
    const receiver = new Receiver();
    await receiver.feed(sender.batchFrame([{ name: file.name, size: file.size }]), kb);

    let ok: boolean | undefined;
    let first = true;
    for await (const frame of sender.dataFrames([file], ka)) {
      // Flip a byte in the first chunk frame's ciphertext (after the 5-byte header).
      if (first && frame[0] === 1) { frame[10] ^= 0xff; first = false; }
      try {
        const out = await receiver.feed(frame, kb);
        if (out.done) ok = out.done.ok;
      } catch {
        ok = false; // AEAD open throws on tamper — a detected failure
      }
    }
    expect(ok).toBe(false);
  });
});

describe("resumable transfer", () => {
  // Deterministic bytes so reconstruction can be compared exactly.
  const bytes = (n: number, salt = 0) => new Uint8Array(n).map((_, i) => (i * 31 + salt) % 251);
  const strictlyIncreasing = (a: number[]) => a.every((v, i) => i === 0 || v > a[i - 1]);

  it("resumes mid-file and reconstructs the whole file", async () => {
    const { ka, kb } = await session();
    const data = bytes(3 * CHUNK_SIZE + 1234);
    const files = [new File([data], "big.bin")];
    const { joined, oks, seqsUsed } = await driveWithDrop(files, ka, kb, 1); // drop after 1 chunk

    expect(oks).toEqual([true]);
    expect(joined[0]).toEqual(data);
    expect(strictlyIncreasing(seqsUsed)).toBe(true); // nonce monotonic → never reused
  });

  it("resumes at a file boundary (drop just before DONE)", async () => {
    const { ka, kb } = await session();
    const a = bytes(2 * CHUNK_SIZE, 1); // exactly 2 chunks
    const b = bytes(CHUNK_SIZE + 500, 2);
    const files = [new File([a], "a.bin"), new File([b], "b.bin")];
    const { joined, oks, seqsUsed } = await driveWithDrop(files, ka, kb, 2); // drop after a's 2 chunks

    expect(oks).toEqual([true, true]);
    expect(joined[0]).toEqual(a);
    expect(joined[1]).toEqual(b);
    expect(strictlyIncreasing(seqsUsed)).toBe(true);
  });

  it("resumes into a later file when the drop lands mid second file", async () => {
    const { ka, kb } = await session();
    const a = bytes(2 * CHUNK_SIZE, 3);
    const b = bytes(3 * CHUNK_SIZE, 4);
    const files = [new File([a], "a.bin"), new File([b], "b.bin")];
    const { joined, oks } = await driveWithDrop(files, ka, kb, 3); // a(2 chunks)+DONE, then 1 of b

    expect(oks).toEqual([true, true]);
    expect(joined[0]).toEqual(a);
    expect(joined[1]).toEqual(b);
  });

  it("never reuses a nonce when chunks are lost in flight", async () => {
    const { ka, kb } = await session();
    const data = bytes(5 * CHUNK_SIZE, 7);
    const files = [new File([data], "big.bin")];
    // Drop after 2 durable chunks, and lose 2 more that the sender already sent
    // (their nonces are burned and must never be reused on resume).
    const { joined, oks, seqsUsed } = await driveWithDrop(files, ka, kb, 2, 2);

    expect(oks).toEqual([true]);
    expect(joined[0]).toEqual(data); // resend of the lost byte-range reconstructs correctly
    expect(strictlyIncreasing(seqsUsed)).toBe(true);
    expect(new Set(seqsUsed).size).toBe(seqsUsed.length); // no duplicate nonce, ever
    expect(seqsUsed.length).toBeGreaterThan(5); // includes the 2 burned seqs
  });

  it("round-trips a resume-request frame", async () => {
    const { resumeReqFrame, parseResumeReq } = await import("./transfer");
    const f = resumeReqFrame(3, 987654);
    expect(parseResumeReq(f.buffer as ArrayBuffer)).toEqual({ index: 3, offset: 987654 });
    // A non-resume-req frame decodes to null.
    expect(parseResumeReq(new Uint8Array([1, 0, 0, 0, 0]).buffer)).toBeNull();
  });
});

describe("flow-control ack frame", () => {
  it("round-trips a byte count, including large (>4 GiB) values", async () => {
    const { ackFrame, parseAck } = await import("./transfer");
    for (const n of [0, 1, 512 * 1024, 8 << 20, 5_000_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(parseAck(ackFrame(n).buffer as ArrayBuffer)).toBe(n);
    }
  });

  it("decodes to null for frames that are not acks", async () => {
    const { ackFrame, parseAck, ACCEPT, COMPLETE, resumeReqFrame } = await import("./transfer");
    // Wrong length (a single-byte control frame) and wrong kind both reject.
    expect(parseAck(ACCEPT.buffer as ArrayBuffer)).toBeNull();
    expect(parseAck(COMPLETE.buffer as ArrayBuffer)).toBeNull();
    expect(parseAck(resumeReqFrame(1, 2).buffer as ArrayBuffer)).toBeNull();
    // A 13-byte frame with the wrong kind byte still rejects.
    const notAck = ackFrame(123).slice();
    notAck[0] = 1;
    expect(parseAck(notAck.buffer as ArrayBuffer)).toBeNull();
  });

  it("does not collide with the receiver->sender control decoders", async () => {
    const { controlKind, parseResumeReq } = await import("./transfer");
    const buf = ackFrame(1 << 20).buffer as ArrayBuffer;
    expect(controlKind(buf)).toBeNull();
    expect(parseResumeReq(buf)).toBeNull();
  });

  // The App's send loop gates on the receiver's acks so it can't outrun a slow
  // receiver (no receive-side backpressure exists in the DataChannel itself). This
  // reconstructs that loop over the real Sender/Receiver + ack wire format with a
  // receiver that drains one chunk per tick, and asserts the two properties the fix
  // guarantees: the sender never runs more than one window ahead of durable writes
  // (bounds receiver memory), and the whole batch still arrives intact.
  it("keeps the sender within one flow-control window of a slow receiver", async () => {
    const { ka, kb } = await session();
    const bytes = new Uint8Array(10 << 20); // 10 MB > one window
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) % 251; // cheap non-trivial fill

    const sender = new Sender();
    const receiver = new Receiver();
    await receiver.feed(sender.batchFrame([{ name: "big.bin", size: bytes.length }]), kb);

    // Pre-encrypt every data frame (the wire the App would send).
    const frames: Uint8Array[] = [];
    for await (const f of sender.dataFrames([new File([bytes], "big.bin")], ka)) frames.push(f);

    const wire: Uint8Array[] = []; // sender -> receiver, drained one per tick (slow disk)
    let si = 0, sent = 0, acked = 0, got = 0, lastAckSent = 0, maxAhead = 0, ok = false;

    while (si < frames.length || wire.length) {
      // Sender: emit while its credit allows — mirrors `await creditGate(sent)`.
      while (si < frames.length && sent - acked <= FLOW_WINDOW) {
        const f = frames[si++];
        wire.push(f);
        if (f[0] === FRAME.CHUNK) sent += f.byteLength - CHUNK_OVERHEAD;
        maxAhead = Math.max(maxAhead, sent - acked);
      }
      // Receiver: durably "write" one frame, then ack on the interval boundary.
      const out = await receiver.feed(wire.shift()! as Uint8Array<ArrayBuffer>, kb);
      if (out.chunk) {
        got += out.chunk.length;
        if (got - lastAckSent >= FLOW_ACK_INTERVAL) {
          lastAckSent = got;
          acked = parseAck(ackFrame(got).buffer as ArrayBuffer)!; // real ack round-trip
        }
      }
      if (out.done) ok = out.done.ok; // per-file SHA-256 integrity verdict
    }

    expect(got).toBe(bytes.length); // whole batch arrived
    expect(ok).toBe(true); // …and passed its integrity hash
    expect(maxAhead).toBeLessThanOrEqual(FLOW_WINDOW + CHUNK_SIZE); // bounded receiver memory
    expect(maxAhead).toBeGreaterThan(FLOW_WINDOW - CHUNK_SIZE); // window actually engaged (test is meaningful)
  }, 30_000);
});
