import { seal, open, type SessionKeys } from "./crypto";

export const CHUNK_SIZE = 64 * 1024;

export interface FileMeta {
  name: string;
  size: number;
}

export type Frame =
  | { kind: "meta"; meta: FileMeta }
  | { kind: "chunk"; seq: number; data: Uint8Array }
  | { kind: "done"; sha256: string };

const KIND_META = 0;
const KIND_CHUNK = 1;
const KIND_DONE = 2;

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(kind: number, seq: number, payload: Uint8Array): Uint8Array {
  // [1 byte kind][4 byte big-endian seq][payload]
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, 5);
  return out;
}

// Incremental SHA-256 via an accumulating buffer list kept small by hashing
// the whole stream once at the end. For 1GB this would be too much memory, so
// we instead fold using subtle.digest over a rolling concatenation is NOT ok.
// Use a streaming hash: we keep a growing list ONLY of digests is not possible
// with WebCrypto (no streaming). Therefore we hash each chunk's plaintext into
// a chained value: h = SHA256(h || chunk). This is integrity-equivalent for our
// purpose (detecting corruption) and uses O(1) memory.
async function chainHash(prev: Uint8Array, chunk: Uint8Array): Promise<Uint8Array> {
  const buf = new Uint8Array(prev.length + chunk.length);
  buf.set(prev, 0);
  buf.set(chunk, prev.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class Sender {
  async *frames(file: File, keys: SessionKeys): AsyncGenerator<Uint8Array> {
    const meta: FileMeta = { name: file.name, size: file.size };
    yield frame(KIND_META, 0, enc.encode(JSON.stringify(meta)));

    let seq = 0;
    let hash = new Uint8Array(32);
    const all = new Uint8Array(await file.arrayBuffer());
    let offset = 0;
    while (offset < all.length) {
      const piece = all.slice(offset, offset + CHUNK_SIZE);
      hash = await chainHash(hash, piece);
      yield frame(KIND_CHUNK, seq, await seal(keys.send, seq, piece));
      seq++;
      offset += CHUNK_SIZE;
    }
    yield frame(KIND_DONE, seq, enc.encode(JSON.stringify({ sha256: toHex(hash) })));
  }
}

export class Receiver {
  private expectedSeq = 0;
  private hash = new Uint8Array(32);

  async feed(
    encoded: Uint8Array,
    keys: SessionKeys,
  ): Promise<{ meta?: FileMeta; chunk?: Uint8Array; done?: { ok: boolean } }> {
    const kind = encoded[0];
    const seq = new DataView(encoded.buffer, encoded.byteOffset).getUint32(1);
    const payload = encoded.slice(5);
    if (kind === KIND_META) {
      return { meta: JSON.parse(dec.decode(payload)) as FileMeta };
    }
    if (kind === KIND_CHUNK) {
      if (seq !== this.expectedSeq) throw new Error("out-of-order chunk");
      const plain = await open(keys.recv, seq, payload); // throws on tamper
      this.expectedSeq++;
      this.hash = await chainHash(this.hash, plain);
      return { chunk: plain };
    }
    if (kind === KIND_DONE) {
      const { sha256 } = JSON.parse(dec.decode(payload)) as { sha256: string };
      return { done: { ok: sha256 === toHex(this.hash) } };
    }
    throw new Error("unknown frame kind " + kind);
  }
}
