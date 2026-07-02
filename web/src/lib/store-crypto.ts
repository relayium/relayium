// Zero-knowledge stored-transfer crypto. A single random AES-256-GCM key per
// upload encrypts both the manifest (filenames + sizes) and the file bytes,
// reusing the same nonce-from-counter scheme as transfer.ts. The key lives only
// in the URL fragment; the server stores opaque ciphertext.
import sodium from "libsodium-wrappers";
import { ready } from "./crypto";

type Bytes = Uint8Array<ArrayBuffer>;

export const STORE_CHUNK_SIZE = 192 * 1024;

export interface StoredManifest {
  files: { name: string; size: number }[];
}

export interface StoreKey {
  key: CryptoKey;
  raw: Bytes;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function importKey(raw: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// 12-byte nonce: 4 zero bytes then a 64-bit big-endian counter. Manifest uses
// seq 0; file chunks use seq 1,2,3… so no nonce is ever reused under one key.
function nonce(seq: number): Bytes {
  const n = new Uint8Array(12);
  const v = new DataView(n.buffer);
  v.setUint32(4, Math.floor(seq / 2 ** 32));
  v.setUint32(8, seq >>> 0);
  return n;
}

export async function generateStoreKey(): Promise<StoreKey> {
  await ready();
  const raw = sodium.randombytes_buf(32) as Bytes;
  return { key: await importKey(raw), raw };
}

export async function importStoreKey(raw: Uint8Array): Promise<CryptoKey> {
  return importKey(raw as Bytes);
}

export function encodeKey(raw: Uint8Array): string {
  return sodium.to_base64(raw, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function decodeKey(s: string): Bytes {
  return sodium.from_base64(s, sodium.base64_variants.URLSAFE_NO_PADDING) as Bytes;
}

export async function encryptManifest(key: CryptoKey, m: StoredManifest): Promise<Bytes> {
  const pt = enc.encode(JSON.stringify(m)) as Bytes;
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(0) }, key, pt);
  return new Uint8Array(ct);
}

export async function decryptManifest(key: CryptoKey, ct: Uint8Array): Promise<StoredManifest> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(0) }, key, ct as Bytes);
  return JSON.parse(dec.decode(new Uint8Array(pt))) as StoredManifest;
}

// length-prefixed frame: uint32BE(len(ct)) || ct.
function frame(ct: Uint8Array): Bytes {
  const out = new Uint8Array(4 + ct.length);
  new DataView(out.buffer).setUint32(0, ct.length);
  out.set(ct, 4);
  return out;
}

// Stream every file's chunks as encrypted frames; seq is global across files,
// starting at 1 (0 is the manifest).
export async function* encryptFiles(files: File[], key: CryptoKey): AsyncGenerator<Bytes> {
  let seq = 1;
  for (const file of files) {
    for (let off = 0; off < file.size; off += STORE_CHUNK_SIZE) {
      const piece = new Uint8Array(await file.slice(off, off + STORE_CHUNK_SIZE).arrayBuffer()) as Bytes;
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(seq) }, key, piece));
      yield frame(ct);
      seq++;
    }
  }
}

// Upper bound on a single ciphertext frame: a full plaintext chunk plus the
// 16-byte GCM tag, with a little slack. A frame's length prefix is attacker-
// controlled, so without this cap a hostile/faulty server could claim a huge
// length and make us buffer unbounded memory waiting to "complete" the frame.
export const MAX_FRAME_CT = STORE_CHUNK_SIZE + 16 + 256;

// StoreDecryptor reassembles length-prefixed frames across arbitrary network
// chunk boundaries and yields decrypted plaintext in order. Throws on tamper.
export class StoreDecryptor {
  private seq = 1;
  private buf = new Uint8Array(0);
  private plaintextBytes = 0;
  constructor(private key: CryptoKey) {}

  /** Total decrypted plaintext bytes emitted so far. */
  get decryptedBytes(): number {
    return this.plaintextBytes;
  }

  async *push(data: Uint8Array): AsyncGenerator<Bytes> {
    const merged = new Uint8Array(this.buf.length + data.length);
    merged.set(this.buf, 0);
    merged.set(data, this.buf.length);
    let off = 0;
    while (off + 4 <= merged.length) {
      const len = new DataView(merged.buffer, merged.byteOffset + off, 4).getUint32(0);
      // Reject an oversized/garbage length before allocating for it.
      if (len > MAX_FRAME_CT) {
        throw new Error(`store-crypto: frame length ${len} exceeds ${MAX_FRAME_CT}`);
      }
      if (off + 4 + len > merged.length) break; // frame incomplete; wait for more
      const ct = merged.slice(off + 4, off + 4 + len) as Bytes;
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(this.seq) }, this.key, ct);
      this.seq++;
      off += 4 + len;
      this.plaintextBytes += pt.byteLength;
      yield new Uint8Array(pt);
    }
    this.buf = off < merged.length ? merged.slice(off) : new Uint8Array(0);
  }

  // Finalize the stream. Besides rejecting a dangling partial frame, assert the
  // decrypted total matches the expected plaintext length when one is supplied
  // (from the manifest): a stream truncated on a *frame boundary* is otherwise
  // indistinguishable from a clean end, so it would be silently accepted.
  // eslint-disable-next-line require-yield
  async *end(expectedBytes?: number): AsyncGenerator<Bytes> {
    if (this.buf.length !== 0) throw new Error("store-crypto: trailing bytes — truncated stream");
    if (expectedBytes !== undefined && this.plaintextBytes !== expectedBytes) {
      throw new Error(
        `store-crypto: length mismatch — got ${this.plaintextBytes}, expected ${expectedBytes} (truncated stream)`,
      );
    }
  }
}
