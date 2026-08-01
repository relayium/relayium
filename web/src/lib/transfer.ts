import { seal, open, type SessionKeys } from "./crypto";
import { sanitizeNames } from "./filename";

// Frames flow into DataChannel.send() and Web Crypto, which require an
// explicitly ArrayBuffer-backed `Uint8Array` rather than the generic
// `Uint8Array<ArrayBufferLike>`. Every buffer here is ArrayBuffer-backed.
type Bytes = Uint8Array<ArrayBuffer>;

// Larger chunks mean fewer encrypt/send/event-loop iterations per MB → higher
// throughput. The on-wire message is CHUNK_SIZE + CHUNK_OVERHEAD (21 B); keep it
// well under the DataChannel max-message-size (256 KiB on Chrome) so sends never
// fail with "Message too large".
export const CHUNK_SIZE = 192 * 1024;
// Raised from 10 to accommodate folder sends. The real ceiling is the manifest
// frame size (guarded below), not this count.
export const MAX_FILES = 1000;
// The manifest travels as a single plaintext DataChannel message; keep it well
// under the 256 KiB max-message-size. Long relative paths make this the true
// limit on how many files a batch can carry.
export const MANIFEST_MAX_BYTES = 200 * 1024;

export interface FileMeta {
  name: string; // basename, for display and single-file "Save As"
  size: number;
  path?: string; // relative path within a sent folder (e.g. "photos/a.jpg"); absent for a flat file
}

export interface Manifest {
  files: FileMeta[];
}

// Frame wire format: [1 byte kind][4 byte big-endian seq][payload].
const KIND_CHUNK = 1; // one encrypted file slice
const KIND_BATCH_ENC = 7; // manifest, sealed with the session key
const KIND_DONE_ENC = 8; // end-of-file integrity hash, sealed with the session key

// 旧的明文 manifest / DONE。**只用来识别老版本对端**，不再解析。
//
// 为什么必须加密它们：commit-reveal 挡的是"信令中继改写 SDP 指纹做 DTLS 中间人"。
// 那种攻击者推不出会话密钥（文件内容仍然保密），但它坐在 DTLS 里面，能看见通道上
// 一切明文的东西——而 manifest 是**文件名和大小**，DONE 是**每个文件的 SHA-256**。
// 后者尤其糟：它让攻击者能确认"这是不是就是那份文件 X"，一次比对即可，不需要解密。
// 所以"端到端加密"这句话在改之前只覆盖内容、不覆盖元数据。
const KIND_BATCH_LEGACY = 3;
const KIND_DONE_LEGACY = 2;
const KIND_RESUME_START = 4; // sender->receiver (plaintext): {index, offset, seq} — where a resumed stream picks up
const KIND_RESUME_REQ = 5; // receiver->sender (plaintext): {index, offset} — the last durably-written point
const KIND_ACK = 6; // receiver->sender (plaintext): cumulative bytes durably written — flow-control credit

/** Frame kinds, exported so the UI can read a frame's type for progress tracking. */
export const FRAME = { CHUNK: KIND_CHUNK, DONE: KIND_DONE_ENC, BATCH: KIND_BATCH_ENC } as const;

/** A resume checkpoint: the receiver has durably written `offset` bytes of file
 *  `index`; the sender continues from there. */
export interface ResumePoint { index: number; offset: number; }
/** Per-chunk wire overhead: 5-byte header + 16-byte AES-GCM tag. plaintext = byteLength - this. */
export const CHUNK_OVERHEAD = 5 + 16;

// Application-level receive flow control. A DataChannel exposes no receive-side
// backpressure to JS: onmessage drains the SCTP buffer into memory as fast as the
// network delivers, decoupled from the (slow) decrypt+disk pipeline. Without this,
// the sender races to the end, its send buffer empties, it declares "done" and
// closes while the receiver is still writing a huge in-memory backlog — which the
// receiver then misreads as a mid-transfer drop. The receiver acks durably-written
// bytes; the sender keeps at most FLOW_WINDOW bytes ahead of that ack, which bounds
// receiver memory AND paces the sender to real disk speed.
export const FLOW_WINDOW = 8 << 20; // 8 MB the sender may get ahead of durable writes
export const FLOW_ACK_INTERVAL = 512 * 1024; // receiver acks at least this often (bytes)

