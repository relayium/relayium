import { seal, open, type SessionKeys } from "./crypto";

// Larger chunks mean fewer encrypt/send/event-loop iterations per MB → higher
// throughput. The on-wire message is CHUNK_SIZE + CHUNK_OVERHEAD (21 B); keep it
// well under the DataChannel max-message-size (256 KiB on Chrome) so sends never
// fail with "Message too large".
export const CHUNK_SIZE = 192 * 1024;
export const MAX_FILES = 10;

export interface FileMeta {
  name: string;
  size: number;
}

export interface Manifest {
  files: FileMeta[];
}

// Frame wire format: [1 byte kind][4 byte big-endian seq][payload].
const KIND_BATCH = 3; // manifest (plaintext): the whole batch's file list
const KIND_CHUNK = 1; // one encrypted file slice
const KIND_DONE = 2; // end-of-file integrity hash (plaintext)

/** Frame kinds, exported so the UI can read a frame's type for progress tracking. */
export const FRAME = { CHUNK: KIND_CHUNK, DONE: KIND_DONE, BATCH: KIND_BATCH } as const;
/** Per-chunk wire overhead: 5-byte header + 16-byte AES-GCM tag. plaintext = byteLength - this. */
export const CHUNK_OVERHEAD = 5 + 16;

// Control frames travel receiver -> sender on the same DataChannel (the opposite
// direction from file frames, so there is no collision). Each is a single byte.
const CTRL_ACCEPT = 0xfe;
const CTRL_REJECT = 0xff;
const CTRL_COMPLETE = 0xfd; // receiver got and verified the whole batch

export const ACCEPT = new Uint8Array([CTRL_ACCEPT]);
export const REJECT = new Uint8Array([CTRL_REJECT]);
export const COMPLETE = new Uint8Array([CTRL_COMPLETE]);

/** Decode a receiver->sender control frame; returns null for anything else. */
export function controlKind(buf: ArrayBuffer): "accept" | "reject" | "complete" | null {
  const b = new Uint8Array(buf);
  if (b.length !== 1) return null;
  if (b[0] === CTRL_ACCEPT) return "accept";
  if (b[0] === CTRL_REJECT) return "reject";
  if (b[0] === CTRL_COMPLETE) return "complete";
  return null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(kind: number, seq: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, 5);
  return out;
}

// Chained integrity hash: h = SHA-256(h || chunk). O(1) memory; one chain per file.
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
  /** The plaintext manifest frame; sent first so the receiver can prompt once for the batch. */
  batchFrame(files: FileMeta[]): Uint8Array {
    const manifest: Manifest = { files };
    return frame(KIND_BATCH, 0, enc.encode(JSON.stringify(manifest)));
  }

  /**
   * Encrypted chunk frames for every file, each followed by its integrity frame.
   * The AES-GCM nonce counter `seq` is GLOBAL across the whole batch — it never
   * resets per file — so no nonce is ever reused under the session key.
   */
  async *dataFrames(files: File[], keys: SessionKeys): AsyncGenerator<Uint8Array> {
    let seq = 0;
    for (const file of files) {
      let hash = new Uint8Array(32);
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const piece = new Uint8Array(
          await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer(),
        );
        hash = await chainHash(hash, piece);
        yield frame(KIND_CHUNK, seq, await seal(keys.send, seq, piece));
        seq++;
      }
      // DONE is unencrypted and does not consume a nonce slot.
      yield frame(KIND_DONE, seq, enc.encode(JSON.stringify({ sha256: toHex(hash) })));
    }
  }
}

export class Receiver {
  private expectedSeq = 0; // global nonce counter, mirrors the sender
  private hash = new Uint8Array(32); // chained hash of the file currently arriving

  async feed(
    encoded: Uint8Array,
    keys: SessionKeys,
  ): Promise<{ batch?: Manifest; chunk?: Uint8Array; done?: { ok: boolean } }> {
    const kind = encoded[0];
    const seq = new DataView(encoded.buffer, encoded.byteOffset).getUint32(1);
    const payload = encoded.slice(5);
    if (kind === KIND_BATCH) {
      return { batch: JSON.parse(dec.decode(payload)) as Manifest };
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
      const ok = sha256 === toHex(this.hash);
      this.hash = new Uint8Array(32); // reset chain for the next file in the batch
      return { done: { ok } };
    }
    throw new Error("unknown frame kind " + kind);
  }
}
