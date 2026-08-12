// Zero-knowledge stored-transfer crypto. A single random AES-256-GCM key per
// upload encrypts both the manifest (filenames + sizes) and the file bytes,
// reusing the same nonce-from-counter scheme as transfer.ts. The key lives only
// in the URL fragment; the server stores opaque ciphertext.
import { sanitizeNames } from "./filename";
import { validateManifestFiles } from "./manifest";

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
  const raw = new Uint8Array(32) as Bytes;
  crypto.getRandomValues(raw);
  return { key: await importKey(raw), raw };
}

export async function importStoreKey(raw: Uint8Array): Promise<CryptoKey> {
  return importKey(raw as Bytes);
}

// base64url without padding — libsodium's URLSAFE_NO_PADDING variant, done with
// btoa/atob so this module needs no wasm at all. That matters twice over: the
// fragment key is decoded synchronously on page load (a ready() gate here was a
// latent race), and keeping libsodium out of this import graph keeps it out of
// the entry chunk.
export function encodeKey(raw: Uint8Array): string {
  let s = "";
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeKey(s: string): Bytes {
  // Strict, like from_base64: no padding, no standard-alphabet chars, no
  // whitespace, and no length that base64 can't produce. A silently-truncated
  // key would decrypt nothing and look like corrupt ciphertext instead.
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    throw new Error("invalid base64url key");
  }
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length) as Bytes;
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export async function encryptManifest(key: CryptoKey, m: StoredManifest): Promise<Bytes> {
  validateManifestFiles(m?.files);
  const pt = enc.encode(JSON.stringify(m)) as Bytes;
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(0) }, key, pt);
  return new Uint8Array(ct);
}

export async function decryptManifest(key: CryptoKey, ct: Uint8Array): Promise<StoredManifest> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce(0) }, key, ct as Bytes);
  const m = JSON.parse(dec.decode(new Uint8Array(pt))) as StoredManifest;
  // 文件名由上传者任意构造，服务端只见密文、无从校验：在解密这个唯一入口把
  // 双向控制符洗掉（理由见 filename.ts），下载页和落盘名都用洗过的值。
  return { ...m, files: sanitizeNames(validateManifestFiles(m?.files)) };
}

/** Domain separator for the pair-room completion capability. Exact ASCII, no
 *  trailing NUL, and part of the WIRE: this server, the Swift port and every
 *  other implementation must agree on it byte for byte, or a receiver's proof
 *  never matches the sender's verifier and every completion 403s. Frozen by the
 *  vector in store-crypto.completion.test.ts, whose twin lives in
 *  server/account/pairroom_complete_test.go. */
export const PREUPLOAD_COMPLETE_INFO = "relayium-preupload-complete-v1";

/** The receiver's proof that it holds a pre-uploaded object's file key —
 *  `HKDF-SHA256(ikm = key, salt = empty, info = PREUPLOAD_COMPLETE_INFO)`, 32
 *  bytes.
 *
 *  This is the value that ENDS an object's life, so it is a bearer capability
 *  and is treated as one: it goes in a request BODY (never a URL, which proxies
 *  and access logs record) and is never persisted or printed.
 *
 *  HKDF rather than a bare hash of the key, because a bare hash is replayable
 *  into any other context that ever hashes the same key; the info string is the
 *  promise that this one is not. The empty salt is the protocol's — HKDF's salt
 *  is optional and there is nothing for one to buy over 32 uniformly random
 *  bytes of IKM. Go's `crypto/hkdf` with a nil salt derives the identical PRK
 *  (HMAC zero-pads any key shorter than its block size), which is what the
 *  shared vector pins. */
export async function completionProof(fileKey: Uint8Array): Promise<Bytes> {
  // Length-checked here rather than left to WebCrypto, which happily derives
  // from any IKM: a truncated key would produce a well-formed proof that simply
  // never matches, and "the server rejected it" is a much worse diagnosis than
  // "this is not a file key".
  if (fileKey.length !== 32) throw new Error("completion proof needs a 32-byte file key");
  const k = await crypto.subtle.importKey("raw", fileKey as Bytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(PREUPLOAD_COMPLETE_INFO) },
    k,
    256,
  );
  return new Uint8Array(bits) as Bytes;
}

/** What the SENDER hands the server at finalize: `SHA-256(completionProof(key))`.
 *
 *  The asymmetry is the whole design. The server stores only this, so knowing it
 *  — which is all a stolen database yields — does not produce the proof and
 *  cannot complete anybody's transfer; and neither value yields the file key, so
 *  the zero-knowledge property is untouched. The server's only job is to hash
 *  what a receiver sends and compare it with this. */
export async function completionVerifier(fileKey: Uint8Array): Promise<Bytes> {
  const digest = await crypto.subtle.digest("SHA-256", await completionProof(fileKey));
  return new Uint8Array(digest) as Bytes;
}

// length-prefixed frame: uint32BE(len(ct)) || ct.
function frame(ct: Uint8Array): Bytes {
  const out = new Uint8Array(4 + ct.length);
  new DataView(out.buffer).setUint32(0, ct.length);
  out.set(ct, 4);
  return out;
}

// 每帧的固定开销：4 字节长度前缀 + 16 字节 GCM tag。
export const FRAME_OVERHEAD = 4 + 16;

// 密文总长（不含 manifest，manifest 走 init 的 body）。每个文件独立按
// STORE_CHUNK_SIZE 分块、末块不补齐、文件之间没有分隔帧，所以总长可以在加密之前
// 精确算出来——上传流式化之后没有 Blob 可以问 .size，而 init 的 ?size= 需要它。
export function cipherSizeFor(files: File[]): number {
  let n = 0;
  for (const f of files) {
    n += f.size + FRAME_OVERHEAD * Math.ceil(f.size / STORE_CHUNK_SIZE);
  }
  return n;
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
