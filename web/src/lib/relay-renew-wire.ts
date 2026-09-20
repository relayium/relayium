// The `relay-renew/1` wire: canonical signed payloads, the strict signalling
// envelope, the data-lane control frame, and the server round envelopes.
//
// **This module is the cross-platform contract.** Apple and Android authors
// implement against `apps/RelayiumKit/Tests/Fixtures/relay-renew-vectors.json`,
// which is generated from exactly these functions. Nothing here reaches a
// PeerConnection, a timer or a socket: it is pure so that the fixture and the
// three clients can be checked against the same bytes rather than against three
// readings of a paragraph.
//
// ## What renewal is, in one paragraph
//
// A relayed `link/1` is bounded by the TURN credential the server issued (see
// relay-deadline.ts). Renewal asks the server for a FRESH credential for the
// same room and the same two peers, applies it to the live PeerConnection, and
// migrates the media path onto it — without re-pairing, without a new SAS, and
// without touching a single key or nonce counter. The deadline moves only after
// the new path has carried an authenticated round trip; a changed configuration
// or an HTTP 200 is not success.
//
// ## Two numbers that are not the same number
//
//   · `round`  — SERVER issuance. The server owns it, both peers must ask for
//                the same one, and one round yields one credential set.
//   · `epoch`  — LINK migration attempt. Monotonic per link, never reused, and
//                a failed attempt retries under a HIGHER epoch so the aborted
//                one's signed messages cannot be replayed into the retry.
//
// At most `RENEW_MAX_EPOCHS_PER_ROUND` epochs may be spent on one round.

import { signResume, verifyResume } from "./crypto";

/** The capability string. Advertised ONLY by a build that has the whole path
 *  wired — it is a hint to the peer about what to expect, and a peer that
 *  announces it and then never answers a `prepare` wastes both sides' epochs. */
export const CAP_RENEW = "relay-renew/1";

// ── frame and tag sizes ──────────────────────────────────────────────────────

/** The data-lane control frame's first byte. Deliberately outside every kind
 *  the file lane (1..8), the text lane (9), the pre-upload handoff (12) and the
 *  lifecycle bytes already use, so every existing client's demux ignores it —
 *  see §7.3 of relayium-link-v1.md, where a text-lane frame whose first byte is
 *  not 9 is silently dropped rather than treated as an error. That is what makes
 *  this frame safe to send to a peer that has never heard of renewal. */
export const RENEW_PROBE_KIND = 0x0d;
/** Frame format version. A future incompatible probe gets a new number rather
 *  than a new field, so a strict length check keeps working. */
export const RENEW_PROBE_VERSION = 1;
export const RENEW_PROBE_TYPE_PROBE = 1;
export const RENEW_PROBE_TYPE_ACK = 2;
export const RENEW_NONCE_BYTES = 16;
export const RENEW_TAG_BYTES = 32;
/** `[kind][version][type][epoch u32][round u32][nonce 16][tag 32]`. Fixed, and
 *  checked before anything else: a frame of any other length is not this frame,
 *  and rejecting on length first is what bounds the work a flood can buy. */
export const RENEW_PROBE_FRAME_BYTES =
  1 + 1 + 1 + 4 + 4 + RENEW_NONCE_BYTES + RENEW_TAG_BYTES;

/** Base64 of a 32-byte HMAC, standard alphabet with padding. Checked before any
 *  decode, exactly as `LINK_LEAVE_AUTH_LENGTH` is. */
export const RENEW_AUTH_LENGTH = 44;

// ── bounds ───────────────────────────────────────────────────────────────────

/** Migration attempts one server round may be spent on. Past it the link keeps
 *  its existing deadline and stops trying until a new round exists. */
export const RENEW_MAX_EPOCHS_PER_ROUND = 3;
/** HMAC verifications one epoch will ever spend on inbound probe frames. A
 *  genuine peer needs two (its probe and its retransmit landing before ours);
 *  the budget exists so a forged frame cannot buy unbounded Web Crypto work. */
