// The pre-upload key handoff: what the sender tells the peer about ciphertext it
// already uploaded against the pairing code, so the peer can fetch it from
// storage and decrypt it.
//
// Authoritative definition: docs/protocol/relayium-pair-room-v1.md §4.
//
// This module is the CODEC and nothing else — it builds and parses the payload,
// and it is deliberately unaware of how the bytes travel. What matters about the
// transport is stated once, here, because it is the property the whole feature
// rests on:
//
//   The payload carries FILE KEYS. It travels sealed, inside the peers'
//   end-to-end DataChannel (frame kind 12), and it MUST NOT be put on the
//   signaling channel, in a URL, in a log line, or in anything the server sees.
//   The server stores the ciphertext these keys open; handing it one is not a
//   degraded mode, it is the end of zero knowledge.
//
// Retry and idempotency are the other half of the contract, and they are why
// this is a whole-set message with no incremental form: the sender re-sends the
// complete current set on every (re)established link, and the receiver dedupes
// by id. A dropped link therefore costs a re-send, never a stranded transfer,
// and a duplicate delivery is a no-op rather than a second download.

import { open, seal } from "./crypto";
import { decodeKey } from "./store-crypto";

// Frames flow into DataChannel.send() and Web Crypto, which require an
// explicitly ArrayBuffer-backed `Uint8Array`.
type Bytes = Uint8Array<ArrayBuffer>;

/** The capability a peer must announce before it may be sent this message.
 *
 *  Exact match, versioned like `text/1` and `link/1`: an unknown frame kind is a
 *  HARD ERROR in every implementation (web, Swift, the Go CLI), so a speculative
 *  send does not degrade gracefully — it fails the whole transfer on a frame the
 *  peer cannot parse. `preupload/2` would be a different wire and must not be
 *  read as this one. */
export const CAP_PREUPLOAD = "preupload/1";

/**
 * The DataChannel frame kind that carries a sealed handoff payload
 * (relayium-realtime-wire-v1.md).
 *
 * **12, not 10.** The pair-room spec originally wrote this down as 10 because
 * the realtime-wire kind registry never listed the two transport-fragmentation
 * kinds, and 10/11 have been CHUNK_PART/BATCH_PART on the wire since
 * fragmentation shipped — in `transfer.ts` here and in `RealtimeKind` in the
 * Swift port. Sending a handoff as kind 10 would not have been a new frame at
 * all: `Receiver.feed` would have authenticated it as a chunk fragment and
 * spliced a JSON key list into the middle of a file. The registry now lists
 * 10/11 explicitly so the next kind cannot be chosen the same way.
 */
export const KIND_STORED_KEYS = 12;

/** Per-frame wire overhead: 5-byte header + 16-byte AES-GCM tag. */
export const HANDOFF_FRAME_OVERHEAD = 5 + 16;

/** Wire version of the payload itself, independent of the frame kind. */
export const HANDOFF_VERSION = 1;

/** At most this many items in one message. Well past any real batch, and low
 *  enough that a hostile peer cannot make a receiver allocate an unbounded list
 *  from one frame. */
export const MAX_HANDOFF_ITEMS = 256;

/** One pre-uploaded file: the stored object's id, and the key that opens it. */
export interface HandoffItem {
  id: string;
  /** base64url, no padding — the stored-wire `#k=` key encoding. */
  key: string;
}

/** A payload this client refuses to act on.
 *
 *  Carries no field for the offending value and never puts one in the message:
 *  this text reaches UI copy and logs, and a hostile id or a real key are
 *  exactly the strings that must not be echoed into either. */
export class InvalidHandoffError extends Error {
  constructor(reason: string) {
    super(`invalid key handoff: ${reason}`);
    this.name = "InvalidHandoffError";
  }
}

/** Same rule every other client applies to a stored-object id, for the same
 *  reason: it becomes a path segment of `/api/files/<id>/meta` and `/blob`, so a
 *  `.` or a `/` aims a request somewhere this client never meant to call. */
