import { describe, expect, it } from "vitest";
import { UploadFrameAhead, UPLOAD_AHEAD_BYTES } from "./upload-frame-ahead";
import { encryptFiles, generateStoreKey } from "./store-crypto";

const tick = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

describe("bounded ciphertext preparation", () => {
  it("returns a ready frame while a later speculative read is blocked", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* source() { yield new Uint8Array([7]); await gate; yield new Uint8Array([8]); }
    const ahead = new UploadFrameAhead(source());
    ahead.start();
    let first: number | undefined;
    const pulling = ahead.next().then((r) => { first = r.value?.[0]; });
    try { await tick(); expect(first).toBe(7); }
    finally { release(); await pulling; await ahead.close(); }
  });
  it("keeps every encrypted byte and nonce unchanged across files and empty files", async () => {
    const key = (await generateStoreKey()).key;
    const files = [new File([new Uint8Array(2_200_000).fill(19)], "one.bin"), new File([], "empty.bin"), new File([new Uint8Array(501).fill(43)], "two.bin")];
    const serial: Uint8Array<ArrayBuffer>[] = [];
    for await (const frame of encryptFiles(files, key)) serial.push(frame);
    const ahead = new UploadFrameAhead(encryptFiles(files, key));
    ahead.start();
    try {
      for (const expected of serial) {
        const actual = await ahead.next();
        expect(actual.done).toBe(false);
        expect(actual.value!.byteLength).toBe(expected.byteLength);
        expect(await crypto.subtle.digest("SHA-256", actual.value!)).toEqual(await crypto.subtle.digest("SHA-256", expected));
      }
      expect((await ahead.next()).done).toBe(true);
    } finally { await ahead.close(); }
  });
  it("starts lazily, keeps a finite whole-frame queue and preserves order", async () => {
    let produced = 0;
    const size = 192 * 1024 + 20;
    async function* source() {
      for (let i = 0; i < 50; i++) { produced++; yield new Uint8Array(size).fill(i); }
    }
    const ahead = new UploadFrameAhead(source());
    await tick();
    expect(produced).toBe(0);
    expect((await ahead.next()).value?.[0]).toBe(0);
    expect(produced).toBe(1);
    ahead.start();
    await tick();
    expect(ahead.bufferedBytes).toBeGreaterThanOrEqual(UPLOAD_AHEAD_BYTES);
    expect(ahead.bufferedBytes).toBeLessThan(UPLOAD_AHEAD_BYTES + size);
    expect(produced).toBe(7);
    for (let i = 1; i < 50; i++) expect((await ahead.next()).value?.[0]).toBe(i);
    expect((await ahead.next()).done).toBe(true);
    await ahead.close();
    expect(ahead.bufferedBytes).toBe(0);
  });

  it("observes background failures immediately but delivers earlier frames first", async () => {
    const error = new Error("source read failed");
    async function* source() { yield new Uint8Array([1]); yield new Uint8Array([2]); throw error; }
    const ahead = new UploadFrameAhead(source());
    ahead.start();
    await tick();
    expect((await ahead.next()).value?.[0]).toBe(1);
    expect((await ahead.next()).value?.[0]).toBe(2);
    await expect(ahead.next()).rejects.toBe(error);
    await ahead.close();
  });

  it("cancel discards a late frame, joins the producer and never advances again", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let advances = 0;
    let closed = false;
    async function* source() {
      try { advances++; await gate; yield new Uint8Array([1]); advances++; yield new Uint8Array([2]); }
      finally { closed = true; }
    }
    const ac = new AbortController();
    const ahead = new UploadFrameAhead(source(), ac.signal);
    ahead.start();
    ac.abort();
    let joined = false;
    const closing = ahead.close().then(() => { joined = true; });
    await tick();
    expect(joined).toBe(false);
    release();
    await closing;
    expect(closed).toBe(true);
    expect(advances).toBe(1);
    expect(ahead.bufferedBytes).toBe(0);
    await expect(ahead.next()).rejects.toMatchObject({ name: "AbortError" });
  });
});