// Control frames travel receiver -> sender on the same DataChannel (the opposite
// direction from file frames, so there is no collision). Each is a single byte.
const CTRL_ACCEPT = 0xfe;
const CTRL_REJECT = 0xff;
const CTRL_COMPLETE = 0xfd; // receiver got and verified the whole batch
const CTRL_BUSY = 0xf9; // mixed-link file lane is occupied; retry/queue, not a refusal

export const ACCEPT = new Uint8Array([CTRL_ACCEPT]);
export const REJECT = new Uint8Array([CTRL_REJECT]);
export const COMPLETE = new Uint8Array([CTRL_COMPLETE]);
export const FILE_BUSY = new Uint8Array([CTRL_BUSY]);

/** Decode a receiver->sender control frame; returns null for anything else. */
export function controlKind(buf: ArrayBuffer): "accept" | "reject" | "complete" | "busy" | null {
  const b = new Uint8Array(buf);
  if (b.length !== 1) return null;
  if (b[0] === CTRL_ACCEPT) return "accept";
  if (b[0] === CTRL_REJECT) return "reject";
  if (b[0] === CTRL_COMPLETE) return "complete";
  if (b[0] === CTRL_BUSY) return "busy";
  return null;
}

/** Receiver->sender flow-control ack: total bytes durably written so far in the
 *  batch. The sender uses it to bound its in-flight window and to keep the pc open
 *  (as a liveness signal) until the receiver has actually caught up. */
export function ackFrame(bytesWritten: number): Bytes {
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setFloat64(0, bytesWritten); // exact for integers < 2^53
  return frame(KIND_ACK, 0, payload);
}

/** Decode a flow-control ack; null if the frame is not one. */
export function parseAck(buf: ArrayBuffer): number | null {
  const b = new Uint8Array(buf);
  if (b.length !== 13 || b[0] !== KIND_ACK) return null;
  return new DataView(b.buffer, b.byteOffset + 5).getFloat64(0);
}

/** Receiver->sender resume request: the last point the receiver durably has. */
export function resumeReqFrame(index: number, offset: number): Bytes {
  return frame(KIND_RESUME_REQ, 0, enc.encode(JSON.stringify({ index, offset })));
}

/**
 * Decode a resume request; null if the frame is not one **or is not a sane
 * resume point**.
 *
 * 续传通道没有对端认证（L3）：重连的 offer 和这条请求都可以由信令层的中间人注入。
 * 内容仍然安全（密钥没有重新协商，攻击者解不开也伪造不了密文），但这里的两个数字
 * 会被发送端直接拿去切文件：
 *   files.slice(0, index)            —— 巨大的 index 会跳过所有文件，传输静默空转；
 *   file.slice(offset, offset+N)     —— **负的 offset 会从文件尾部倒着切**，发出去的
 *                                       就是文件末尾的字节，而不是接收端要的那一段。
 * 所以在解析这一层就把形状卡死：非负整数，其余一律当作"这不是一条续传请求"。
 * 上界（index 是否落在 manifest 内、offset 是否超出该文件大小）由调用方校验——
 * 只有它知道这次传输有哪些文件。
 */
export function parseResumeReq(buf: ArrayBuffer): ResumePoint | null {
  const b = new Uint8Array(buf);
  if (b[0] !== KIND_RESUME_REQ) return null;
  try {
    const p = JSON.parse(dec.decode(b.slice(5))) as ResumePoint;
    if (!isIndex(p?.index) || !isIndex(p?.offset)) return null;
    return { index: p.index, offset: p.offset };
  } catch {
    return null;
  }
}

