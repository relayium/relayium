import { describe, it, expect, beforeAll } from "vitest";
import { ready, generateKeyPair, deriveSession } from "./crypto";
import { Sender, Receiver } from "./transfer";

beforeAll(async () => { await ready(); });

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