export const RENEW_MAX_PROBE_VERIFICATIONS = 8;
/** Remote candidates held per epoch while its remote description is pending.
 *  Same 64 as the establishment path, for the same reason. */
export const RENEW_MAX_HELD_CANDIDATES = 64;
/** Retransmit cadence and count for one probe nonce. */
export const RENEW_PROBE_RETRY_MS = 2_000;
export const RENEW_PROBE_MAX_SENDS = 5;

// ── deadlines (§ "Prepare->ready15s; ready->answer15s; ICE+probe30s; whole 60s") ──

export const RENEW_PREPARE_TO_READY_MS = 15_000;
export const RENEW_READY_TO_ANSWER_MS = 15_000;
export const RENEW_ICE_PROBE_MS = 30_000;
export const RENEW_EPOCH_HARD_CAP_MS = 60_000;
/**
 * How long two unanswered `prepare` signals wait before this link concludes the
 * peer does not implement renewal.
 *
 * Terminal for the link, not for the page: the deadline it already had stays
 * exactly as it is and the UI keeps telling the truth about it. A peer that
 * advertised `relay-renew/1` and then ignored a prepare is indistinguishable
 * from one that never advertised it, and both must end here rather than
 * re-offering into silence for the rest of an hour-long credential.
 */
export const RENEW_PREPARE_SILENCE_MS = 10_000;

// ── the abort vocabulary ─────────────────────────────────────────────────────

/** Why an epoch ended. An enum, not prose: it is peer-authored and reaches a
 *  local state machine, never a UI string. */
export const RENEW_ABORT_REASONS = ["denied", "unavailable", "timeout", "sdp", "closed"] as const;
export type RenewAbortReason = (typeof RENEW_ABORT_REASONS)[number];

/** Why the server answered the way it did. Diagnostics only — the client routes
 *  on `status`, never on this. */
export const RENEW_GRANT_REASONS = [
  "quota", "unverified", "idle", "expired", "membership", "rate", "unavailable",
] as const;
export type RenewGrantReason = (typeof RENEW_GRANT_REASONS)[number];

export const RENEW_GRANT_STATUSES = ["granted", "denied", "unavailable", "stale"] as const;
export type RenewGrantStatus = (typeof RENEW_GRANT_STATUSES)[number];

// ── uint32 ───────────────────────────────────────────────────────────────────

/**
 * Every integer on this wire is an exact uint32.
 *
 * Strict on purpose, and strict in the same way `restExpirySeconds` is: `1.0` is
 * fine (it IS the integer), but `"1"`, `1.5`, `-1`, `NaN`, `Infinity` and
 * `2**32` are not, and a lenient read would let a peer or a server move an epoch
 * or a round somewhere the comparisons below cannot reason about. Native ports
 * carry a real `UInt32`, so anything JavaScript accepts here that they cannot
 * represent is a divergence rather than a convenience.
 */
export function isUint32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

// ── canonical payloads ───────────────────────────────────────────────────────
//
// Hand-listed key order, rendered by `JSON.stringify` so the escaping is exactly
// the one §4.4 of relayium-link-v1.md already pins for `authPayload` — the same
// rule, the same fixture discipline, and therefore no second escaping question
// for a native port to answer.
//
// `from`/`to` are the established peer ids as each side knows them. They are
// NOT carried in the envelope or the frame: they come from the signalling
// context, so a reflected message verifies the reversed tuple and fails.

export function renewPreparePayload(from: string, to: string, epoch: number): string {
  return JSON.stringify({ kind: "link-renew-prepare", from, to, epoch });
}

export function renewReadyPayload(from: string, to: string, epoch: number, round: number): string {
  return JSON.stringify({ kind: "link-renew-ready", from, to, epoch, round });
}

export function renewSdpPayload(
  from: string, to: string, epoch: number, round: number,
  sdpType: string, sdp: string,
): string {
  return JSON.stringify({ kind: "link-renew-sdp", from, to, epoch, round, sdpType, sdp });
}

