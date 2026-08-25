import { describe, it, expect, beforeAll } from "vitest";
import { ready, generateKeyPair, deriveSession, type SessionKeys } from "./crypto";
import {
  Sender, Receiver, FRAME, CHUNK_SIZE, CHUNK_OVERHEAD, FLOW_WINDOW, FLOW_ACK_INTERVAL,
  ACCEPT, REJECT, COMPLETE, FILE_BUSY, BATCH_ABORT, ackFrame, advanceAck, controlKind, isBatchAbort, parseAck, parseResumeReq,
  resumePointInRange, type ResumePoint,
} from "./transfer";

beforeAll(async () => { await ready(); });

/** The manifest as the single frame it is on any connection that can carry a
 *  whole chunk. Fragmented manifests have their own suite (wire-limit tests);
 *  asserting the count here keeps those two cases from quietly merging. */
async function batchFrame(s: Sender, files: Parameters<Sender["batchFrames"]>[0], keys: SessionKeys) {
  const frames = await s.batchFrames(files, keys);
  expect(frames).toHaveLength(1);
  return frames[0];
}

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

  await receiver.feed(await batchFrame(sender, files.map((f) => ({ name: f.name, size: f.size })), ka), kb);

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
    await batchFrame(sender, files.map((f) => ({ name: f.name, size: f.size })), ka),
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

  it("reads exactly one logical chunk ahead while preserving serial wire order", async () => {
    const { ka } = await session();
    const reads: Array<[number, number]> = [];
    const size = CHUNK_SIZE * 3;
    const file = {
      size,
      slice(start: number, end: number) {
        reads.push([start, end]);
        return new Blob([new Uint8Array(end - start).fill(reads.length)]);
      },
    } as File;

    const frames = new Sender().dataFrames([file], ka);
    const first = await frames.next();
    expect(first.done).toBe(false);
    expect(reads).toEqual([[0, CHUNK_SIZE], [CHUNK_SIZE, CHUNK_SIZE * 2]]);

    const second = await frames.next();
    expect(second.done).toBe(false);
    expect(reads).toEqual([
      [0, CHUNK_SIZE],
      [CHUNK_SIZE, CHUNK_SIZE * 2],
      [CHUNK_SIZE * 2, CHUNK_SIZE * 3],
    ]);
    for await (const _ of frames) { /* drain */ }
  });

  it("handles a zero-byte file in the batch", async () => {
    const { ka, kb } = await session();
    const files = [new File([], "empty.bin"), new File([new Uint8Array(100)], "x.bin")];
    const { oks } = await roundTrip(files, ka, kb);
    expect(oks).toEqual([true, true]);
  });

  it("carries a folder-relative path through the manifest", async () => {
    const { ka, kb } = await session();
    const sender = new Sender();
    const out = await new Receiver().feed(
      await batchFrame(sender, [{ name: "a.jpg", size: 3, path: "trip/day1/a.jpg" }], ka),
      kb,
    );
    expect(out.batch!.files[0].path).toBe("trip/day1/a.jpg");
  });

  it("rejects a manifest that would exceed the DataChannel message ceiling", async () => {
    const { ka } = await session();
    const many = Array.from({ length: 3000 }, (_, i) => ({
      name: `file-${i}.bin`,
      size: i,
      path: `deeply/nested/folder/path/segment/file-${i}.bin`,
    }));
    await expect(batchFrame(new Sender(), many, ka)).rejects.toThrow(/manifest too large/);
  });

  it("reports integrity failure when a chunk is corrupted", async () => {
    const { ka, kb } = await session();
    const file = new File([new Uint8Array(100_000)], "x.bin");
    const sender = new Sender();
    const receiver = new Receiver();
    await receiver.feed(await batchFrame(sender, [{ name: file.name, size: file.size }], ka), kb);

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
    await receiver.feed(await batchFrame(sender, [{ name: "big.bin", size: bytes.length }], ka), kb);

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

describe("mixed-link file lifecycle controls", () => {
  it("advances cumulative ACKs only through bytes emitted by the current attempt", () => {
    expect(advanceAck(10, 20, 15)).toBe(15);
    expect(advanceAck(10, 20, 10)).toBe(10);
    expect(advanceAck(10, 20, 9)).toBe(10);
    expect(advanceAck(10, 20, Number.MAX_SAFE_INTEGER)).toBe(10);
  });

  it("recognises the busy frame without colliding with existing controls", () => {
    expect(controlKind(ACCEPT.buffer as ArrayBuffer)).toBe("accept");
    expect(controlKind(REJECT.buffer as ArrayBuffer)).toBe("reject");
    expect(controlKind(COMPLETE.buffer as ArrayBuffer)).toBe("complete");
    expect(controlKind(FILE_BUSY.buffer as ArrayBuffer)).toBe("busy");
    expect(isBatchAbort(BATCH_ABORT.buffer as ArrayBuffer)).toBe(true);
    expect(new Set([ACCEPT[0], REJECT[0], COMPLETE[0], FILE_BUSY[0], BATCH_ABORT[0]]).size).toBe(5);
  });

  it("requires an exact one-byte control frame", () => {
    expect(controlKind(new Uint8Array([FILE_BUSY[0], 0]).buffer)).toBeNull();
    expect(controlKind(new Uint8Array([]).buffer)).toBeNull();
    expect(isBatchAbort(new Uint8Array([BATCH_ABORT[0], 0]).buffer)).toBe(false);
    expect(controlKind(BATCH_ABORT.buffer as ArrayBuffer)).toBeNull();
  });

  it("never rewinds the receiver nonce during resume", async () => {
    const { ka, kb } = await session();
    const sender = new Sender();
    const receiver = new Receiver();
    await receiver.feed(await batchFrame(sender, [{ name: "a", size: 1 }], ka), kb);
    expect(() => receiver.resumeAt(new Uint8Array(32), 0)).toThrow(/moved backwards/);
    expect(() => receiver.resumeAt(new Uint8Array(32), 2)).not.toThrow();
  });
});

// commit-reveal 挡的是「信令中继改写 SDP 指纹做 DTLS 中间人」。那种攻击者推不出会话
// 密钥（文件内容保密），但它坐在 DTLS 里面，通道上一切明文它都看得见。改之前 manifest
// （文件名 + 大小）和 DONE（每个文件的 SHA-256）都是明文——后者尤其糟，它让攻击者
// **不用解密**就能确认"这是不是就是那份文件 X"。
//
// 这几条用例检查的是线缆上的字节，而不是 API 的行为：这是唯一能真正说明"元数据没有
// 泄漏"的检查方式。
describe("通道上的元数据不可读", () => {
  const wire = (f: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(f.slice(5));

  it("manifest 帧里看不到文件名", async () => {
    const { ka } = await session();
    const entry = { name: "salary-2026.pdf", size: 1234, path: "hr/salary-2026.pdf" };
    const f = await batchFrame(new Sender(), [entry], ka);
    expect(wire(f)).not.toContain("salary");
    expect(wire(f)).not.toContain("hr/");
    expect(wire(f)).not.toContain("1234");

    // 对照：同样的检测方式作用在**明文**帧上必须看得见文件名。没有这一条，上面
    // 三个 not.toContain 有可能只是因为解码方式不对而恒真。
    const plain = new Uint8Array(5 + new TextEncoder().encode(JSON.stringify({ files: [entry] })).length);
    plain.set(new TextEncoder().encode(JSON.stringify({ files: [entry] })), 5);
    expect(wire(plain), "检测方式本身失效了").toContain("salary");
  });

  it("DONE 帧里看不到文件哈希（否则一次比对就能确认是哪份文件）", async () => {
    const { ka, kb } = await session();
    const bytes = new Uint8Array(1000).map((_, i) => i % 7);
    const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await chainOnce(bytes)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");

    const sender = new Sender();
    await batchFrame(sender, [{ name: "x.bin", size: bytes.length }], ka);
    let doneFrame: Uint8Array | undefined;
    for await (const fr of sender.dataFrames([new File([bytes], "x.bin")], ka)) {
      if (fr[0] === FRAME.DONE) doneFrame = fr;
    }
    expect(doneFrame, "没有产生 DONE 帧").toBeTruthy();
    expect(wire(doneFrame!)).not.toContain(expected.slice(0, 16));
    expect(wire(doneFrame!)).not.toContain("sha256");

    // 对照：明文版的同一份内容里，那个哈希是找得到的。
    const plainDone = new Uint8Array(5 + 200);
    const body = new TextEncoder().encode(JSON.stringify({ sha256: expected }));
    plainDone.set(body, 5);
    expect(wire(plainDone.slice(0, 5 + body.length)), "检测方式本身失效了").toContain(expected.slice(0, 16));

    // 加密之后，完整性校验照常成立（这是同一批数据的正向回归）。
    const receiver = new Receiver();
    const s2 = new Sender();
    await receiver.feed(await batchFrame(s2, [{ name: "x.bin", size: bytes.length }], ka), kb);
    let ok: boolean | undefined;
    for await (const fr of s2.dataFrames([new File([bytes], "x.bin")], ka)) {
      const out = await receiver.feed(fr, kb);
      if (out.done) ok = out.done.ok;
    }
    expect(ok, "加密 DONE 之后完整性校验坏了").toBe(true);
  });

  it("manifest 被篡改会被 AEAD 抓住，而不是悄悄改掉确认卡片上的文件名", async () => {
    const { ka, kb } = await session();
    const f = await batchFrame(new Sender(), [{ name: "a.bin", size: 1 }], ka);
    f[9] ^= 0x01; // 翻密文里的一个 bit
    await expect(new Receiver().feed(f, kb)).rejects.toThrow();
  });

  it("老版本对端发来的明文 manifest 被明确拒绝，而不是回落到明文解析", async () => {
    const { kb } = await session();
    // 手工拼一个旧格式帧：kind=3（明文 manifest）。
    const body = new TextEncoder().encode(JSON.stringify({ files: [{ name: "a", size: 1 }] }));
    const legacy = new Uint8Array(5 + body.length);
    legacy[0] = 3;
    legacy.set(body, 5);
    await expect(new Receiver().feed(legacy as Uint8Array<ArrayBuffer>, kb)).rejects.toThrow(/older version/);
  });

  it("manifest 与数据块共用同一个 nonce 计数器，不重复使用 seq", async () => {
    const { ka } = await session();
    const sender = new Sender();
    const seqs: number[] = [];
    const seqOfFrame = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset).getUint32(1);
    seqs.push(seqOfFrame(await batchFrame(sender, [{ name: "a", size: 10 }], ka)));
    for await (const fr of sender.dataFrames([new File([new Uint8Array(10)], "a")], ka)) {
      seqs.push(seqOfFrame(fr));
    }
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // 单调
    expect(new Set(seqs).size, `seq 被重复使用: ${seqs}`).toBe(seqs.length);
    expect(seqs[0]).toBe(0); // manifest 吃掉 0，数据块从 1 开始
  });
});

// DONE 里的哈希是「整份文件的链式哈希」，这里复算一份用于比对。
async function chainOnce(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const buf = new Uint8Array(32 + bytes.length) as Uint8Array<ArrayBuffer>;
  buf.set(bytes, 32);
  return buf;
}

// 续传通道没有对端认证（报告 L3）：重连的 offer 和续传请求都能被信令层的中间人注入。
// 内容仍然安全（密钥没重新协商），但这两个数字会被发送端直接拿去切文件。
describe("续传点的范围校验", () => {
  const req = (o: unknown) => {
    const body = new TextEncoder().encode(JSON.stringify(o));
    const b = new Uint8Array(5 + body.length);
    b[0] = 5; // KIND_RESUME_REQ
    b.set(body, 5);
    return b.buffer as ArrayBuffer;
  };

  it("接受正常的续传点", () => {
    expect(parseResumeReq(req({ index: 1, offset: 4096 }))).toEqual({ index: 1, offset: 4096 });
  });

  it("拒绝负的 offset —— file.slice(负数) 会从文件尾部倒着切", () => {
    expect(parseResumeReq(req({ index: 0, offset: -1000 }))).toBeNull();
  });

  it("拒绝负的 index、小数、NaN、Infinity 和非数字", () => {
    for (const bad of [
      { index: -1, offset: 0 },
      { index: 0.5, offset: 0 },
      { index: NaN, offset: 0 },
      { index: 0, offset: Number.POSITIVE_INFINITY },
      { index: "0", offset: 0 },
      { index: 0 },
      {},
      null,
    ]) {
      expect(parseResumeReq(req(bad)), `${JSON.stringify(bad)} 应当被拒`).toBeNull();
    }
  });

  it("上界由调用方按本次批次校验", () => {
    const sizes = [100, 200];
    expect(resumePointInRange({ index: 0, offset: 100 }, sizes)).toBe(true); // 正好写满
    expect(resumePointInRange({ index: 1, offset: 201 }, sizes)).toBe(false); // 超出该文件
    expect(resumePointInRange({ index: 2, offset: 0 }, sizes)).toBe(false); // 没有这个文件
  });

  it("畸形的 RESUME_START 被拒绝，而不是把 NaN 塞进 nonce 计数器", async () => {
    const { kb } = await session();
    const body = new TextEncoder().encode(JSON.stringify({ index: 0, offset: 0, seq: "nope" }));
    const b = new Uint8Array(5 + body.length) as Uint8Array<ArrayBuffer>;
    b[0] = 4; // KIND_RESUME_START
    b.set(body, 5);
    await expect(new Receiver().feed(b, kb)).rejects.toThrow(/malformed resume/);
  });
});
