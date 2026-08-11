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
//   end-to-end DataChannel (frame kind 10), and it MUST NOT be put on the
//   signaling channel, in a URL, in a log line, or in anything the server sees.
//   The server stores the ciphertext these keys open; handing it one is not a
//   degraded mode, it is the end of zero knowledge.
//
// Retry and idempotency are the other half of the contract, and they are why
// this is a whole-set message with no incremental form: the sender re-sends the
// complete current set on every (re)established link, and the receiver dedupes
// by id. A dropped link therefore costs a re-send, never a stranded transfer,
// and a duplicate delivery is a no-op rather than a second download.

import { decodeKey } from "./store-crypto";

/** The capability a peer must announce before it may be sent this message.
 *
 *  Exact match, versioned like `text/1` and `link/1`: an unknown frame kind is a
 *  HARD ERROR in every implementation (web, Swift, the Go CLI), so a speculative
 *  send does not degrade gracefully — it fails the whole transfer on a frame the
 *  peer cannot parse. `preupload/2` would be a different wire and must not be
 *  read as this one. */
export const CAP_PREUPLOAD = "preupload/1";

/** The DataChannel frame kind that carries a sealed handoff payload
 *  (relayium-realtime-wire-v1.md). */
export const KIND_STORED_KEYS = 10;

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

/** Build the payload the sender seals into a kind-10 frame.
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