export function renewIcePayload(
  from: string, to: string, epoch: number, round: number,
  candidate: string, sdpMid: string | null, sdpMLineIndex: number | null,
  usernameFragment: string,
): string {
  return JSON.stringify({
    kind: "link-renew-ice", from, to, epoch, round,
    candidate, sdpMid, sdpMLineIndex, usernameFragment,
  });
}

export function renewAbortPayload(
  from: string, to: string, epoch: number, reason: RenewAbortReason,
): string {
  return JSON.stringify({ kind: "link-renew-abort", from, to, epoch, reason });
}

/**
 * The data-lane probe/ack payload.
 *
 * `nonce` is standard padded base64 of the 16 raw bytes the frame carries. It is
 * re-encoded here rather than carried as bytes so the payload stays a string
 * with one rendering on all three platforms — the same reason the signalling
 * payloads are strings.
 */
export function renewProbePayload(
  kind: "link-renew-probe" | "link-renew-ack",
  from: string, to: string, epoch: number, round: number, nonce: string,
): string {
  return JSON.stringify({ kind, from, to, epoch, round, nonce });
}

// ── base64 ───────────────────────────────────────────────────────────────────

/** Standard RFC 4648 with padding, chunked so a large input cannot blow the
 *  engine's argument limit. Inputs here are 16 and 32 bytes; the chunking is the
 *  same defensive shape `webrtc.ts` uses and costs nothing. */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** Decode, or null for anything that is not standard padded base64 of exactly
 *  `expectBytes`. Never throws: it reads peer-authored strings. */