const STORED_OBJECT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Build the payload the sender seals into a kind-12 frame.
 *
 *  Compact JSON with the key order the protocol fixes, so two implementations
 *  produce identical bytes for identical input — the property the Swift port's
 *  fixtures are frozen against. */
export function encodeHandoff(items: readonly HandoffItem[]): string {
  if (!items.length) throw new InvalidHandoffError("no items");
  if (items.length > MAX_HANDOFF_ITEMS) throw new InvalidHandoffError("too many items");
  const seen = new Set<string>();
  for (const it of items) {
    checkItem(it);
    if (seen.has(it.id)) throw new InvalidHandoffError("duplicate id");
    seen.add(it.id);
  }
  return JSON.stringify({
    v: HANDOFF_VERSION,
    items: items.map((it) => ({ id: it.id, key: it.key })),
  });
}

/**
 * Parse a payload that arrived from the peer.
 *
 * Everything here is peer-authored input on a channel whose other end we have
 * authenticated but never trusted to be well-behaved, so every branch fails
 * CLOSED. In particular an unknown `v` is refused outright rather than parsed as
 * far as it goes: a future version may keep the same field names and mean
 * something different by them, and a half-understood key handoff is the one kind
 * of guess that ends with the wrong bytes written to a disk.
 */
export function decodeHandoff(json: string): HandoffItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new InvalidHandoffError("not JSON");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InvalidHandoffError("not an object");
  const { v, items } = raw as { v?: unknown; items?: unknown };
  if (v !== HANDOFF_VERSION) throw new InvalidHandoffError("unsupported version");
  if (!Array.isArray(items) || items.length === 0) throw new InvalidHandoffError("no items");
  if (items.length > MAX_HANDOFF_ITEMS) throw new InvalidHandoffError("too many items");
  const out: HandoffItem[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it || typeof it !== "object" || Array.isArray(it)) throw new InvalidHandoffError("bad item");
    const { id, key } = it as { id?: unknown; key?: unknown };
    const item = { id, key } as HandoffItem;
    checkItem(item);
    // Duplicates WITHIN one message are refused — that is a malformed message,
    // not a retry. Re-delivery ACROSS messages is the retry, and mergeHandoff
    // below is what makes it a no-op.
    if (seen.has(item.id)) throw new InvalidHandoffError("duplicate id");
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function checkItem(it: HandoffItem): void {
  if (typeof it.id !== "string" || !STORED_OBJECT_ID_RE.test(it.id)) {
    throw new InvalidHandoffError("bad id");
  }
  if (typeof it.key !== "string") throw new InvalidHandoffError("bad key");
  // decodeKey is the stored-wire strict decoder: it rejects any character
  // outside base64url and any length base64 cannot produce, so a silently
  // truncated key fails here rather than decrypting to garbage later. Reusing it
  // (rather than a regex of our own) is what keeps this client's idea of a valid
  // key identical to the one the download path will apply.
  let raw: Uint8Array;
  try {
    raw = decodeKey(it.key);
  } catch {
    throw new InvalidHandoffError("bad key");
  }
  if (raw.length !== 32) throw new InvalidHandoffError("bad key");
}

/**
 * Fold a freshly received batch into what the receiver already holds.
 *
 * This is the idempotency rule the retry semantics depend on: the sender
 * re-sends the WHOLE set on every (re)established link, so the same id arrives
 * again after any reconnect. An id already held wins — its download may be in
 * flight or finished, and replacing it would restart or duplicate that work.
 * New ids are appended in arrival order.
 *
 * A repeated id carrying a DIFFERENT key is still ignored, deliberately: the
 * first key is the one the in-flight download is using, and a peer that changed
 * its mind mid-transfer is either buggy or hostile. The transfer fails honestly
 * on decryption rather than silently switching keys underneath itself.
 */
export function mergeHandoff(held: readonly HandoffItem[], incoming: readonly HandoffItem[]): HandoffItem[] {
  const byID = new Set(held.map((it) => it.id));
  const out = [...held];
  for (const it of incoming) {
    if (byID.has(it.id)) continue;
    byID.add(it.id);
    out.push(it);
  }
  return out;
}

