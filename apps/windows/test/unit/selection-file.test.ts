// The lazy File adapter, checked against the REAL encryptors.
//
// The claim that matters is not "it has the right shape" — it is that
// `encryptFiles` and the transfer loop actually take one and get the right
// bytes. So this runs the production `encryptFiles` over a `SelectionFile`
// backed by a synthetic bridge and decrypts the frames back.

import { describe, expect, it } from "vitest";
import {
  SelectionFile,
  SelectionReadError,
  asFile,
  type SelectionReadBridge,
} from "../../src/renderer/os-entry/selection-file.js";
import { MAX_SELECTION_CHUNK, type SelectionEntryView } from "../../src/shared/os-entry.js";
// The production encryptor, imported directly — a vendored copy would be a
// different function with the same name.
import { encryptFiles, STORE_CHUNK_SIZE } from "../../../../web/src/lib/store-crypto";

/** A bridge over an in-memory buffer, counting exactly what was demanded. */
function bridgeOver(bytes: Uint8Array) {
  const reads: { offset: number; length: number }[] = [];
  let maxLength = 0;
  const bridge: SelectionReadBridge = {
    async read({ offset, length }) {
      reads.push({ offset, length });
      maxLength = Math.max(maxLength, length);
      if (offset < 0 || length <= 0 || length > MAX_SELECTION_CHUNK) return { kind: "bad-range" };
      if (offset >= bytes.length) return { kind: "bad-range" };
      return { kind: "bytes", bytes: bytes.slice(offset, offset + Math.min(length, bytes.length - offset)) };
    },
  };
  return { bridge, reads, max: () => maxLength };
}

const entry = (over: Partial<SelectionEntryView> = {}): SelectionEntryView => ({
  token: "sel-token",
  name: "a.bin",
  relativePath: "a.bin",
  size: 10,
  ...over,
});

describe("the File surface the encryptors actually use", () => {
  it("provides name, size and webkitRelativePath", () => {
    const { bridge } = bridgeOver(new Uint8Array(10));
    const flat = new SelectionFile(bridge, entry());
    expect(flat.name).toBe("a.bin");
    expect(flat.size).toBe(10);
    // A plain multi-file pick has an empty relative path and the name is the
    // whole path — matching `picked-files.ts`.
    expect(flat.webkitRelativePath).toBe("");

    const nested = new SelectionFile(bridge, entry({ name: "b.bin", relativePath: "box/b.bin" }));
    expect(nested.webkitRelativePath).toBe("box/b.bin");
  });

  it("slices and answers arrayBuffer", async () => {
    const bytes = Uint8Array.from({ length: 10 }, (_, i) => i);
    const { bridge } = bridgeOver(bytes);
    const file = new SelectionFile(bridge, entry());
    const buffer = await file.slice(2, 6).arrayBuffer();
    expect([...new Uint8Array(buffer)]).toEqual([2, 3, 4, 5]);
  });

  it("clamps past the end, as File.slice does, but refuses a reversed range", async () => {
    const bytes = Uint8Array.from({ length: 4 }, (_, i) => i);
    const { bridge } = bridgeOver(bytes);
    const file = new SelectionFile(bridge, entry({ size: 4 }));
    expect((await file.slice(2, 99).arrayBuffer()).byteLength).toBe(2);
    // `transfer.ts` warns a negative offset slices from the END. This adapter
    // does NOT reproduce that: sealing the wrong bytes under the right nonce is
    // worse than a refusal.
    expect(() => file.slice(-1, 2)).toThrow(SelectionReadError);
    expect(() => file.slice(3, 1)).toThrow(SelectionReadError);
  });

  it("surfaces a refusal rather than short bytes", async () => {
    const bridge: SelectionReadBridge = { read: async () => ({ kind: "changed" }) };
    const file = new SelectionFile(bridge, entry());
    await expect(file.slice(0, 4).arrayBuffer()).rejects.toBeInstanceOf(SelectionReadError);
  });
});

describe("the real encryptor takes one and gets the right bytes", () => {
  it("round-trips a multi-chunk file through encryptFiles", async () => {
    // Two and a bit chunks, so the loop actually iterates.
    const size = STORE_CHUNK_SIZE * 2 + 1234;
    const plain = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) plain[i] = (i * 31 + 7) % 251;
    const { bridge, max } = bridgeOver(plain);
    const file = asFile(new SelectionFile(bridge, entry({ size })));

    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);

    const frames: Uint8Array[] = [];
    for await (const frame of encryptFiles([file], key)) frames.push(new Uint8Array(frame));
    expect(frames.length).toBe(Math.ceil(size / STORE_CHUNK_SIZE));

    // Decrypt with the encryptor's own nonce scheme: seq starts at 1, big-endian
    // in the last 4 bytes of a 12-byte IV.
    const out = new Uint8Array(size);
    let at = 0;
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index]!;
      // Each frame is a 4-byte big-endian length prefix plus ciphertext.
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const length = view.getUint32(0);
      // Copied into its own buffer: a subarray over a larger allocation is not
      // a `BufferSource` the WebCrypto types accept.
      const ct = new Uint8Array(frame.subarray(4, 4 + length));
      const iv = new Uint8Array(12);
      new DataView(iv.buffer).setUint32(8, index + 1);
      const piece = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct),
      );
      out.set(piece, at);
      at += piece.length;
    }
    expect(at).toBe(size);
    // The bytes the encryptor sealed are the bytes the bridge served.
    expect([...out]).toEqual([...plain]);
    // And it never demanded more than one bounded chunk at a time.
    expect(max()).toBeLessThanOrEqual(MAX_SELECTION_CHUNK);
  });

  it("never materialises the whole file", async () => {
    const size = STORE_CHUNK_SIZE * 4;
    const plain = new Uint8Array(size);
    const { bridge, reads, max } = bridgeOver(plain);
    const file = asFile(new SelectionFile(bridge, entry({ size })));
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    for await (const _frame of encryptFiles([file], key)) void _frame;
    // Four chunk-sized reads, none larger. A whole-file read would be one read
    // of `size`, which is the thing this design exists to avoid.
    expect(reads.length).toBe(4);
    expect(max()).toBe(STORE_CHUNK_SIZE);
    expect(reads.every((r) => r.length <= MAX_SELECTION_CHUNK)).toBe(true);
  });

  it("handles an empty file without asking for a range", async () => {
    const { bridge, reads } = bridgeOver(new Uint8Array(0));
    const file = asFile(new SelectionFile(bridge, entry({ size: 0 })));
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const frames: unknown[] = [];
    for await (const frame of encryptFiles([file], key)) frames.push(frame);
    // An empty file yields no frames, and no read is attempted for it.
    expect(frames.length).toBe(0);
    expect(reads.length).toBe(0);
  });
});

describe("diagnostics", () => {
  it("carry no path and no content", () => {
    const error = new SelectionReadError("changed");
    expect(error.message).toBe("selection read: changed");
    expect(error.message).not.toMatch(/[A-Za-z]:\\|\/home|\/tmp/);
  });
});