export function fromBase64(value: string, expectBytes?: number): Uint8Array | null {
  if (typeof value !== "string") return null;
  // `atob` accepts some unpadded and whitespace-bearing inputs; pin the alphabet
  // and the padding here so all three platforms agree on what is well-formed.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  let raw: string;
  try {
    raw = atob(value);
  } catch {
    return null;
  }
  if (expectBytes !== undefined && raw.length !== expectBytes) return null;
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ── signing ──────────────────────────────────────────────────────────────────

/**
 * Sign/verify a SIGNALLING payload: base64, exactly as `authPayload` tags are.
 *
 * Reuses `signResume`/`verifyResume` rather than re-deriving anything: the key
 * is the link's existing `resumeAuth` and the derivation is untouched by this
 * feature. That is the whole point — renewal introduces no new secret, so there
 * is no new key agreement to get wrong.
 */
export function signRenew(key: CryptoKey, payload: string): Promise<string> {
  return signResume(key, payload);
}

export function verifyRenew(key: CryptoKey, payload: string, mac: string | undefined): Promise<boolean> {
  // Length first: this bounds the decode and the HMAC alike, and a tag of any
  // other length cannot be a 32-byte MAC in standard padded base64.
  if (typeof mac !== "string" || mac.length !== RENEW_AUTH_LENGTH) return Promise.resolve(false);
  return verifyResume(key, payload, mac);
}

/** Sign a probe payload and return the RAW 32 bytes the frame carries. */
export async function signRenewProbe(key: CryptoKey, payload: string): Promise<Uint8Array> {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return new Uint8Array(mac);
}

/** Verify a raw 32-byte frame tag. Web Crypto does the comparison, so there is
 *  no hand-written equality to get wrong. */
export function verifyRenewProbe(
  key: CryptoKey, payload: string, tag: Uint8Array,
): Promise<boolean> {
  if (tag.byteLength !== RENEW_TAG_BYTES) return Promise.resolve(false);
  // Copy into a fresh ArrayBuffer-backed view: a subarray of a larger frame is a
  // view with an offset, which Web Crypto accepts, but slicing makes the bytes
  // the signature covers unambiguous at the call site.
  const sig = new Uint8Array(tag);
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
}

// ── the data-lane control frame ──────────────────────────────────────────────

export interface RenewProbeFrame {
  type: typeof RENEW_PROBE_TYPE_PROBE | typeof RENEW_PROBE_TYPE_ACK;
  epoch: number;
  round: number;
  /** Raw 16 bytes. */
  nonce: Uint8Array;
  /** Raw 32 bytes. */
  tag: Uint8Array;
}

/** Build the 59-byte frame. `nonce` and `tag` must already be the right length;
 *  a caller that produces either is producing them from this module's own
 *  constants, so this is an assertion rather than a parse. */
export function encodeRenewProbe(frame: RenewProbeFrame): ArrayBuffer {
  if (frame.nonce.byteLength !== RENEW_NONCE_BYTES) throw new Error("relayium: renew probe nonce length");
  if (frame.tag.byteLength !== RENEW_TAG_BYTES) throw new Error("relayium: renew probe tag length");
  const out = new Uint8Array(RENEW_PROBE_FRAME_BYTES);
  const view = new DataView(out.buffer);
  out[0] = RENEW_PROBE_KIND;
  out[1] = RENEW_PROBE_VERSION;
  out[2] = frame.type;
  view.setUint32(3, frame.epoch);
  view.setUint32(7, frame.round);
  out.set(frame.nonce, 11);
  out.set(frame.tag, 27);
  return out.buffer;
}

/**
 * Read a frame, or null.
 *
 * **Cheap checks only.** Length, kind byte, version, type — nothing here
 * allocates beyond two small copies and nothing here verifies a MAC. The caller
 * runs the epoch/round match and the per-epoch budget before it spends an HMAC,
 * which is the order §4.6 already establishes for leave signals.
 */
export function decodeRenewProbe(data: ArrayBuffer): RenewProbeFrame | null {
  if (!(data instanceof ArrayBuffer) || data.byteLength !== RENEW_PROBE_FRAME_BYTES) return null;
  const bytes = new Uint8Array(data);
  if (bytes[0] !== RENEW_PROBE_KIND) return null;
  if (bytes[1] !== RENEW_PROBE_VERSION) return null;
  const type = bytes[2];
  if (type !== RENEW_PROBE_TYPE_PROBE && type !== RENEW_PROBE_TYPE_ACK) return null;
  const view = new DataView(data);
  return {
    type,
    epoch: view.getUint32(3),
    round: view.getUint32(7),
    nonce: bytes.slice(11, 11 + RENEW_NONCE_BYTES),
    tag: bytes.slice(27, 27 + RENEW_TAG_BYTES),
  };
}

/**
 * Whether a data-lane frame is claiming to be a renewal control frame AT ALL.
 *
 * Deliberately weaker than `decodeRenewProbe`: it answers the DEMUX question —
 * "must this frame be consumed here rather than shown to the text session?" —
 * from the first byte alone. A frame that starts with `0x0d` and then fails
 * every later check is still ours, and still must not reach the text lane's
 * `markFailed` path or its rate budget. Dropping it silently is the answer; the
 * text codec sees nothing either way.
 */
export function isRenewControlFrame(data: unknown): data is ArrayBuffer {
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return false;
  return new Uint8Array(data)[0] === RENEW_PROBE_KIND;
}

// ── the signalling envelope ──────────────────────────────────────────────────

export type RenewSignal =
  | { type: "prepare"; epoch: number }
  | { type: "ready"; epoch: number; round: number }
  | { type: "sdp"; epoch: number; round: number; sdpType: "offer" | "answer"; sdp: string }
  | {
      type: "ice"; epoch: number; round: number; candidate: string;
      sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment: string;
    }
  | { type: "abort"; epoch: number; reason: RenewAbortReason };

/** The outer frame exactly as it goes on the wire. Three keys, no more. */
export interface RenewEnvelope {
  link: true;
  renew: RenewSignal;
  auth: string;
}

/** Every key a renew envelope may carry. */
const RENEW_ENVELOPE_KEYS = ["link", "renew", "auth"];

/** The exact inner key set per type, so an extra or missing field is a reject
 *  rather than something a later handler has to be defensive about. */
const RENEW_INNER_KEYS: Record<string, readonly string[]> = {
  prepare: ["type", "epoch"],
  ready: ["type", "epoch", "round"],
  sdp: ["type", "epoch", "round", "sdpType", "sdp"],
  ice: ["type", "epoch", "round", "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"],
  abort: ["type", "epoch", "reason"],
};

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length) return false;
  for (const key of keys) if (!allowed.includes(key)) return false;
  return true;
}

