// A minimal store-only (no compression) ZIP writer. Used as the folder-download
// fallback on browsers without the File System Access API (Firefox/Safari),
// where we can't stream a directory tree to disk — so we bundle the batch into
// one .zip that preserves relative paths. Store mode is lossless for any input
// (already-compressed media included) and keeps the code tiny.
//
// No ZIP64: individual entries and the whole archive must stay under 4 GiB.
// That's fine for the fallback path (large transfers use the FSA directory sink).

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800; // bit 11: filename is UTF-8
const DOS_EPOCH_DATE = 0x0021; // 1980-01-01; we don't carry per-file mtimes

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard CRC-32 (IEEE 802.3), the checksum every ZIP entry carries. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * Split a peer-supplied relative path into segments that cannot escape the
 * extraction root (Zip Slip defense): normalize backslashes, then drop "",
 * ".", ".." and bare drive letters ("C:"). The path comes from the sender's
 * webkitRelativePath and is fully attacker-controlled in realtime mode.
 */
export function safeSegments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== ".." && !/^[a-zA-Z]:$/.test(s));
}

/** safeSegments joined back into a slash path, or "file" if nothing survives. */
export function sanitizeRelPath(path: string): string {
  return safeSegments(path).join("/") || "file";
}

export class ZipWriter {
  private parts: Uint8Array[] = []; // local headers + file data, in order
  private central: Uint8Array[] = []; // one central-directory record per entry
  private offset = 0; // running byte offset into `parts` (each entry's local-header position)
  private count = 0;

  /** Append one stored file. `path` may contain "/" separators to nest it. */
  add(path: string, data: Uint8Array): void {
    const name = utf8(sanitizeRelPath(path));
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, DOS_EPOCH_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size == size (store)
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, 0, true); // method: store
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, DOS_EPOCH_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, this.offset, true); // local header offset
    central.set(name, 46);

    this.parts.push(local, data);
    this.central.push(central);
    this.offset += local.length + data.length;
    this.count++;
  }

  /** Assemble the archive: [local headers+data][central directory][EOCD]. */
  finish(): Blob {
    const centralSize = this.central.reduce((n, c) => n + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, EOCD_SIG, true);
    ev.setUint16(4, 0, true); // this disk
    ev.setUint16(6, 0, true); // disk with central dir
    ev.setUint16(8, this.count, true); // entries on this disk
    ev.setUint16(10, this.count, true); // total entries
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, this.offset, true); // central dir offset
    ev.setUint16(20, 0, true); // comment length

    return new Blob([...this.parts, ...this.central, eocd] as BlobPart[], {
      type: "application/zip",
    });
  }
}
