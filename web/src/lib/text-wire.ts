import { seal, open } from "./crypto";

// Frames flow into DataChannel.send() and Web Crypto, which require an
// explicitly ArrayBuffer-backed `Uint8Array` rather than the generic
// `Uint8Array<ArrayBufferLike>`. Every buffer here is ArrayBuffer-backed.
type Bytes = Uint8Array<ArrayBuffer>;

/**
 * 消息帧的 kind。和文件流的 1..8 全部不同（见 transfer.ts），两件事：一条走错通道的
 * 消息帧永远不会被当成数据块解析；以及 phase 2 把两条流并到同一个 DataChannel 上时，
 * 线上的字节不需要再变一次。
 */
export const KIND_TEXT_ENC = 9;

/**
 * One message, one frame, no chunking — the **product** cap.
 *
 * 64 KiB of UTF-8 covers any realistic paste of code or logs. Anything larger is
 * a file, and the UI says so rather than silently splitting content the user
 * thinks of as one thing.
 *
 * It is not, by itself, a cap the wire can always honour: 64 KiB of plaintext
 * seals into a 65 557 B frame, which does NOT fit a connection that negotiated
 * the RFC 8841 default of 65 536 (an Android peer that advertises nothing drags
 * every sender down to it). See textPlainLimit for the number to check against.
 */
export const TEXT_MAX_BYTES = 64 * 1024;

/** Per-frame wire overhead: 5-byte header + 16-byte AES-GCM tag. */
export const TEXT_FRAME_OVERHEAD = 5 + 16;

/**
 * The plaintext one message may carry on **this** connection: the product cap,
 * lowered to whatever the sealed frame must fit in.
 *
 * The file stream fragments when a chunk does not fit; text deliberately does
 * not (see TEXT_MAX_BYTES), so the only correct answer for an outsized message
 * is to refuse it — before sealing, so no nonce is burned and the conversation
 * survives. Handing an oversize message to `send()` instead kills the channel
 * and takes the whole session with it.
 */
export function textPlainLimit(maxFrameBytes: number): number {
  const usable = Math.floor(maxFrameBytes) - TEXT_FRAME_OVERHEAD;
  return Math.max(0, Math.min(usable, TEXT_MAX_BYTES));
}

// Mixed-link text-lane lifecycle. ACCEPT/REJECT remain the shared 0xfe/0xff
// bytes from transfer.ts; the DataChannel label scopes their meaning.
const CTRL_TEXT_REQUEST = 0xfa;
const CTRL_TEXT_END = 0xfb;
const CTRL_ACCEPT = 0xfe;
const CTRL_REJECT = 0xff;
export const TEXT_REQUEST = new Uint8Array([CTRL_TEXT_REQUEST]);
export const TEXT_END = new Uint8Array([CTRL_TEXT_END]);

export function textLifecycleKind(buf: ArrayBuffer): "request" | "accept" | "reject" | "end" | null {
  const b = new Uint8Array(buf);
  if (b.length !== 1) return null;
  if (b[0] === CTRL_TEXT_REQUEST) return "request";
  if (b[0] === CTRL_ACCEPT) return "accept";
  if (b[0] === CTRL_REJECT) return "reject";
  if (b[0] === CTRL_TEXT_END) return "end";
  return null;
}

const enc = new TextEncoder();
// fatal: invalid UTF-8 must fail loudly. A U+FFFD replacement character would
// corrupt content while reporting success, and "opaque valid Unicode" is a
// contract the receiver has to enforce, not hope for.
const dec = new TextDecoder("utf-8", { fatal: true });

/**
 * The number the limit is measured in, and the number the composer's counter
 * shows. A character count would let a Chinese or emoji message be refused
 * *after* the user was told it fit.
 */
export function textByteLength(body: string): number {
  return enc.encode(body).length;
}

/** Cheap discriminator for a channel's onmessage demux. Structurally disjoint
 *  from the file stream's kinds and from its 1-byte control frames. */
export function isTextFrame(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf);
  return b.length >= TEXT_FRAME_OVERHEAD && b[0] === KIND_TEXT_ENC;
}

function frame(seq: number, payload: Uint8Array): Bytes {
  const out = new Uint8Array(5 + payload.length) as Bytes;
  out[0] = KIND_TEXT_ENC;
  new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, 5);
  return out;
}

export class TextSender {
  // AES-GCM nonce counter for ONE direction of the message stream, under the
  // text key rather than the file key. It only ever increases, and nothing else
  // advances it — which is the whole reason the message stream does not share
  // the file stream's key: that counter's safety rests on having exactly one
  // producer, and messages are a second one.
  private seq = 0;

  /**
   * Seal one message.
   *
   * 和文件流的 Sender.dataFrames 不同，这里**先检查再取 seq**：那边必须在 yield 之前
   * 就把 seq 推进（生成器挂起后可能永不恢复，被放弃的块只能永久烧掉一个 seq），而这个
   * 函数是原子的——要么返回一帧，要么抛出，中间没有可以丢掉一个 seq 的悬挂点。所以被
   * 拒绝的消息不烧 seq。
   *
   * **调用方契约**：一个 TextSender 上的 frame() 必须串行调用。seq 是在 await 之前
   * 同步取的，所以并发调用各自拿到不同的 seq，但它们的 seal 可能乱序完成，先发出去的
   * 那一帧就带着更大的 seq——接收端会按 out-of-order 硬失败。会话层负责串行化。
   */
  async frame(body: string, key: CryptoKey): Promise<Bytes> {
    const payload = enc.encode(body) as Bytes;
    if (payload.length > TEXT_MAX_BYTES) {
      // The length, never the content: this message reaches logs and the UI.
      throw new Error(`relayium: message too large (${payload.length} > ${TEXT_MAX_BYTES} bytes)`);
    }
    const s = this.seq++;
    return frame(s, await seal(key, s, payload));
  }
}

export class TextReceiver {
  private expectedSeq = 0;

  /**
   * Open one message frame, or throw.
   *
   * Every rejection is a hard failure, as on the file stream: the channel is
   * reliable and ordered, so a gap, a repeat or a bad tag is not a network event
   * — it is tampering or a bug. `expectedSeq` advances only after the AEAD
   * verifies, so a rejected frame leaves the receiver still expecting the same
   * seq and a genuine frame at that seq still opens.
   */
  async feed(encoded: Bytes, key: CryptoKey): Promise<string> {
    if (encoded.length < TEXT_FRAME_OVERHEAD) {
      throw new Error("relayium: malformed message frame");
    }
    if (encoded[0] !== KIND_TEXT_ENC) throw new Error("relayium: not a message frame");
    const seq = new DataView(encoded.buffer, encoded.byteOffset).getUint32(1);
    if (seq !== this.expectedSeq) throw new Error("relayium: out-of-order message");
    // The seq is in the nonce, so a rewritten header is an auth failure too.
    const plain = await open(key, seq, encoded.slice(5) as Bytes); // throws on tamper
    this.expectedSeq++;
    try {
      return dec.decode(plain);
    } catch {
      // The byte length, never the bytes.
      throw new Error(`relayium: message is not valid UTF-8 (${plain.length} bytes)`);
    }
  }
}