/**
 * Recognise a renewal envelope by exact shape, BEFORE anything cryptographic
 * runs — and, just as importantly, before anything else in the `link`
 * generation sees it.
 *
 * ## Why SDP is nested and never top-level
 *
 * `establish()` filters inbound signals by GENERATION, not by kind. A renewal
 * message rides `link: true`, so an in-flight establishment for the same peer
 * sees it too. A top-level `sdp` would be applied by `handleSignal` as a real
 * renegotiation — unauthenticated, from a signalling relay, against a live
 * PeerConnection — and a top-level `ice` would be added to it. Nesting them
 * under `renew` makes this frame inert everywhere except the renewal
 * controller, and makes that property a test rather than a convention.
 *
 * Returns null for anything that is not exactly this shape. A near miss is not
 * repaired and not reported: an older peer sends none of this, and a relay
 * rewriting it into a near miss gets silence.
 */
export function parseRenewEnvelope(data: unknown): RenewEnvelope | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const outer = data as Record<string, unknown>;
  if (outer.link !== true) return null;
  if (!exactKeys(outer, RENEW_ENVELOPE_KEYS)) return null;
  if (typeof outer.auth !== "string" || outer.auth.length !== RENEW_AUTH_LENGTH) return null;
  const renew = outer.renew;
  if (!renew || typeof renew !== "object" || Array.isArray(renew)) return null;
  const inner = renew as Record<string, unknown>;
  const type = inner.type;
  if (typeof type !== "string") return null;
  const allowed = RENEW_INNER_KEYS[type];
  if (!allowed || !exactKeys(inner, allowed)) return null;
  if (!isUint32(inner.epoch)) return null;

  switch (type) {
    case "prepare":
      return { link: true, renew: { type: "prepare", epoch: inner.epoch }, auth: outer.auth };
    case "ready":
      if (!isUint32(inner.round)) return null;
      return {
        link: true,
        renew: { type: "ready", epoch: inner.epoch, round: inner.round },
        auth: outer.auth,
      };
    case "sdp": {
      if (!isUint32(inner.round)) return null;
      const sdpType = inner.sdpType;
      if (sdpType !== "offer" && sdpType !== "answer") return null;
      // Non-empty: an empty description is not one a peer connection can apply,
      // and a signed empty string would still cost a `setRemoteDescription`.
      if (typeof inner.sdp !== "string" || inner.sdp === "") return null;
      return {
        link: true,
        renew: { type: "sdp", epoch: inner.epoch, round: inner.round, sdpType, sdp: inner.sdp },
        auth: outer.auth,
      };
    }
    case "ice": {
      if (!isUint32(inner.round)) return null;
      if (typeof inner.candidate !== "string" || inner.candidate === "") return null;
      // Explicitly nullable, and EXPLICIT: `undefined` is not accepted, because
      // a Swift/Kotlin encoder that omits an absent optional would then produce
      // a payload this side renders with `null` and the tag would not verify.
      // Requiring the key present with a null value makes the three ports agree.
      const sdpMid = inner.sdpMid;
      if (sdpMid !== null && typeof sdpMid !== "string") return null;
      const sdpMLineIndex = inner.sdpMLineIndex;
      if (sdpMLineIndex !== null && !isUint32(sdpMLineIndex)) return null;
      // Non-empty, always. A candidate whose generation cannot be named is a
      // candidate that cannot be bound to an epoch — see the controller.
      if (typeof inner.usernameFragment !== "string" || inner.usernameFragment === "") return null;
      return {
        link: true,
        renew: {
          type: "ice", epoch: inner.epoch, round: inner.round,
          candidate: inner.candidate, sdpMid, sdpMLineIndex,
          usernameFragment: inner.usernameFragment,
        },
        auth: outer.auth,
      };
    }
    case "abort": {
      const reason = inner.reason;
      if (typeof reason !== "string" || !RENEW_ABORT_REASONS.includes(reason as RenewAbortReason)) return null;
      return {
        link: true,
        renew: { type: "abort", epoch: inner.epoch, reason: reason as RenewAbortReason },
        auth: outer.auth,
      };
    }
    default:
      return null;
  }
}

