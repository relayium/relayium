import { beforeAll, expect, it } from "vitest";
import { ready, deriveSession, generateKeyPair } from "./crypto";
import { Sender, Receiver, CHUNK_SIZE, CHUNK_OVERHEAD, isChunkFrame } from "./transfer";

beforeAll(async () => { await ready(); });
async function keys() {
  const a = generateKeyPair(), b = generateKeyPair();
  return [await deriveSession("initiator", a, b.publicKey), await deriveSession("responder", b, a.publicKey)] as const;
}

it("keeps default wire bytes identical with a live full-size budget", async () => {
  const [ka, kb] = await keys();
  const file = new File([new Uint8Array(CHUNK_SIZE + 100)], "default.bin");
  const collect = async (budget: number | (() => number)) => {
    const a = [];
    const receiver = new Receiver();
    for await (const f of new Sender().dataFrames([file], ka, undefined, budget)) {
      a.push({ bytes: f.length, sha: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", f))).join(",") });
      const out = await receiver.feed(f, kb);
      if (out.done) expect(out.done).toEqual({ ok: true });
    }
    return a;
  };
  expect(await collect(() => CHUNK_SIZE + CHUNK_OVERHEAD)).toEqual(await collect(CHUNK_SIZE + CHUNK_OVERHEAD));
});

it("changes piece budgets inside a logical chunk and authenticates the optional paced hint", async () => {
  const [ka, kb] = await keys();
  const sender = new Sender(), receiver = new Receiver();
  const plain = Uint8Array.from({ length: CHUNK_SIZE + 123 }, (_, i) => i % 251);
  const file = new File([plain], "live.bin");
  for (const frame of await sender.batchFrames([{ name: file.name, size: file.size }], ka)) await receiver.feed(frame, kb);
  let budget = 32 * 1024;
  const chunks: Uint8Array[] = [];
  const frames: Uint8Array[] = [];
  let done: { ok: boolean; paced?: true } | undefined;
  for await (const frame of sender.dataFrames([file], ka, undefined, () => budget, () => true)) {
    expect(frame.length).toBeLessThanOrEqual(budget);
    frames.push(frame);
    const out = await receiver.feed(frame, kb);
    if (out.chunk) chunks.push(out.chunk);
    if (out.done) done = out.done;
    // Grow after one PART, then shrink again: neither the hash grid nor the
    // nonce stream may depend on the local cap's framing decisions.
    budget = frames.length === 1 ? CHUNK_SIZE + CHUNK_OVERHEAD : 16 * 1024;
  }
  expect(done).toEqual({ ok: true, paced: true });
  expect(chunks.map((c) => c.length)).toEqual([CHUNK_SIZE, 123]);
  const hash = async (a: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(a)))).join(",");
  expect(await hash(new Uint8Array(await new Blob(chunks.map((c) => new Uint8Array(c))).arrayBuffer()))).toBe(await hash(plain));
  const seqs = frames.map((f) => new DataView(f.buffer, f.byteOffset).getUint32(1));
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(frames.filter(isChunkFrame).length).toBeGreaterThan(2);
});
