// encryptFiles reads one 192 KiB slice ahead of the one it is sealing. These
// tests pin what that may and may not change: the ciphertext is byte-for-byte
// the serial one, the next read really starts before the current seal settles,
// at most one future read exists, and a read that fails or is abandoned never
// turns into an unhandled rejection or a late seal.
import { describe, it, expect, vi, afterEach } from "vitest";
import { encryptFiles, importStoreKey, STORE_CHUNK_SIZE } from "./store-crypto";

const C = STORE_CHUNK_SIZE;
type Bytes = Uint8Array<ArrayBuffer>;

// The Stored-Wire frame stream written out from the format itself rather than
// from encryptFiles: per file, consecutive C-byte slices (last one short, an
// empty file contributes nothing), each sealed with AES-256-GCM under the
// 12-byte nonce 0x00000000 || uint64BE(seq), seq global across files from 1,
// framed as uint32BE(len(ct)) || ct.
async function referenceStream(key: CryptoKey, files: Bytes[]): Promise<Bytes> {
  const out: Uint8Array[] = [];
  let seq = 1;
  for (const bytes of files) {
    for (let off = 0; off < bytes.length; off += C) {
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setBigUint64(4, BigInt(seq++));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes.slice(off, off + C)));
      const fr = new Uint8Array(4 + ct.length);
      new DataView(fr.buffer).setUint32(0, ct.length);
      fr.set(ct, 4);
      out.push(fr);
    }
  }
  return concat(out);
}

function concat(parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function sha256Hex(b: Bytes): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("");
}

function pattern(n: number, salt: number): Bytes {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + salt) & 0xff;
  return b;
}

async function fixedKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  for (let i = 0; i < 32; i++) raw[i] = (i * 37 + 11) & 0xff;
  return importStoreKey(raw);
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function ticks(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}

// A File stand-in whose slice reads are observable and, when asked, held open
// until the test settles them. `reads[i]` is the i-th arrayBuffer() call.
type Read = { off: number; resolve: () => void; reject: (e: unknown) => void; settled: boolean };
function controlledFile(
  size: number,
  opts: { hold?: boolean; failAt?: number; failWith?: unknown; throwAt?: number } = {},
) {
  const bytes = pattern(size, 7);
  const reads: Read[] = [];
  let slices = 0;
  const file = {
    name: "c.bin",
    size,
    slice(a: number, b: number) {
      slices++;
      if (opts.throwAt !== undefined && a === opts.throwAt) throw opts.failWith;
      return {
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((resolve, reject) => {
            const r: Read = {
              off: a,
              settled: false,
              resolve: () => {
                r.settled = true;
                resolve(bytes.slice(a, Math.min(b, size)).buffer);
              },
              reject: (e) => {
                r.settled = true;
                reject(e);
              },
            };
            reads.push(r);
            if (opts.failAt !== undefined && a === opts.failAt) r.reject(opts.failWith);
            else if (!opts.hold) r.resolve();
          }),
      };
    },
  };
  return { file: file as unknown as File, reads, bytes, slices: () => slices };
}

