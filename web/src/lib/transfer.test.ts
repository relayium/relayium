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

describe("transfer", () => {
  it("round-trips a multi-chunk file with integrity check", async () => {
    const { ka, kb } = await session();
    const bytes = new Uint8Array(200_000).map((_, i) => i % 251);
    const file = new File([bytes], "build.tar.gz");

    const sender = new Sender();
    const receiver = new Receiver();
    let meta: { name: string; size: number } | undefined;
    const received: Uint8Array[] = [];
    let ok = false;

    for await (const frame of sender.frames(file, ka)) {
      const out = await receiver.feed(frame, kb);
      if (out.meta) meta = out.meta;
      if (out.chunk) received.push(out.chunk);
      if (out.done) ok = out.done.ok;
    }

    expect(meta).toEqual({ name: "build.tar.gz", size: 200_000 });
    expect(ok).toBe(true);
    const joined = new Uint8Array(received.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of received) { joined.set(c, off); off += c.length; }
    expect(joined).toEqual(bytes);
  });

  it("reports integrity failure when a chunk is corrupted", async () => {
    const { ka, kb } = await session();
    const file = new File([new Uint8Array(100_000)], "x.bin");
    const sender = new Sender();
    const receiver = new Receiver();
    let ok: boolean | undefined;
    let first = true;
    for await (const frame of sender.frames(file, ka)) {
      // Flip a byte in the first chunk frame's ciphertext region (after the type byte).
      if (first && frame[0] === 1 /* chunk */) { frame[10] ^= 0xff; first = false; }
      try {
        const out = await receiver.feed(frame, kb);
        if (out.done) ok = out.done.ok;
      } catch {
        ok = false; // AEAD open throws on tamper — that is a detected failure.
      }
    }
    expect(ok).toBe(false);
  });
});
