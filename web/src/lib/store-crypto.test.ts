import { describe, it, expect } from "vitest";
import {
  generateStoreKey,
  importStoreKey,
  encodeKey,
  decodeKey,
  encryptManifest,
  decryptManifest,
  encryptFiles,
  StoreDecryptor,
  type StoredManifest,
} from "./store-crypto";

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe("store-crypto base64url", () => {
  it("roundtrips a 32-byte key", async () => {
    const sk = await generateStoreKey();
    expect(sk.raw.length).toBe(32);
    const s = encodeKey(sk.raw);
    expect(s).not.toContain("+");
    expect(s).not.toContain("/");
    expect(s).not.toContain("=");
    expect(decodeKey(s)).toEqual(sk.raw);
  });
});

describe("store-crypto manifest", () => {
  it("encrypt → decrypt yields the original manifest", async () => {
    const sk = await generateStoreKey();
    const m: StoredManifest = { files: [{ name: "secret.pdf", size: 42 }, { name: "图片.png", size: 7 }] };
    const ct = await encryptManifest(sk.key, m);
    expect(await decryptManifest(sk.key, ct)).toEqual(m);
  });
  it("fails to decrypt a tampered manifest", async () => {
    const sk = await generateStoreKey();
    const ct = await encryptManifest(sk.key, { files: [{ name: "a", size: 1 }] });
    ct[0] ^= 0xff;
    await expect(decryptManifest(sk.key, ct)).rejects.toBeTruthy();
  });
});

describe("store-crypto file stream", () => {
  it("encrypt → decrypt roundtrips multi-chunk bytes", async () => {
    const sk = await generateStoreKey();
    // 400 KiB → 3 chunks at 192 KiB.
    const bytes = new Uint8Array(400 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const file = new File([bytes], "big.bin");
    const frames: Uint8Array[] = [];
    for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
    const blob = concat(frames);

    const dec = new StoreDecryptor(await importStoreKey(sk.raw));
    const out: Uint8Array[] = [];
    // Feed the blob in awkward 100 KiB slices to exercise frame reassembly.
    for (let off = 0; off < blob.length; off += 100 * 1024) {
      for await (const pt of dec.push(blob.slice(off, off + 100 * 1024))) out.push(pt);
    }
    for await (const pt of dec.end()) out.push(pt);
    expect(concat(out)).toEqual(bytes);
  });

  it("throws when the stream is truncated on a frame boundary (length check)", async () => {
    const sk = await generateStoreKey();
    const bytes = new Uint8Array(400 * 1024); // 3 chunks
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const file = new File([bytes], "big.bin");
    const frames: Uint8Array[] = [];
    for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
    const truncated = concat(frames.slice(0, frames.length - 1)); // drop last frame

    const dec = new StoreDecryptor(sk.key);
    for await (const _ of dec.push(truncated)) { /* drain — ends on a frame boundary */ }
    // Buffer is empty (clean boundary), but the total is short → end() must throw.
    await expect(
      (async () => { for await (const _ of dec.end(bytes.length)) { /* drain */ } })(),
    ).rejects.toThrow(/mismatch|truncated/);
  });

  it("accepts a complete stream when the expected length matches", async () => {
    const sk = await generateStoreKey();
    const bytes = new Uint8Array(300 * 1024);
    const file = new File([bytes], "f.bin");
    const frames: Uint8Array[] = [];
    for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
    const dec = new StoreDecryptor(sk.key);
    for await (const _ of dec.push(concat(frames))) { /* drain */ }
    expect(dec.decryptedBytes).toBe(bytes.length);
    for await (const _ of dec.end(bytes.length)) { /* no throw */ }
  });

  it("rejects a frame whose length prefix exceeds the cap", async () => {
    const sk = await generateStoreKey();
    // A 5 GiB length prefix followed by nothing: must be rejected before buffering.
    const evil = new Uint8Array(4);
    new DataView(evil.buffer).setUint32(0, 0xffffffff);
    const dec = new StoreDecryptor(sk.key);
    await expect(
      (async () => { for await (const _ of dec.push(evil)) { /* drain */ } })(),
    ).rejects.toThrow(/exceeds/);
  });

  it("throws on a tampered ciphertext frame", async () => {
    const sk = await generateStoreKey();
    const file = new File([new Uint8Array([1, 2, 3, 4])], "x");
    const frames: Uint8Array[] = [];
    for await (const fr of encryptFiles([file], sk.key)) frames.push(fr);
    const blob = concat(frames);
    blob[blob.length - 1] ^= 0xff; // corrupt the GCM tag
    const dec = new StoreDecryptor(sk.key);
    await expect(
      (async () => { for await (const _ of dec.push(blob)) { /* drain */ } })(),
    ).rejects.toBeTruthy();
  });
});
