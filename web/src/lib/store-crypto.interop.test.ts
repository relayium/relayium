import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decodeKey, importStoreKey, decryptManifest, StoreDecryptor } from "./store-crypto";

// The vector is produced by the Go side (internal/storecrypto). Decoding it here
// proves the two implementations are wire-compatible.
//
// NOTE: `new URL("../relative", import.meta.url)` is intentionally NOT used here —
// Vite statically rewrites that literal pattern into a dev-server `@fs` HTTP URL
// (its asset-import heuristic), which breaks fileURLToPath. Resolving the
// directory first and joining with `path` sidesteps that rewrite.
const here = path.dirname(fileURLToPath(import.meta.url));
const vectorPath = path.join(here, "../../../server/internal/storecrypto/testdata/vector.json");

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

describe("store-crypto Go interop", () => {
  it("decrypts a Go-produced manifest and chunk", async () => {
    const vec = JSON.parse(readFileSync(vectorPath, "utf8"));
    const raw = decodeKey(vec.keyB64Url);
    const key = await importStoreKey(raw);
    const manifest = await decryptManifest(key, b64ToBytes(vec.manifestCtB64Std));
    expect(manifest.files[0].name).toBe("hello.txt");
    const dec = new StoreDecryptor(key);
    let out = new Uint8Array(0);
    for await (const pt of dec.push(b64ToBytes(vec.chunkFramesB64Std))) {
      const merged = new Uint8Array(out.length + pt.length);
      merged.set(out);
      merged.set(pt, out.length);
      out = merged;
    }
    await dec.end(vec.plaintext.length).next();
    expect(new TextDecoder().decode(out)).toBe(vec.plaintext);
  });
});