/**
 * Is `current` the very set `sealed` was built from?
 *
 * The question a sender asks in the one place where a whole-set message stops
 * being self-describing: between pulling the set and putting the sealed frame on
 * the wire. Sealing is asynchronous, the set is not stable across it (an entry
 * can be released to the live lane, replaced by a re-upload, or removed), and a
 * frame carries the set as it was — so the last thing between the keys and the
 * peer has to be "is this still true", not "is there still something to say".
 *
 * Equality is BY VALUE and ORDERED: every id, every key, in the frame's own
 * order. Ordered because the answer is used to decide whether a frame may be
 * sent, and a cheaper answer has to argue that some difference is harmless —
 * which is exactly the argument that made "is it non-empty" look sufficient. A
 * reorder costs one dropped frame and nothing else: the sender re-sends the
 * WHOLE current set afterwards, so a false "no" here is a re-send and a false
 * "yes" is a key the peer should not have.
 */
export function sameHandoffSet(sealed: readonly HandoffItem[], current: readonly HandoffItem[]): boolean {
  if (sealed.length !== current.length) return false;
  return sealed.every((it, i) => it.id === current[i].id && it.key === current[i].key);
}

/**
 * Cheap discriminator for the file channel's onmessage demux.
 *
 * The KIND decides, and nothing else — including for a frame too short to be a
 * valid one. Length used to be part of the answer, and it made a one-byte kind
 * 12 the file stream's problem: the demux said "not a handoff", `queueInbound`
 * handed it to the file receiver, and that codec failed the lane on a frame that
 * was never part of its sequence. One byte from a buggy or hostile peer, and a
 * transfer with nothing wrong with it is dead. Routed here instead, the same
 * byte is refused by `StoredKeysReceiver.open` (which checks the length itself),
 * logged, and costs the lane nothing. `isResumeReq` is first-byte-only for the
 * identical reason, and says so in the same words.
 *
 * Still disjoint from everything else on the channel: no file-stream kind is 12,
 * and no 1-byte control frame is either (they are 0xf8–0xff).
 */
export function isStoredKeysFrame(buf: ArrayBuffer): boolean {
  return new Uint8Array(buf)[0] === KIND_STORED_KEYS;
}

function frame(seq: number, payload: Uint8Array): Bytes {
  const out = new Uint8Array(5 + payload.length) as Bytes;
  out[0] = KIND_STORED_KEYS;
  new DataView(out.buffer).setUint32(1, seq);
  out.set(payload, 5);
  return out;
}

const enc = new TextEncoder();
// fatal: a payload that is not valid UTF-8 must fail loudly rather than decode
// to U+FFFD and then fail the JSON parse with a misleading reason.
const dec = new TextDecoder("utf-8", { fatal: true });

/**
 * Seals one handoff for one direction of one link.
 *
 * Its own counter under its own derived key (`keys.preuploadSend`), NOT the file
 * stream's — see SessionKeys.preuploadSend. That is what makes §4.4's "re-send
 * the whole set on every (re)established link" unconditionally safe: this frame
 * never has to be ordered against a batch in flight, never consumes a seq the
 * resume announcement has to account for, and can be dispatched ahead of the
 * receive chain like a control frame.
 *
 * Serial-call contract, same as TextSender: `seq` is taken synchronously before
 * the await, so two overlapping calls get different seqs but may seal out of
 * order. The one caller (the link's handoff driver) sends one at a time.
 *
 * **A taken seq is never given back**, and that asymmetry is deliberate. The seq
 * IS the nonce, so reusing one under the same derived key for a different
 * payload is the AES-GCM catastrophe this stream's whole design avoids. A frame
 * that is sealed and then not sent — the transport died, a generation guard
 * fired, `send()` threw — therefore leaves a permanent hole in the sequence, and
 * the receiver is what absorbs it (see StoredKeysReceiver). Rolling the counter
 * back to "recover" would trade a recoverable gap for an unrecoverable key leak.
 *
 * So there is no such thing as "the retry that reuses this seq": a re-send is
 * always a NEW frame at a NEW number, whatever became of the last one. That is
 * why the receiver can spend a seq the moment the frame opens.
 */