// Unhandled rejections observed while a test runs.
function watchUnhandled() {
  const seen: unknown[] = [];
  const onUnhandled = (e: unknown) => seen.push(e);
  process.on("unhandledRejection", onUnhandled);
  return { seen, stop: () => process.off("unhandledRejection", onUnhandled) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("encryptFiles read-ahead", () => {
  it("produces exactly the serial Stored-Wire bytes across file and chunk boundaries", async () => {
    const key = await fixedKey();
    // empty, tiny, one short of a chunk, exactly a chunk, one over, and two
    // chunks plus one — in one call, so seq has to carry across files.
    const sizes = [0, 1, C - 1, C, C + 1, 2 * C + 1];
    const plain = sizes.map((n, i) => pattern(n, i));
    const files = plain.map((b, i) => new File([b], `f${i}`));
    const got: Uint8Array[] = [];
    for await (const fr of encryptFiles(files, key)) got.push(fr);
    expect(got).toHaveLength(1 + 1 + 1 + 2 + 3);
    // Every byte is compared, through the exact length and a SHA-256 of the
    // whole stream: a toEqual on ~1.4 MiB would, on a mismatch, spend minutes
    // building a pretty-printed diff instead of failing.
    const actual = concat(got);
    const expected = await referenceStream(key, plain);
    expect(actual.length).toBe(expected.length);
    expect(await sha256Hex(actual)).toBe(await sha256Hex(expected));
  });

  it("starts the next slice's read before the current slice's seal settles", async () => {
    const key = await fixedKey();
    const { file, reads } = controlledFile(3 * C - 5);
    const readsAtSeal: number[] = [];
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(((...a: Parameters<SubtleCrypto["encrypt"]>) => {
      readsAtSeal.push(reads.length);
      return realEncrypt(...a);
    }) as SubtleCrypto["encrypt"]);
    for await (const _ of encryptFiles([file], key)) void _;
    // Sealing slice k with slice k+1 already being read; the last slice has
    // nothing after it. A serial reader would show [1, 2, 3].
    expect(readsAtSeal).toEqual([2, 3, 3]);
    expect(reads.map((r) => r.off)).toEqual([0, C, 2 * C]);
  });

  it("keeps at most one future read, however long the consumer waits", async () => {
    const key = await fixedKey();
    const { file, reads } = controlledFile(5 * C);
    const gen = encryptFiles([file], key);
    for (let k = 0; k < 5; k++) {
      expect((await gen.next()).done).toBe(false);
      // The consumer holds frame k (e.g. while a PATCH is in flight).
      await ticks();
      expect(reads.length).toBeLessThanOrEqual(k + 2);
    }
    expect(reads.length).toBe(5);
    expect((await gen.next()).done).toBe(true);
    expect(reads.length).toBe(5);
  });

  it("does not read ahead across a file boundary", async () => {
    const key = await fixedKey();
    const a = controlledFile(C + 3);
    const b = controlledFile(C);
    const gen = encryptFiles([a.file, b.file], key);
    await gen.next(); // a[0]
    await gen.next(); // a[1], the last slice of a
    await ticks();
    expect(b.reads).toHaveLength(0);
    await gen.next(); // b[0]
    expect(b.reads).toHaveLength(1);
    expect((await gen.next()).done).toBe(true);
  });

  it("reports a read-ahead failure where the slice is needed, without an unhandled rejection", async () => {
    const key = await fixedKey();
    const err = new DOMException("read failed", "NotReadableError");
    const { file, reads } = controlledFile(3 * C, { failAt: C, failWith: err });
    const watch = watchUnhandled();
    try {
      const gen = encryptFiles([file], key);
      expect((await gen.next()).done).toBe(false); // frame 0 is fine
      // The read of slice 1 has already failed while the consumer holds frame 0.
      await ticks(10);
      expect(reads.map((r) => r.off)).toEqual([0, C]);
      expect(watch.seen).toEqual([]);
      // Not swallowed: the next pull gets the original error, and the stream ends.
      await expect(gen.next()).rejects.toBe(err);
      expect((await gen.next()).done).toBe(true);
      await ticks(10);
      expect(watch.seen).toEqual([]);
    } finally {
      watch.stop();
    }
  });

  it("surfaces a synchronous slice() failure only when that slice is needed", async () => {
    const key = await fixedKey();
    const err = new Error("slice exploded");
    const { file } = controlledFile(2 * C, { throwAt: C, failWith: err });
    const gen = encryptFiles([file], key);
    // Frame 0 is still delivered: the read-ahead's throw must not surface early.
    const first = await gen.next().then(
      (r) => ({ delivered: !r.done }),
      (e: unknown) => ({ delivered: false, threw: e === err }),
    );
    expect(first).toEqual({ delivered: true });
    await expect(gen.next()).rejects.toBe(err);
  });

  it("an early return seals nothing more, even when the abandoned read settles later", async () => {
    const key = await fixedKey();
    const err = new DOMException("read failed", "NotReadableError");
    const { file, reads, slices } = controlledFile(4 * C, { hold: true });
    let seals = 0;
    const realEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation(((...a: Parameters<SubtleCrypto["encrypt"]>) => {
      seals++;
      return realEncrypt(...a);
    }) as SubtleCrypto["encrypt"]);
    const watch = watchUnhandled();
    try {
      const gen = encryptFiles([file], key);
      const first = gen.next();
      await ticks();
      reads[0].resolve();
      expect((await first).done).toBe(false);
      expect(reads).toHaveLength(2); // slice 1 is being read, not yet settled
      expect(reads[1].settled).toBe(false);

      await gen.return(undefined); // the upload was cancelled / failed
      // File reads cannot be aborted: the abandoned one settles afterwards —
      // here as a failure, the case that must not become unhandled.
      reads[1].reject(err);
      await ticks(10);
      expect(watch.seen).toEqual([]);
      expect(seals).toBe(1);
      expect(slices()).toBe(2);
      expect((await gen.next()).done).toBe(true);
      expect(seals).toBe(1);
    } finally {
      watch.stop();
    }
  });
});
