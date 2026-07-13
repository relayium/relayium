import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  decodeKey,
  encodeKey,
  importStoreKey,
  encryptManifest,
  encryptFiles,
  decryptManifest,
  StoreDecryptor,
} from "./store-crypto";

// Cross-language vectors live in the Go package's testdata so both suites read
// the same files: the Go side writes vector.json (forward: Go→web, below) and
// this suite writes web-vector.json (reverse: web→Go, consumed by
// TestWebInteropVectorRoundTrip). Wire-compatibility is proven in both
// directions plus tamper-rejection.
//
// NOTE: `new URL("../relative", import.meta.url)` is intentionally NOT used here —
// Vite statically rewrites that literal pattern into a dev-server `@fs` HTTP URL
// (its asset-import heuristic), which breaks fileURLToPath. Resolving the
// directory first and joining with `path` sidesteps that rewrite.
const here = path.dirname(fileURLToPath(import.meta.url));
const testdataDir = path.join(here, "../../../server/internal/storecrypto/testdata");
const vectorPath = path.join(testdataDir, "vector.json");
const webVectorPath = path.join(testdataDir, "web-vector.json");

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
}
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// decryptWhole feeds all frames through a StoreDecryptor and returns the
// concatenated plaintext, asserting End accepts the expected total.
async function decryptWhole(key: CryptoKey, frames: Uint8Array, expected: number): Promise<Uint8Array> {
  const dec = new StoreDecryptor(key);
  const parts: Uint8Array[] = [];
  for await (const pt of dec.push(frames)) parts.push(pt);
  await dec.end(expected).next();
  return concat(parts);
}

describe("store-crypto Go interop", () => {
  it("decrypts a multi-file Go-produced vector and rejects tampering", async () => {
    const vec = JSON.parse(readFileSync(vectorPath, "utf8"));
    const raw = decodeKey(vec.keyB64Url);
    const key = await importStoreKey(raw);

    const manifest = await decryptManifest(key, b64ToBytes(vec.manifestCtB64Std));
    expect(manifest.files.map((f) => f.name)).toEqual(vec.files.map((f: { name: string }) => f.name));

    const frames = b64ToBytes(vec.chunkFramesB64Std);
    const out = await decryptWhole(key, frames, vec.plaintext.length);
    expect(new TextDecoder().decode(out)).toBe(vec.plaintext);

    // Flip a byte in the last frame — the GCM tag must reject it.
    const bad = frames.slice();
    bad[bad.length - 1] ^= 0x01;
    await expect(decryptWhole(key, bad, vec.plaintext.length)).rejects.toThrow();
  });

  // Reverse direction: encrypt with the web impl and write a vector the Go side
  // decrypts (TestWebInteropVectorRoundTrip). Deterministic (fixed key + fixed
  // content ⇒ stable AES-GCM ciphertext), so re-running is a no-op diff.
  it("produces a web-vector.json the Go side can decrypt", async () => {
    const raw = new Uint8Array(32); // 32 zero bytes, same fixed key as the Go vector
    const key = await importStoreKey(raw);

    const contents: Record<string, string> = {
      "hello.txt": "web to go",
      "notes/readme.md": "browser-encrypted payload",
    };
    const names = Object.keys(contents);
    const files = names.map((name) => new File([new TextEncoder().encode(contents[name])], name));
    const plaintext = names.map((n) => contents[n]).join("");

    const manifest = { files: files.map((f) => ({ name: f.name, size: f.size })) };
    const manifestCt = await encryptManifest(key, manifest);

    const frames: Uint8Array[] = [];
    for await (const fr of encryptFiles(files, key)) frames.push(fr);
    const chunkFrames = concat(frames);

    // Self-check before writing: the web decryptor round-trips its own output.
    const roundTrip = await decryptWhole(key, chunkFrames, plaintext.length);
    expect(new TextDecoder().decode(roundTrip)).toBe(plaintext);

    const vec = {
      keyB64Url: encodeKey(raw),
      manifestCtB64Std: bytesToB64(manifestCt),
      chunkFramesB64Std: bytesToB64(chunkFrames),
      plaintext,
      files: manifest.files,
    };
    writeFileSync(webVectorPath, JSON.stringify(vec, null, 2) + "\n");
  });
});