/** The canonical payload a given inner signal's tag covers. One function, used
 *  by the signer and the verifier alike, so the two cannot drift. */
export function renewSignalPayload(signal: RenewSignal, from: string, to: string): string {
  switch (signal.type) {
    case "prepare": return renewPreparePayload(from, to, signal.epoch);
    case "ready": return renewReadyPayload(from, to, signal.epoch, signal.round);
    case "sdp": return renewSdpPayload(from, to, signal.epoch, signal.round, signal.sdpType, signal.sdp);
    case "ice":
      return renewIcePayload(
        from, to, signal.epoch, signal.round,
        signal.candidate, signal.sdpMid, signal.sdpMLineIndex, signal.usernameFragment,
      );
    case "abort": return renewAbortPayload(from, to, signal.epoch, signal.reason);
  }
}

/** Build a signed envelope. `from`/`to` are this side's view of the pair. */
export async function sealRenewSignal(
  key: CryptoKey, signal: RenewSignal, from: string, to: string,
): Promise<RenewEnvelope> {
  const auth = await signRenew(key, renewSignalPayload(signal, from, to));
  return { link: true, renew: signal, auth };
}

// ── the server round envelopes ───────────────────────────────────────────────

/** `C->S {type:"ice-renew", data:{round, rid}}`. `round` is the round being
 *  ASKED for; `rid` correlates this request with its reply and is local. */
export interface IceRenewRequest {
  round: number;
  rid: number;
}

export interface IceGrant {
  status: RenewGrantStatus;
  round: number;
  rid: number;
  /** Present on `granted`, in exactly the `/api/ice` shape. Deliberately the
   *  same shape and the same parser: renewal introduces no second credential
   *  format, so there is no second thing for a client to get wrong. */
  iceServers?: unknown;
  relays?: unknown;
  /** On `denied`, the same `quota`/`unverified` vocabulary `/api/ice` uses. */
  relayDenied?: string;
  /** Diagnostics only. Never routed on, never shown. */
  reason?: RenewGrantReason;
}

/**
 * Read an `ice-grant` payload, or null.
 *
 * Strict about the three fields the state machine routes on (`status`, `round`,
 * `rid`) and deliberately permissive about the credential body, which is handed
 * to `ice.ts`'s existing sanitiser — the one place that already knows how to
 * survive a hostile `/api/ice` response, and the one that must stay the only
 * place.
 */
export function parseIceGrant(data: unknown): IceGrant | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = data as Record<string, unknown>;
  const status = raw.status;
  if (typeof status !== "string" || !RENEW_GRANT_STATUSES.includes(status as RenewGrantStatus)) return null;
  if (!isUint32(raw.round) || !isUint32(raw.rid)) return null;
  const grant: IceGrant = { status: status as RenewGrantStatus, round: raw.round, rid: raw.rid };
  if (raw.iceServers !== undefined) grant.iceServers = raw.iceServers;
  if (raw.relays !== undefined) grant.relays = raw.relays;
  if (typeof raw.relayDenied === "string") grant.relayDenied = raw.relayDenied;
  if (typeof raw.reason === "string" && RENEW_GRANT_REASONS.includes(raw.reason as RenewGrantReason)) {
    grant.reason = raw.reason as RenewGrantReason;
  }
  return grant;
}

// ── SDP pinning ──────────────────────────────────────────────────────────────

/**
 * The parts of an applied description an `epoch ≥ 1` remote description must
 * reproduce exactly.
 *
 * Pinning keeps the DTLS peer the same across the migration. It is NOT the root
 * of trust — that stays the E2E key the SAS anchored — but without it a
 * signalling relay that can inject a signed-looking renewal (it cannot; it lacks
 * `resumeAuth`) or that simply reorders m-lines could move the transport under
 * a link whose keys are unchanged. Cheap, exact, and checkable in a fixture.
 */