/** 非负安全整数。NaN / Infinity / 负数 / 小数 / 非数字全部落在外面。 */
function isIndex(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

/** 这个续传点落在这批文件的范围内吗（index 有对应文件、offset 不超过它的大小）。
 *  调用方在拿到 parseResumeReq 的结果之后校验一次。 */
export function resumePointInRange(p: ResumePoint, sizes: number[]): boolean {
  return p.index < sizes.length && p.offset <= sizes[p.index];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(kind: number, seq: number, payload: Uint8Array): Bytes {
  const out = new Uint8Array(5 + payload.length);
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, 5);
  return out;
}

// Chained integrity hash: h = SHA-256(h || chunk). O(1) memory; one chain per file.
async function chainHash(prev: Uint8Array, chunk: Uint8Array): Promise<Bytes> {
  const buf = new Uint8Array(prev.length + chunk.length);
  buf.set(prev, 0);
  buf.set(chunk, prev.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

function toHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class Sender {
  // AES-GCM nonce counter. GLOBAL across the whole transfer AND across resumes:
  // it only ever increases, never rewinds, so no nonce is reused under the
  // session key — which is what makes reusing the authenticated keys on a
  // resumed connection safe. Chunks lost in-flight simply burn their seq.
  private seq = 0;

  /**
   * 批次 manifest，用会话密钥封装后发出；接收方据此弹一次确认。
   *
   * 它**消费一个 seq**（和数据块共用同一个单调计数器），所以第一个数据块从 1 开始。
   * 共用计数器是这里唯一安全的做法：任何"给 manifest 留一个特殊 seq"的方案都要额外
   * 保证那个值永远不会被数据块用到，而续传会让计数器从一个任意点继续——多一个不变量
   * 就多一处能悄悄反复使用同一个 nonce 的地方。
   *
   * manifest 过大（文件太多、路径太长）会超过 DataChannel 的单帧上限，直接抛错。
   */
  async batchFrame(files: FileMeta[], keys: SessionKeys): Promise<Bytes> {
    const manifest: Manifest = { files };
    const payload = enc.encode(JSON.stringify(manifest)) as Bytes;
    // 上限比的是密文长度：GCM 会多出 16 字节 tag，按明文比会让临界的 manifest
    // 通过检查、然后在 send() 上炸掉。
    if (payload.length + 16 > MANIFEST_MAX_BYTES) throw new Error("relayium: manifest too large");
    const s = this.seq++;
    return frame(KIND_BATCH_ENC, s, await seal(keys.send, s, payload));
  }

  /** Announce where a resumed stream picks up. `this.seq` is the nonce the first
   *  resumed chunk will carry — send this frame immediately before dataFrames(). */
  resumeStartFrame(point: ResumePoint): Bytes {
    return frame(KIND_RESUME_START, 0, enc.encode(JSON.stringify({ ...point, seq: this.seq })));
  }

  /**
   * Encrypted chunk frames for every file, each followed by its integrity frame.
   * With `resume` set, files before `resume.index` are skipped (already
   * delivered) and file `resume.index` is streamed from `resume.offset` — but its
   * chain hash is still computed from byte 0, so the per-file DONE remains a hash
   * of the whole file and the receiver's resumed chain lines up.
   */
  async *dataFrames(files: File[], keys: SessionKeys, resume?: ResumePoint): AsyncGenerator<Bytes> {
    for (let fi = 0; fi < files.length; fi++) {
      if (resume && fi < resume.index) continue; // delivered before the drop
      const file = files[fi];
      const from = resume && fi === resume.index ? resume.offset : 0;
      let hash = new Uint8Array(32);
      for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
        const piece = new Uint8Array(
          await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer(),
        );
        hash = await chainHash(hash, piece);
        if (offset >= from) {
          // Reserve the nonce and advance BEFORE yielding: a generator suspends at
          // the yield, so if the transfer is abandoned here (a drop), this.seq must
          // already point past this chunk — otherwise a resume would reuse its
          // nonce. A burned (sent-but-lost) chunk simply consumes its seq forever.
          const s = this.seq++;
          yield frame(KIND_CHUNK, s, await seal(keys.send, s, piece));
        }
      }
      // DONE 也走加密，因此**同样消费一个 seq**。它带的是整份文件的 SHA-256——
      // 明文发等于把"这是不是文件 X"的判定能力白送给通道里的中间人。
      const ds = this.seq++;
      yield frame(
        KIND_DONE_ENC,
        ds,
        await seal(keys.send, ds, enc.encode(JSON.stringify({ sha256: toHex(hash) })) as Bytes),
      );
    }
  }
}

export class Receiver {
  private expectedSeq = 0; // global nonce counter, mirrors the sender
  private hash = new Uint8Array(32); // chained hash of the file currently arriving

  /** A copy of the current file's running chain hash. The App checkpoints this
   *  next to the bytes it has durably written, so a resume can restore a point
   *  where hash state and written bytes agree. */
  snapshotChain(): Uint8Array {
    return this.hash.slice();
  }

  /** Restore the chain hash to a checkpoint and align the nonce counter to the
   *  sender's resumed start seq. Called before feeding resumed chunks. */
  resumeAt(chain: Uint8Array, seq: number): void {
    this.hash = chain.slice();
    this.expectedSeq = seq;
  }

  async feed(
    encoded: Bytes,
    keys: SessionKeys,
  ): Promise<{ batch?: Manifest; chunk?: Uint8Array; done?: { ok: boolean }; resume?: ResumePoint & { seq: number } }> {
    const kind = encoded[0];
    const seq = new DataView(encoded.buffer, encoded.byteOffset).getUint32(1);
    const payload = encoded.slice(5);
    if (kind === KIND_BATCH_ENC) {
      if (seq !== this.expectedSeq) throw new Error("out-of-order manifest");
      const plain = await open(keys.recv, seq, payload); // throws on tamper
      this.expectedSeq++;
      const batch = JSON.parse(dec.decode(plain)) as Manifest;
      // 文件名由发送端任意构造，而接收方的确认卡片正是用户做信任决策的地方：
      // 在这个唯一入口把双向控制符洗掉，下游的 UI/历史记录/落盘名就都拿的是
      // 洗过的值（散在模板里逐处调用必然漏一个）。
      return { batch: { ...batch, files: sanitizeNames(batch.files) } };
    }
    if (kind === KIND_RESUME_START) {
      // The App restores the chain snapshot and calls resumeAt(); we just surface
      // the announced start so it can align file index/offset and the nonce.
      // 同样卡形状：这条帧是明文的，信令层的中间人可以注入。seq 会直接变成解密用的
      // 计数器起点，一个 NaN 会让之后每一次比较都为假、传输停在原地。
      const r = JSON.parse(dec.decode(payload)) as ResumePoint & { seq: number };
      if (!isIndex(r?.index) || !isIndex(r?.offset) || !isIndex(r?.seq)) {
        throw new Error("relayium: malformed resume announcement");
      }
      return { resume: r };
    }
    if (kind === KIND_CHUNK) {
      if (seq !== this.expectedSeq) throw new Error("out-of-order chunk");
      const plain = await open(keys.recv, seq, payload); // throws on tamper
      this.expectedSeq++;
      this.hash = await chainHash(this.hash, plain);
      return { chunk: plain };
    }
    if (kind === KIND_DONE_ENC) {
      if (seq !== this.expectedSeq) throw new Error("out-of-order done");
      const plain = await open(keys.recv, seq, payload); // throws on tamper
      this.expectedSeq++;
      const { sha256 } = JSON.parse(dec.decode(plain)) as { sha256: string };
      const ok = sha256 === toHex(this.hash);
      this.hash = new Uint8Array(32); // reset chain for the next file in the batch
      return { done: { ok } };
    }
    if (kind === KIND_BATCH_LEGACY || kind === KIND_DONE_LEGACY) {
      // 对端跑的是加密 manifest 之前的版本。**不回落到明文解析**：那条回落一旦存在
      // 就永远不会被删掉，等于给中间人留了一条"让对端用明文发"的降级路径。这里宁可
      // 明确失败，让用户刷新页面——两端都是从同一个源加载的，刷新即修复。
      throw new Error("relayium: peer is running an older version — reload the page on both devices");
    }
    throw new Error("unknown frame kind " + kind);
  }
}