export class StoredKeysSender {
  private seq = 0;

  async frame(items: readonly HandoffItem[], key: CryptoKey): Promise<Bytes> {
    // encodeHandoff validates first, so a refused set burns no seq and the link
    // keeps working — the counter only ever advances for a frame that is emitted.
    const payload = enc.encode(encodeHandoff(items)) as Bytes;
    const s = this.seq++;
    return frame(s, await seal(key, s, payload));
  }
}

/**
 * Opens sealed handoffs for one direction of one link.
 *
 * **Forward-only, not gap-free**, and the difference is the whole point:
 *
 *  - A seq at or below the last one consumed is refused. That is a REPLAY of a
 *    key list, and it is refused whether it is an attacker re-injecting a frame
 *    or the burned frame from §StoredKeysSender finally arriving late.
 *  - A seq AHEAD of what was expected is accepted if — and only if — it opens.
 *    The sender takes its seq synchronously and seals asynchronously, so a
 *    transport replacement, a superseded generation or a throwing `send()`
 *    destroys a frame that has already spent its number. Insisting on the exact
 *    next seq would mean one such event wedges the stream permanently: every
 *    later whole-set resend is refused, and §4.4's "resend on every
 *    (re)established link" — the rule that is supposed to RESCUE a dropped
 *    handoff — becomes the thing that can never succeed again. The receiver
 *    would sit forever on a prompt that never comes while the sender believes it
 *    handed the keys over.
 *
 * A gap is not a downgrade. The frame still has to open under a key derived from
 * the peers' own session secret, so nothing an attacker can author is admitted
 * by tolerating one; all a gap costs is that a key list this side never saw is
 * never seen — which the sender's unconditional resend already covers.
 *
 * The counter moves as soon as the frame OPENS, and not one line later. What
 * comes after that is a judgement about the payload, and no such judgement can
 * hand a nonce back: the sender took this seq synchronously before it sealed and
 * can never reuse it, because the seq IS the AES-GCM nonce under a key derived
 * once per link. Holding the number back for a payload this side refused would
 * therefore protect nothing that exists, while leaving that authenticated frame
 * replayable for as long as the link lives — junk payload and all. A frame that
 * does not open moves nothing, which is the same rule read the other way: it was
 * never the peer's, so it says nothing about what the peer has sent.
 */
export class StoredKeysReceiver {
  /** The lowest seq this side will still accept. Starts at 0 and only rises. */
  private expectedSeq = 0;

  async open(buf: ArrayBuffer, key: CryptoKey): Promise<HandoffItem[]> {
    const b = new Uint8Array(buf);
    if (b.length < HANDOFF_FRAME_OVERHEAD || b[0] !== KIND_STORED_KEYS) {
      throw new InvalidHandoffError("not a handoff frame");
    }
    const seq = new DataView(b.buffer, b.byteOffset).getUint32(1);
    if (seq < this.expectedSeq) throw new InvalidHandoffError("replayed handoff");
    // Only after the sequence check: a replayed frame must not be able to spend
    // a decryption.
    const plain = await open(key, seq, b.slice(5) as Bytes); // throws on tamper
    // The frame is the peer's, so its number is spent — HERE, before the payload
    // is looked at. Everything below this line is a judgement about content, and
    // no judgement about content can give a nonce back: the sender took this seq
    // synchronously before it sealed, and it can never reuse it for anything
    // (the seq IS the AES-GCM nonce under a key both sides derive once). Waiting
    // for a successful decode would leave the number live on this side alone,
    // and this exact authenticated frame — junk payload included — could then be
    // replayed as often as anyone likes.
    //
    // A frame that FAILS to open never reaches this line, which is the other
    // half of the rule: it was not authored by the peer, so it may not move an
    // expectation that describes what the peer has sent.
    this.expectedSeq = seq + 1;
    let json: string;
    try {
      json = dec.decode(plain);
    } catch {
      throw new InvalidHandoffError("not UTF-8");
    }
    return decodeHandoff(json);
  }
}