export interface SdpPin {
  /** Normalised `a=fingerprint` values, sorted, deduplicated. */
  fingerprints: readonly string[];
  /** `a=mid:` values in m-line order. Length is the m-line count. */
  mids: readonly string[];
  /** The `a=setup:` role the ANSWER carries, or "" when this description is not
   *  an answer / states none. */
  setup: string;
}

/**
 * Extract the pin from an SDP string.
 *
 * Line-based and deliberately dumb: SDP is `\r\n`-separated `x=value` lines, and
 * everything read here is a session- or media-level attribute with a fixed
 * prefix. Anything unrecognised is ignored rather than rejected — a browser is
 * free to add attributes between versions, and a pin that broke on one would
 * turn a routine Chrome update into a link that can never renew.
 *
 * Fingerprints are normalised to `<hash-lower> <hex-upper>` and sorted, because
 * the two ends may list the same set in a different order and may differ in case
 * (RFC 8122 leaves the hex case open; Chromium emits upper, some stacks lower).
 * Comparing a SET rather than a sequence is what makes a bundled two-m-line
 * description and a re-ordered one the same pin.
 */
export function sdpPin(sdp: string): SdpPin {
  const fingerprints = new Set<string>();
  const mids: string[] = [];
  let setup = "";
  if (typeof sdp !== "string") return { fingerprints: [], mids: [], setup };
  for (const rawLine of sdp.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line.startsWith("a=fingerprint:")) {
      const value = line.slice("a=fingerprint:".length).trim();
      const space = value.indexOf(" ");
      if (space <= 0) continue;
      const hash = value.slice(0, space).toLowerCase();
      const hex = value.slice(space + 1).trim().toUpperCase();
      if (hash === "" || hex === "") continue;
      fingerprints.add(`${hash} ${hex}`);
      continue;
    }
    if (line.startsWith("a=mid:")) {
      mids.push(line.slice("a=mid:".length).trim());
      continue;
    }
    if (line.startsWith("a=setup:")) {
      // The LAST setup line wins, matching how a media-level attribute overrides
      // a session-level one. A bundled description states one.
      setup = line.slice("a=setup:".length).trim().toLowerCase();
    }
  }
  return { fingerprints: [...fingerprints].sort(), mids, setup };
}

/**
 * Whether a later description may be applied against the epoch-0 baseline.
 *
 * `setup` is compared only for an ANSWER: an offer legitimately states
 * `actpass`, and a renewal offer restating it is not a role change. The answer
 * is where the role is actually chosen, and a flipped role there would mean a
 * different DTLS handshake direction under the same keys.
 */
export function sdpPinMatches(baseline: SdpPin, next: SdpPin, isAnswer: boolean): boolean {
  if (baseline.fingerprints.length !== next.fingerprints.length) return false;
  for (let i = 0; i < baseline.fingerprints.length; i++) {
    if (baseline.fingerprints[i] !== next.fingerprints[i]) return false;
  }
  if (baseline.mids.length !== next.mids.length) return false;
  for (let i = 0; i < baseline.mids.length; i++) {
    if (baseline.mids[i] !== next.mids[i]) return false;
  }
  if (isAnswer && baseline.setup !== "" && baseline.setup !== next.setup) return false;
  return true;
}

// ── ufrag ────────────────────────────────────────────────────────────────────

/**
 * The `a=ice-ufrag:` of a description, or "".
 *
 * A bundled `link/1` description has one. If a future description ever carried
 * two different ones this returns the FIRST, which is the conservative answer:
 * a candidate whose ufrag does not match it is dropped, and dropping a usable
 * candidate costs a failed migration that keeps the old deadline — while
 * accepting one from the wrong generation is what the binding exists to stop.
 */
export function sdpIceUfrag(sdp: string): string {
  if (typeof sdp !== "string") return "";
  for (const rawLine of sdp.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line.startsWith("a=ice-ufrag:")) return line.slice("a=ice-ufrag:".length).trim();
  }
  return "";
}

