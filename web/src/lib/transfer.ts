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

// Control frames travel receiver -> sender on the same DataChannel (the opposite
// direction from file frames, so there is no collision). They are a single byte.
const CTRL_ACCEPT = 0xfe;
const CTRL_REJECT = 0xff;

export const ACCEPT = new Uint8Array([CTRL_ACCEPT]);
export const REJECT = new Uint8Array([CTRL_REJECT]);

/** Decode a receiver->sender control frame; returns null for anything else. */
export function controlKind(buf: ArrayBuffer): "accept" | "reject" | null {
  const b = new Uint8Array(buf);
  if (b.length !== 1) return null;
  if (b[0] === CTRL_ACCEPT) return "accept";
  if (b[0] === CTRL_REJECT) return "reject";
  return null;
}

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

// Chained integrity hash: h = SHA-256(h || chunk). O(1) memory; detects corruption.
// The actual file bytes are verified externally (reassembled file SHA-256) per the spec.
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
  /** The unencrypted file-metadata frame; sent first so the receiver can prompt. */
  metaFrame(file: File): Uint8Array {
    const meta: FileMeta = { name: file.name, size: file.size };
    return frame(KIND_META, 0, enc.encode(JSON.stringify(meta)));
  }

  /** Encrypted chunk frames followed by the integrity (done) frame. */
  async *dataFrames(file: File, keys: SessionKeys): AsyncGenerator<Uint8Array> {
    let seq = 0;
    let hash = new Uint8Array(32);
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      const piece = new Uint8Array(
        await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer(),
      );
      hash = await chainHash(hash, piece);
      yield frame(KIND_CHUNK, seq, await seal(keys.send, seq, piece));
      seq++;
    }
    yield frame(KIND_DONE, seq, enc.encode(JSON.stringify({ sha256: toHex(hash) })));
  }

  /** Full stream (meta + data) — used by tests and any no-handshake path. */
  async *frames(file: File, keys: SessionKeys): AsyncGenerator<Uint8Array> {
    yield this.metaFrame(file);
    yield* this.dataFrames(file, keys);
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
