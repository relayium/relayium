import { describe, it, expect } from "vitest";
import { crc32, ZipWriter } from "./zip";

const enc = (s: string) => new TextEncoder().encode(s);
const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
const u16 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint16(o, true);

describe("crc32", () => {
  it("matches the canonical check value for '123456789'", () => {
    expect(crc32(enc("123456789")) >>> 0).toBe(0xcbf43926);
  });
  it("is 0 for empty input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("ZipWriter", () => {
  it("writes a valid store-only archive with correct headers and offsets", async () => {
    const z = new ZipWriter();
    const a = enc("hello");
    const b = enc("world!!");
    z.add("a.txt", a);
    z.add("dir/b.txt", b);
    const buf = new Uint8Array(await z.finish().arrayBuffer());

    // First entry: local file header at offset 0.
    expect(u32(buf, 0)).toBe(0x04034b50);
    expect(u16(buf, 8)).toBe(0); // store, no compression
    expect(u32(buf, 18)).toBe(a.length); // compressed size == size
    expect(u32(buf, 22)).toBe(a.length); // uncompressed size
    expect(u32(buf, 14)).toBe(crc32(a)); // crc of the data
    const name0len = u16(buf, 26);
    expect(new TextDecoder().decode(buf.slice(30, 30 + name0len))).toBe("a.txt");

    // End-of-central-directory: find its signature from the tail.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
    }
    expect(eocd).toBeGreaterThan(0);
    expect(u16(buf, eocd + 10)).toBe(2); // total entries

    // The central directory sits where EOCD says, starting with its signature,
    // and its first record points the second entry's local header offset past
    // entry 0 (30 + name + data).
    const cdOffset = u32(buf, eocd + 16);
    expect(u32(buf, cdOffset)).toBe(0x02014b50);
    // Second central record: walk past the first (46 + nameLen).
    const firstNameLen = u16(buf, cdOffset + 28);
    const secondRec = cdOffset + 46 + firstNameLen;
    expect(u32(buf, secondRec)).toBe(0x02014b50);
    const secondLocalOffset = u32(buf, secondRec + 42);
    expect(secondLocalOffset).toBe(30 + "a.txt".length + a.length);
    // And the second entry's name preserves its path separator.
    const secondNameLen = u16(buf, secondRec + 28);
    expect(new TextDecoder().decode(buf.slice(secondRec + 46, secondRec + 46 + secondNameLen))).toBe("dir/b.txt");
  });

  it("produces an empty but valid archive with no entries", async () => {
    const buf = new Uint8Array(await new ZipWriter().finish().arrayBuffer());
    expect(buf.length).toBe(22); // just the EOCD
    expect(u32(buf, 0)).toBe(0x06054b50);
    expect(u16(buf, 10)).toBe(0);
  });
});