/**
 * The ufrag a CANDIDATE STRING states, or "".
 *
 * Read from the candidate's own `ufrag` extension — `candidate:... ufrag <x>` —
 * and never from a mutable "current epoch" variable. That distinction is the
 * whole point: `onicecandidate` fires asynchronously and a restart can land
 * between gathering and delivery, so labelling a candidate with whatever epoch
 * happens to be current at delivery time attributes it to the wrong generation.
 * The candidate says which ufrag it belongs to; believe the candidate.
 *
 * Apple's `RTCIceCandidate` and Android's `org.webrtc.IceCandidate` expose no
 * `usernameFragment` property, so this string parse is the ONLY portable source
 * and is what the native ports use too.
 */
export function candidateUfrag(candidate: string): string {
  if (typeof candidate !== "string") return "";
  const parts = candidate.trim().split(/\s+/);
  // Extensions are `name value` pairs after the fixed prefix; scan pairwise so a
  // literal "ufrag" appearing as a VALUE cannot be read as the key.
  for (let i = 0; i + 1 < parts.length; i++) {
    if (parts[i] === "ufrag") return parts[i + 1];
  }
  return "";
}

/**
 * A stable key for the TRANSPORT ADDRESS a candidate describes.
 *
 * ## Why this exists
 *
 * §6.3 needs the ufrag generation of the candidate the ICE agent actually
 * SELECTED, and the only portable way to ask is `getStats`. Chromium reports
 * `usernameFragment` on a local candidate stat; other stacks do not, and the
 * spec's answer is to keep our own mapping from the candidates we gathered.
 *
 * A stats row and an `RTCIceCandidate` have no shared identifier — the stats
 * `id` is not the candidate's foundation — so the mapping is keyed on what both
 * sides do state: protocol, address, port and type. That tuple is unique among
 * one agent's simultaneously-live local candidates, which is all this has to
 * distinguish.
 *
 * Returns "" for a candidate string this cannot parse, and a caller that gets
 * "" records nothing — which makes observation fail rather than match the wrong
 * generation.
 */
export function candidateAddressKey(candidate: string): string {
  if (typeof candidate !== "string") return "";
  // candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <type> …
  const parts = candidate.trim().replace(/^a=/, "").split(/\s+/);
  if (parts.length < 8 || !parts[0].startsWith("candidate:")) return "";
  const typIndex = parts.indexOf("typ");
  if (typIndex < 0 || typIndex + 1 >= parts.length) return "";
  return statsAddressKey(parts[2], parts[4], parts[5], parts[typIndex + 1]);
}

/** The same key, built from the fields a `getStats` local-candidate row states. */
export function statsAddressKey(
  protocol: unknown, address: unknown, port: unknown, candidateType: unknown,
): string {
  if (typeof protocol !== "string" || protocol === "") return "";
  if (typeof address !== "string" || address === "") return "";
  const portNumber = typeof port === "number" ? port : Number(port);
  if (!Number.isInteger(portNumber)) return "";
  if (typeof candidateType !== "string" || candidateType === "") return "";
  return `${protocol.toLowerCase()}|${address}|${portNumber}|${candidateType.toLowerCase()}`;
}

/**
 * The ufrag of an inbound candidate, requiring the two sources to agree.
 *
 * A candidate carries its generation twice: in the `usernameFragment` field of
 * the signal, and in its own string extension. A native peer may populate only
 * the second. Requiring agreement where both exist, and accepting a single
 * source where only one does, is what makes the binding work across the three
 * clients without letting a relay relabel a candidate by editing whichever copy
 * the receiver happens to read.
 *
 * Returns "" when they contradict each other or when neither states one — both
 * of which mean the candidate cannot be attributed and must be dropped.
 */
export function inboundCandidateUfrag(candidate: string, usernameFragment: string): string {
  const embedded = candidateUfrag(candidate);
  const stated = typeof usernameFragment === "string" ? usernameFragment : "";
  if (embedded !== "" && stated !== "" && embedded !== stated) return "";
  return stated !== "" ? stated : embedded;
}
