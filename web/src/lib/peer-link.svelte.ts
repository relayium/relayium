// One authenticated Web link to one peer. This layer owns transport trust and
// the six nonce-bearing codecs; file/text product state machines consume it but
// must never construct replacement codecs while the link is alive.

import { deriveSession, generateKeyPair, sas, signResume, verifyResume, type SessionKeys } from "./crypto";
import { peerSupportsLink } from "./peer-caps.svelte";
import { Receiver, Sender } from "./transfer";
import { TextReceiver, TextSender } from "./text-wire";
import { StoredKeysReceiver, StoredKeysSender } from "./preupload-handoff";
import {
  LINK_CAPTURE_MAX_BYTES,
  authPayload,
  connectLink,
  connectResumeLink,
  linkLeavePayload,
  PeerBusyError,
  signalGeneration,
  type Conn,
  type InboundSignal,
  type RtcConfig,
  type SignalAuth,
} from "./webrtc";
import type { SignalingClient } from "./signaling";

export const LINK_REQUEST_TIMEOUT_MS = 30_000;
export const LINK_REQUEST_RETRY_MS = 3_000;
export const LINK_AUTH_TIMEOUT_MS = 30_000;
/** How long a link may stay `interrupted` with no transport under it. Matches the
 *  legacy one-shot resume window: the peer that dropped is the same peer, and a
 *  user who walked away should not leave an authenticated link half-alive. */
export const LINK_RECOVERY_WINDOW_MS = 90_000;
/** Backoff between initiator rebuild attempts inside that window. */
export const LINK_RECOVERY_RETRY_MS = 1_500;
/** SHA-256 HMAC is 32 bytes, encoded by signResume as padded base64. Checking
 *  this before atob/HMAC also bounds the cost of each allowed verification. */
export const LINK_LEAVE_AUTH_LENGTH = 44;
/** How many leave signals one authenticated link will ever spend an HMAC on.
 *  A leave is terminal, so a genuine peer needs one; the budget exists purely so
 *  a replayed or forged tag cannot buy unbounded verification work. Exhausting
 *  it costs nothing real — the link simply falls back to the recovery window. */
export const LINK_LEAVE_MAX_ATTEMPTS = 8;

export type PeerLinkStatus = "idle" | "requesting" | "connecting" | "open" | "interrupted" | "failed";

export interface CapturedLinkFrames {
  readonly file: readonly ArrayBuffer[];
  readonly text: readonly ArrayBuffer[];
}

export interface MixedPeerLink {
  readonly peerId: string;
  readonly role: "initiator" | "responder";
  readonly conn: Conn;
  readonly fileChannel: RTCDataChannel;
  readonly textChannel: RTCDataChannel;
  readonly keys: SessionKeys;
  readonly sas: string;
  /** Exactly one instance of each codec per link. Never replace these for a new
   *  batch, reopened conversation or authenticated transport resume. */
  readonly fileSender: Sender;
  readonly fileReceiver: Receiver;
  readonly textSender: TextSender;
  readonly textReceiver: TextReceiver;
  /** The pre-upload key-handoff codecs. Link-scoped like the other four, and for
   *  the same reason: each owns one `(derived key, direction)` nonce counter, so
   *  a rebuilt transport must reuse these objects rather than restart a counter
   *  under a key that has already sealed frames at those seqs. */
  readonly storedKeysSender: StoredKeysSender;
  readonly storedKeysReceiver: StoredKeysReceiver;
}

export class UnsupportedLinkError extends Error {
  constructor() {
    super("relayium: peer does not support link/1");
    this.name = "UnsupportedLinkError";
  }
}

export class LinkBusyError extends Error {
  constructor() {
    super("relayium: another peer link is active");
    this.name = "LinkBusyError";
  }
}

export class LinkRequestTimeoutError extends Error {
  constructor() {
    super("relayium: link request timed out");
    this.name = "LinkRequestTimeoutError";
  }
}

export class LinkAuthenticationTimeoutError extends Error {
  constructor() {
    super("relayium: link authentication timed out");
    this.name = "LinkAuthenticationTimeoutError";
  }
}

/** replaceTransport was asked to rebuild a transport for a peer that is not the
 *  current link's peer, or with no link current at all. Distinct from
 *  LinkBusyError on purpose: nothing was displaced and nothing was closed, so a
 *  caller can tell "your link is gone" apart from "someone else holds it". */
export class LinkReplaceUnavailableError extends Error {
  constructor() {
    super("relayium: no matching link to replace");
    this.name = "LinkReplaceUnavailableError";
  }
}

/** A replacement transport completed after its link stopped being current, or
 *  after the manager was closed or superseded. The rebuilt transport is closed
 *  and never published. */
export class LinkReplaceStaleError extends Error {
  constructor() {
    super("relayium: superseded mixed link transport");
    this.name = "LinkReplaceStaleError";
  }
}

/** An interrupted link found no replacement transport inside
 *  LINK_RECOVERY_WINDOW_MS. The link is torn down; nothing about it survives. */
export class LinkRecoveryTimeoutError extends Error {
  constructor() {
    super("relayium: mixed link recovery timed out");
    this.name = "LinkRecoveryTimeoutError";
  }
}

export interface PeerLinkDeps {
  selfId: () => string;
  signaling: () => SignalingClient;
  rtcConfig: () => RtcConfig;
  supportsLink?: (peerId: string) => boolean;
  /** Resource-admission gate only. File batches and text conversations still
   *  have their own user-consent state machines after the link opens. */
  canAcceptLink?: (peerId: string) => boolean;
  /** Test seam. Production always uses the full commit-reveal connectLink. */
  connect?: typeof connectLink;
  /** Test seam for the transport-only rebuild. Production always uses the
   *  authenticated dual-lane connectResumeLink. */
  resume?: typeof connectResumeLink;
  /** Synchronous lifecycle hook. Consumers use this to attach lane handlers
   *  before an inbound peer can race its first protected application frame. */
  onLinkChange?: (
    link: MixedPeerLink | null,
    status: PeerLinkStatus,
    captured?: CapturedLinkFrames,
  ) => void;
  /**
   * The single policy decision for a dead transport, asked exactly once per
   * `Conn`, while the link is still current and before anything is published.
   *
   * Returning true holds the link: it stays `current` with its keys, SAS and
   * every codec untouched while a replacement transport is built under it.
   * Returning false (or omitting the hook) reproduces the unconditional
   * teardown. The manager owns the mechanism — window, retries, `ensure()`
   * joining — and deliberately none of the policy: only the lane owner knows
   * whether there was work worth reconnecting for.
   */
  onTransportLost?: (link: MixedPeerLink) => boolean;
  /**
   * How long the rebuild driver may keep trying, asked once per gap.
   *
   * Defaults to LINK_RECOVERY_WINDOW_MS, which is what LAN and P2P keep. A
   * relayed link hands back the time left on its TURN credential instead, so the
   * driver can never still be re-offering under a credential that has expired.
   * Zero (or less) means the gap is not holdable at all: the link fails
   * immediately rather than showing a recovery that cannot succeed.
   */
  recoveryWindowMs?: () => number;
}

export function isLinkOffer(data: unknown): data is InboundSignal {
  if (!data || typeof data !== "object") return false;
  const d = data as InboundSignal;
  return d.link === true && !d.resume && d.sdp?.type === "offer";
}

export function isLinkRequest(data: unknown): data is InboundSignal {
  return !!data && typeof data === "object"
    && (data as InboundSignal).link === true
    && (data as InboundSignal).linkRequest === true
    && !(data as InboundSignal).sdp;
}

/** Every key a leave signal is allowed to carry. */
const LEAVE_KEYS = ["link", "leave", "auth"];

/**
 * Recognise a leave signal by exact shape, before anything cryptographic runs.
 *
 * The allow-list is the point, not a formality. This message rides the `link`
 * generation, which means an establishment in flight for the same peer sees it
 * too (`establish()` filters by generation, not by message kind). A `commit`
 * would be recorded by connectLink's `beforeSdp`, a `caps` array would reach
 * `onPeerCaps`, a `busy` would fail a connecting link, and `sdp`/`ice` would be
 * handled outright. Requiring exactly `{ link, leave, auth }` makes the signal
 * inert everywhere except here — and makes that property testable.
 */
export function isLinkLeave(data: unknown): data is InboundSignal & { auth: string } {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (d.link !== true || d.leave !== true || typeof d.auth !== "string"
      || d.auth.length !== LINK_LEAVE_AUTH_LENGTH) return false;
  const keys = Object.keys(d);
  if (keys.length !== LEAVE_KEYS.length) return false;
  for (const key of keys) {
    if (!LEAVE_KEYS.includes(key)) return false;
  }
  return true;
}

/** Both peers compute the same transport role without creating competing SDP. */
export function linkRole(selfId: string, peerId: string): "initiator" | "responder" {
  return selfId < peerId ? "initiator" : "responder";
}

function asArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return null;
}

/**
 * Bounded pre-attachment capture for ONE transport generation of a link.
 *
 * Drains whatever the connection primitive retained from the instant each
 * channel was collected, then keeps both lanes captured until the frames are
 * handed to their owners. Establishment and an authenticated transport
 * replacement share this because they share the hazard: an SCTP stream can
 * deliver data before its sibling has finished DCEP, and on a replacement those
 * frames belong to codecs that already exist and whose sequences must stay
 * continuous.
 *
 * The bound is combined across both lanes. Overflow is never silent truncation:
 * the caller fails closed, because a dropped admitted frame is exactly what the
 * receiver codecs cannot tolerate.
 */
function beginCapture(conn: Conn, fileChannel: RTCDataChannel, textChannel: RTCDataChannel) {
  const early = {
    file: conn.takeCaptured?.("relayium"),
    text: conn.takeCaptured?.("relayium-text"),
  };
  const file: ArrayBuffer[] = [...(early.file?.frames ?? [])];
  const text: ArrayBuffer[] = [...(early.text?.frames ?? [])];
  let bytes = file.reduce((sum, frame) => sum + frame.byteLength, 0)
    + text.reduce((sum, frame) => sum + frame.byteLength, 0);
  let overflow = early.file?.overflow === true || early.text?.overflow === true
    || bytes > LINK_CAPTURE_MAX_BYTES;
  const sink = (frames: ArrayBuffer[]) => (event: MessageEvent) => {
    const frame = asArrayBuffer(event.data);
    if (!frame || overflow) return;
    if (bytes + frame.byteLength > LINK_CAPTURE_MAX_BYTES) {
      overflow = true;
      return;
    }
    bytes += frame.byteLength;
    frames.push(frame);
  };
  const fileCapture = sink(file);
  const textCapture = sink(text);
  fileChannel.binaryType = "arraybuffer";
  textChannel.binaryType = "arraybuffer";
  fileChannel.onmessage = fileCapture;
  textChannel.onmessage = textCapture;
  return {
    get overflow() { return overflow; },
    /** Freeze and detach the sinks before consumer code runs. If a lane refuses
     *  attachment, replay can no longer feed the live array back into itself. */
    take(): CapturedLinkFrames {
      if (fileChannel.onmessage === fileCapture) fileChannel.onmessage = null;
      if (textChannel.onmessage === textCapture) textChannel.onmessage = null;
      return { file: [...file], text: [...text] };
    },
  };
}

export function createPeerLinkManager(deps: PeerLinkDeps) {
  const supports = deps.supportsLink ?? peerSupportsLink;
  const openTransport = deps.connect ?? connectLink;
  const openResume = deps.resume ?? connectResumeLink;
  // Keep the link opaque: deep-proxying native RTC objects changes identity and
  // offers no useful reactivity. Assigning a replacement link is reactive.
  let current = $state.raw<MixedPeerLink | null>(null);
  let status = $state<PeerLinkStatus>("idle");
  let opening: {
    peerId: string;
    token: number;
    controller: AbortController;
    promise: Promise<MixedPeerLink>;
  } | null = null;
  let replacing: {
    peerId: string;
    token: number;
    controller: AbortController;
    promise: Promise<MixedPeerLink>;
  } | null = null;
  let requested: {
    peerId: string;
    promise: Promise<MixedPeerLink>;
    resolve: (link: MixedPeerLink) => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    retry: ReturnType<typeof setInterval>;
  } | null = null;
  /** A link held with no transport under it, plus the bounded driver rebuilding
   *  one. `promise` is what `ensure()` hands to a lane intent raised mid-gap, so
   *  that intent lands on the rebuilt link instead of attaching to a dead one. */
  let recovering: {
    peerId: string;
    link: MixedPeerLink;
    promise: Promise<MixedPeerLink>;
    resolve: (link: MixedPeerLink) => void;
    reject: (err: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
    attemptTimer?: ReturnType<typeof setTimeout>;
  } | null = null;
  const timedOutPeers = new Set<string>();
  // Establishment and rebuild are independent async lifecycles with independent
  // staleness. Sharing one counter made a retrying recovery driver able to
  // invalidate an establishment's post-await checks (and vice versa).
  let linkToken = 0;
  let replaceToken = 0;
  /** The Conn whose terminal callback has already been handled. A transport
   *  reports `failed` and then `closed`; closing it here reports `closed` again.
   *  All of that is one gap. */
  let terminalConn: Conn | null = null;
  /** One inbound resume offer at a time may hold the rebuild slot while its tag
   *  is verified, so two offers arriving in the same burst cannot both start a
   *  PeerConnection into the same lanes. */
  let verifyingResume = false;
  /**
   * Identity of the current AUTHENTICATED link, not of the link object.
   *
   * `replaceTransport` publishes a different object carrying the same keys, SAS
   * and codecs; that is the same authentication step and must not invalidate
   * work started before it. Establishment and teardown do advance this, so a
   * stale async result can never be accepted by a later link — even one to the
   * same peer, whose SAS may even collide.
   */
  let authGeneration = 0;
  /** One leave verification at a time; the rest of a burst is dropped without
   *  spending budget, so a flood costs one HMAC, not one per message. */
  let verifyingLeave = false;
  /** Spent HMACs on inbound leave signals for the current authenticated link. */
  let leaveAttempts = 0;
  let unlisten: (() => void) | null = null;

  function publish(
    next: MixedPeerLink | null,
    nextStatus: PeerLinkStatus,
    captured?: CapturedLinkFrames,
  ) {
    // Any publish ends the gap: a replacement resolves the driver through
    // settleRecovery below, and a teardown can never be recovered from.
    if (!next) failRecovery(new Error("relayium: mixed link torn down during recovery"));
    // Same peer AND same SessionKeys object is exactly `replaceTransport`'s
    // contract, and nothing else can produce it: two different links always
    // derive two different key objects. Anything else is a new authentication
    // step (or the end of one), so the leave budget starts over with it.
    const sameLink = !!next && !!current
      && current.peerId === next.peerId && current.keys === next.keys;
    if (!sameLink) {
      authGeneration++;
      leaveAttempts = 0;
    }
    terminalConn = null;
    current = next;
    status = nextStatus;
    if (next) deps.onLinkChange?.(next, nextStatus, captured);
    else {
      // Terminal cleanup must still abort/close the transport even if a UI-side
      // observer misbehaves. Open-time attachment errors remain fail-closed.
      try { deps.onLinkChange?.(null, nextStatus); }
      catch (err) { console.error("relayium link teardown observer error", err); }
    }
  }

  function finishRequest(peerId: string, link?: MixedPeerLink, err?: unknown) {
    if (!requested || requested.peerId !== peerId) return;
    const r = requested;
    requested = null;
    clearTimeout(r.timer);
    clearInterval(r.retry);
    if (link) r.resolve(link);
    else {
      if (!current && !opening) status = "failed";
      r.reject(err ?? new Error("relayium: link request failed"));
    }
  }

  function clearRecoveryTimers(r: NonNullable<typeof recovering>) {
    clearTimeout(r.timer);
    if (r.attemptTimer !== undefined) clearTimeout(r.attemptTimer);
    r.attemptTimer = undefined;
  }

  function failRecovery(err: unknown) {
    const r = recovering;
    if (!r) return;
    recovering = null;
    clearRecoveryTimers(r);
    r.reject(err);
  }

  function settleRecovery(link: MixedPeerLink) {
    const r = recovering;
    if (!r || r.peerId !== link.peerId) return;
    recovering = null;
    clearRecoveryTimers(r);
    r.resolve(link);
  }

  function expireRecovery(r: NonNullable<typeof recovering>) {
    if (recovering !== r) return;
    const stale = replacing;
    failRecovery(new LinkRecoveryTimeoutError());
    if (current === r.link && status === "interrupted") {
      publish(null, "failed");
      try { r.link.conn.close(); } catch { /* already gone */ }
    }
    // A rebuild still in flight has lost its reason to exist. Its own staleness
    // checks would reject it anyway; aborting stops it waiting out ICE first.
    stale?.controller.abort();
  }

  /** Initiator side of the rebuild: retry until the window closes. The responder
   *  runs no driver at all — it answers the initiator's authenticated offer, so
   *  there is no rebuild glare and no new signal type. */
  function driveRecovery(r: NonNullable<typeof recovering>) {
    if (recovering !== r || current !== r.link || status !== "interrupted") return;
    void replaceTransport(r.peerId).catch(() => {
      if (recovering !== r) return;
      r.attemptTimer = setTimeout(() => {
        r.attemptTimer = undefined;
        driveRecovery(r);
      }, LINK_RECOVERY_RETRY_MS);
    });
  }

  function beginRecovery(link: MixedPeerLink, windowMs: number) {
    failRecovery(new Error("relayium: superseded mixed link recovery"));
    let resolve!: (next: MixedPeerLink) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<MixedPeerLink>((res, rej) => { resolve = res; reject = rej; });
    // The driver owns this promise's lifetime; a consumer may never ask for it.
    void promise.catch(() => {});
    const r: NonNullable<typeof recovering> = {
      peerId: link.peerId,
      link,
      promise,
      resolve,
      reject,
      timer: setTimeout(() => expireRecovery(r), windowMs),
    };
    recovering = r;
    // The establishment role, not a freshly computed one: both sides keep the
    // deterministic offerer/responder split their first connection produced.
    if (link.role === "initiator") driveRecovery(r);
  }

  /**
   * The one place a dead transport is turned into a decision.
   *
   * Called from establishment and from a rebuild alike, and only while the dying
   * `Conn` is still the current link's. A stale transport's terminal callback
   * therefore cannot tear down a newer one, and the `failed`-then-`closed` pair a
   * dying PeerConnection emits is one gap, not two.
   */
  function handleTerminalTransport(link: MixedPeerLink, conn: Conn, next: "failed" | "closed") {
    if (current !== link || link.conn !== conn || terminalConn === conn) return;
    terminalConn = conn;
    let hold = false;
    try { hold = deps.onTransportLost?.(link) === true; }
    catch (err) { console.error("relayium link transport-loss policy error", err); }
    // A window of zero is a refusal, asked separately from the policy above so a
    // lane that wants recovery cannot obtain one there is no time for. Reading it
    // here (not inside beginRecovery) keeps "held" and "recoverable" the same
    // answer: an `interrupted` status that can only expire is a lie on screen.
    let windowMs = LINK_RECOVERY_WINDOW_MS;
    if (hold) {
      try { windowMs = deps.recoveryWindowMs?.() ?? LINK_RECOVERY_WINDOW_MS; }
      catch (err) {
        console.error("relayium link recovery window error", err);
        windowMs = 0;
      }
      if (!(windowMs > 0)) hold = false;
    }
    if (!hold) {
      publish(null, next === "failed" ? "failed" : "idle");
      try { conn.close(); } catch { /* terminal already */ }
      return;
    }
    // Held: the link stays current with its keys, SAS and codecs untouched. Only
    // the dead connection is released, and closing it re-enters here inertly.
    status = "interrupted";
    try { conn.close(); } catch { /* terminal already */ }
    beginRecovery(link, windowMs);
  }

  /**
   * Consume an inbound resume-generation offer for an interrupted link.
   *
   * The tag is verified HERE, against this link's own `resumeAuth`, before the
   * offer is allowed to consume the single rebuild slot. connectResumeLink would
   * verify it too, but only after it has already allocated a PeerConnection and
   * begun ICE — and only after this manager committed to that offer being the
   * rebuild. Anything that does not verify is dropped in silence: answering
   * would tell a signalling relay which peer holds a live link.
   */
  async function handleResumeOffer(from: string, msg: InboundSignal) {
    const link = current;
    if (verifyingResume || replacing) return;
    if (!link || link.peerId !== from || status !== "interrupted") return;
    if (linkRole(deps.selfId(), from) !== "responder") return;
    if (typeof msg.auth !== "string") return;
    verifyingResume = true;
    try {
      const ok = await verifyResume(link.keys.resumeAuth, authPayload(msg), msg.auth);
      // The gap may have ended (or been replaced) while the MAC was computed.
      if (!ok || current !== link || status !== "interrupted" || replacing) return;
      void replaceTransport(from, msg).catch(() => {});
    } catch (err) {
      console.error("relayium link resume verification error", err);
    } finally {
      verifyingResume = false;
    }
  }

  /**
   * Consume an authenticated "I am leaving" signal for the current link.
   *
   * Without it, an explicit disconnect is indistinguishable from a network drop:
   * the peer holds an unrecoverable link for the whole recovery window, answers
   * that peer's fresh offers with `busy` for its duration, and (as initiator)
   * spends real ICE/TURN allocations rebuilding toward a browser that has gone.
   *
   * Every cheap check runs BEFORE the HMAC — shape, current link, peer, status,
   * budget — so a forged or replayed signal cannot buy verification work. A
   * signal that does not verify is dropped in silence, for the same reason a bad
   * resume offer is: answering would tell a signalling relay which peer holds a
   * live link. Losing the signal entirely is safe by construction; it degrades
   * to exactly the recovery-window behaviour that exists today.
   */
  async function handleLeave(from: string, msg: InboundSignal & { auth: string }) {
    if (verifyingLeave) return;
    const link = current;
    if (!link || link.peerId !== from) return;
    if (status !== "open" && status !== "interrupted") return;
    if (leaveAttempts >= LINK_LEAVE_MAX_ATTEMPTS) return;
    leaveAttempts++;
    // Identity is the authenticated link, NOT this object: a transport
    // replacement may publish a new one with the same keys and codecs while the
    // MAC is computed, and that is still the link this leave is about.
    const token = authGeneration;
    const keys = link.keys;
    verifyingLeave = true;
    try {
      const ok = await verifyResume(
        keys.resumeAuth,
        linkLeavePayload(from, deps.selfId()),
        msg.auth,
      );
      if (!ok || authGeneration !== token) return;
      const live = current;
      if (!live || live.peerId !== from || live.keys !== keys) return;
      if (status !== "open" && status !== "interrupted") return;
      // The peer is gone on purpose. Cancel recovery and any rebuild in flight,
      // publish exactly one teardown, and send nothing back.
      closeManager();
    } catch (err) {
      console.error("relayium link leave verification error", err);
    } finally {
      verifyingLeave = false;
    }
  }

  /**
   * Tell the peer this side is leaving on purpose. Best effort by design.
   *
   * The signing key, peer and signalling client are all captured synchronously,
   * because the caller tears the link down in the same tick and must not wait
   * for Web Crypto or for a reconnecting socket. A leave that never arrives is
   * not a failure mode of its own: the peer falls back to the recovery window.
   */
  function announceLeave(link: MixedPeerLink) {
    // Nothing here may throw into the teardown that follows it. Telling the peer
    // is a courtesy; ending the user's own session is not.
    try {
      const peerId = link.peerId;
      const client = deps.signaling();
      const payload = linkLeavePayload(deps.selfId(), peerId);
      void signResume(link.keys.resumeAuth, payload)
        .then((auth) => { client.sendSignal(peerId, { link: true, leave: true, auth }); })
        .catch((err) => console.error("relayium link leave announce error", err));
    } catch (err) {
      console.error("relayium link leave announce error", err);
    }
  }

  async function establish(
    peerId: string,
    role: "initiator" | "responder",
    initialSignal?: InboundSignal,
  ): Promise<MixedPeerLink> {
    if (current) {
      if (current.peerId === peerId) return current;
      throw new LinkBusyError();
    }
    if (opening) {
      if (opening.peerId === peerId) return opening.promise;
      throw new LinkBusyError();
    }
    if (requested && requested.peerId !== peerId) throw new LinkBusyError();
    if (requested?.peerId === peerId) {
      clearTimeout(requested.timer);
      clearInterval(requested.retry);
    }

    const mine = ++linkToken;
    const controller = new AbortController();
    let conn: Conn | undefined;
    status = "connecting";
    const promise = (async () => {
      const self = generateKeyPair();
      let resolvePeer!: (key: Uint8Array) => void;
      let rejectPeer!: (err: unknown) => void;
      const peerKey = new Promise<Uint8Array>((resolve, reject) => {
        resolvePeer = resolve;
        rejectPeer = reject;
      });
      // The terminal callback can run before openTransport resolves and before
      // the bounded authentication await is installed below.
      void peerKey.catch(() => {});
      let transportTerminal = false;
      conn = await openTransport({
        signaling: deps.signaling(), peerId, selfKey: self.publicKey, role,
        config: deps.rtcConfig(), initialSignal,
        signal: controller.signal,
        onPeerKey: resolvePeer,
        onStateChange: (next) => {
          if (next !== "failed" && next !== "closed") return;
          transportTerminal = true;
          rejectPeer(new Error(`relayium: transport ${next} during authentication`));
          if (conn && current && current.peerId === peerId && current.conn === conn) {
            handleTerminalTransport(current, conn, next);
          }
        },
      });
      const fileChannel = conn.getChannel("relayium");
      const textChannel = conn.getChannel("relayium-text");
      if (!fileChannel || !textChannel) throw new Error("relayium: incomplete mixed link");
      // Production connectLink has captured each channel since collection, even
      // while its sibling was still completing DCEP. Test seams without that
      // primitive start here; both paths then continue through authentication.
      const capture = beginCapture(conn, fileChannel, textChannel);
      // SCTP opening and commit/reveal delivery are independent. A channel can
      // therefore open after the peer's reveal was lost; never let that strand
      // the manager in `connecting` forever.
      const peerPublic = await new Promise<Uint8Array>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", abort);
          fn();
        };
        const timer = setTimeout(() => finish(
          () => reject(new LinkAuthenticationTimeoutError()),
        ), LINK_AUTH_TIMEOUT_MS);
        const abort = () => {
          const err = new Error("relayium: connection aborted");
          err.name = "AbortError";
          finish(() => reject(err));
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) abort();
        peerKey.then(
          (key) => finish(() => resolve(key)),
          (err) => finish(() => reject(err)),
        );
      });
      const keys = await deriveSession(role, self, peerPublic);
      if (capture.overflow || transportTerminal || mine !== linkToken) {
        throw new Error("relayium: incomplete or superseded mixed link");
      }
      const link: MixedPeerLink = {
        peerId, role, conn,
        fileChannel,
        textChannel,
        keys,
        sas: sas(self.publicKey, peerPublic),
        fileSender: new Sender(),
        fileReceiver: new Receiver(),
        textSender: new TextSender(),
        textReceiver: new TextReceiver(),
        storedKeysSender: new StoredKeysSender(),
        storedKeysReceiver: new StoredKeysReceiver(),
      };
      if (mine !== linkToken) {
        throw new Error("relayium: superseded mixed link");
      }
      const captured = capture.take();
      try {
        publish(link, "open", captured);
      } catch (err) {
        // A coordinator that cannot attach both lanes must not leave behind a
        // manager-visible link with no valid application owner.
        current = null;
        status = "failed";
        try { deps.onLinkChange?.(null, "failed"); } catch { /* original error wins */ }
        throw err;
      }
      finishRequest(peerId, link);
      return link;
    })().catch((cause) => {
      try { conn?.close(); } catch { /* already gone */ }
      const err = cause instanceof PeerBusyError ? new LinkBusyError() : cause;
      if (mine === linkToken) status = "failed";
      finishRequest(peerId, undefined, err);
      throw err;
    }).finally(() => {
      if (opening?.token === mine) opening = null;
    });
    opening = { peerId, token: mine, controller, promise };
    return promise;
  }

  /** Tear the whole link down, but only while it is still the current one — a
   *  stale operation may fail itself, never a newer link. */
  function failCurrent(link: MixedPeerLink) {
    if (current !== link) return;
    publish(null, "failed");
    try { link.conn.close(); } catch { /* already gone */ }
  }

  /**
   * Rebuild the transport under the CURRENT link, keeping the link itself.
   *
   * The published replacement reuses the exact SessionKeys, SAS and all six
   * nonce-bearing codec objects; only the Conn and the two channel objects
   * change. That identity is the whole contract: a link owns one
   * `(content key, direction)` sequence for its lifetime, so a rebuilt transport
   * must not be an opportunity to construct a second Sender or TextReceiver.
   *
   * All resume SDP and ICE is authenticated with the link's `resumeAuth`. There
   * is no commit-reveal here, so that tag is the only thing standing between the
   * link and a signalling relay that offers its own replacement transport — see
   * connectResumeLink.
   *
   * Bounded and fail-closed: a transport missing either lane, a pre-attachment
   * capture that overflows, a cancellation, a transport already terminal by the
   * time it could be attached, and a completion that arrives after this link
   * stopped being current all close the rebuilt transport and publish nothing.
   * Only capture overflow additionally fails the link, because dropped admitted
   * frames are the one failure the reused receiver codecs cannot survive.
   *
   * This slice deliberately provides the operation and no trigger for it: the
   * coordinator that decides *when* to resume (and that must therefore keep a
   * dropped link current long enough to rebuild it) is stage 3.
   */
  function replaceTransport(peerId: string, initialSignal?: InboundSignal): Promise<MixedPeerLink> {
    const link = current;
    if (!link || link.peerId !== peerId) return Promise.reject(new LinkReplaceUnavailableError());
    if (replacing) {
      // One rebuild at a time. A second call for the same link joins the one in
      // flight instead of racing a second PeerConnection into the same lanes.
      return replacing.peerId === peerId
        ? replacing.promise
        : Promise.reject(new LinkBusyError());
    }

    const mine = ++replaceToken;
    const controller = new AbortController();
    let conn: Conn | undefined;
    // The role that produced this link's keys. Both sides therefore keep the
    // deterministic offerer/responder split they computed from their peer ids at
    // establishment, and a rebuild cannot turn two peers into two offerers.
    const role = link.role;
    const auth: SignalAuth = {
      sign: (payload) => signResume(link.keys.resumeAuth, payload),
      verify: (payload, mac) => verifyResume(link.keys.resumeAuth, payload, mac),
    };
    // A transport can reach a terminal state after its channels opened but before
    // this side resumes past the await. Publishing then would hand the lanes a
    // connection whose only teardown callback has already fired.
    let transportTerminal = false;
    const promise = (async () => {
      conn = await openResume({
        signaling: deps.signaling(), peerId, role, auth,
        config: deps.rtcConfig(), initialSignal,
        signal: controller.signal,
        onStateChange: (next) => {
          if (next !== "failed" && next !== "closed") return;
          transportTerminal = true;
          // Only the published transport owns teardown. Before publication the
          // failure path below closes it; afterwards `current.conn` identifies
          // whether this callback belongs to the live transport or to one this
          // link has already replaced.
          if (!conn || !current || current.peerId !== peerId || current.conn !== conn) return;
          handleTerminalTransport(current, conn, next);
        },
      });
      const fileChannel = conn.getChannel("relayium");
      const textChannel = conn.getChannel("relayium-text");
      if (!fileChannel || !textChannel) throw new Error("relayium: incomplete mixed link");
      // Capture starts before anything can await again, so a peer that speaks
      // first on the rebuilt lanes cannot outrun lane attachment.
      const capture = beginCapture(conn, fileChannel, textChannel);
      if (controller.signal.aborted || mine !== replaceToken || current !== link) {
        throw new LinkReplaceStaleError();
      }
      if (transportTerminal) throw new Error("relayium: rebuilt mixed link transport is terminal");
      if (capture.overflow) {
        failCurrent(link);
        throw new Error("relayium: mixed link capture overflow");
      }
      const next: MixedPeerLink = {
        peerId: link.peerId,
        role: link.role,
        conn,
        fileChannel,
        textChannel,
        keys: link.keys,
        sas: link.sas,
        fileSender: link.fileSender,
        fileReceiver: link.fileReceiver,
        textSender: link.textSender,
        textReceiver: link.textReceiver,
        storedKeysSender: link.storedKeysSender,
        storedKeysReceiver: link.storedKeysReceiver,
      };
      const captured = capture.take();
      const old = link.conn;
      try {
        // Atomic: both lanes attach to the replacement inside this call, before
        // any captured frame replays and before the old transport is closed.
        publish(next, "open", captured);
      } catch (err) {
        current = null;
        status = "failed";
        try { deps.onLinkChange?.(null, "failed"); } catch { /* original error wins */ }
        try { old.close(); } catch { /* already gone */ }
        throw err;
      }
      // Now that the replacement is current, the old transport's own terminal
      // callback can no longer match `current.conn` — so closing it here cannot
      // publish null over a link that is already live.
      try { old.close(); } catch { /* already gone */ }
      // Attaching a lane can itself end the link (a lane owner that closes the
      // transport, a terminal state observed during attachment). Never hand back
      // a link the manager no longer holds.
      if (current !== next) throw new LinkReplaceStaleError();
      // The gap is over for everyone: an intent that joined mid-gap through
      // ensure() resolves onto this exact link, never a second one.
      settleRecovery(next);
      return next;
    })().catch((cause) => {
      // Never touch `current` here: unless the link was explicitly failed above,
      // the caller's link is still the one it had before it asked for a rebuild.
      try { conn?.close(); } catch { /* already gone */ }
      throw cause;
    }).finally(() => {
      if (replacing?.token === mine) replacing = null;
    });
    replacing = { peerId, token: mine, controller, promise };
    return promise;
  }

  function request(peerId: string): Promise<MixedPeerLink> {
    if (requested) {
      if (requested.peerId === peerId) return requested.promise;
      return Promise.reject(new LinkBusyError());
    }
    status = "requesting";
    timedOutPeers.delete(peerId);
    let resolve!: (link: MixedPeerLink) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<MixedPeerLink>((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimeout(() => {
      timedOutPeers.add(peerId);
      finishRequest(peerId, undefined, new LinkRequestTimeoutError());
    }, LINK_REQUEST_TIMEOUT_MS);
    const send = () => deps.signaling().sendSignal(peerId, { linkRequest: true, link: true });
    const retry = setInterval(send, LINK_REQUEST_RETRY_MS);
    requested = { peerId, promise, resolve, reject, timer, retry };
    send();
    return promise;
  }

  /**
   * Tear the whole link down.
   *
   * `announce` is reserved for an explicit user disconnect. An idle close, a
   * room reset, a peer that left the roster and page teardown all stay silent:
   * none of them is the user saying "I am done with this peer", and an idle drop
   * is not held by the peer anyway.
   */
  function closeManager(announce = false) {
    if (announce && current) announceLeave(current);
    linkToken++;
    replaceToken++;
    failRecovery(new Error("relayium: link closed"));
    const link = current;
    const pending = opening;
    const pendingReplace = replacing;
    opening = null;
    replacing = null;
    if (requested) finishRequest(requested.peerId, undefined, new Error("relayium: link closed"));
    timedOutPeers.clear();
    publish(null, "idle");
    pending?.controller.abort();
    // A rebuild in flight is cancelled the same way, and its already-bumped
    // token also makes a transport that resolves anyway close itself.
    pendingReplace?.controller.abort();
    try { link?.conn.close(); } catch { /* already gone */ }
  }

  return {
    get current() { return current; },
    get status() { return status; },

    listen() {
      unlisten?.();
      unlisten = deps.signaling().onSignal((from, data) => {
        const msg = data as InboundSignal;
        if (msg.link === true && msg.busy === true) {
          finishRequest(from, undefined, new LinkBusyError());
          return;
        }
        // An authenticated departure. Checked by exact shape first, so a message
        // that merely claims to be one cannot also smuggle SDP, ICE, a commit or
        // a caps list past the handlers that share this generation.
        if (isLinkLeave(data)) {
          void handleLeave(from, data);
          return;
        }
        // A rebuild offer for an interrupted link. Deliberately first: it shares
        // the `resume` generation with a legacy one-shot file resume, and the
        // only thing that separates the two is the tag each verifies under. An
        // offer that is not for this link's peer, not for an interrupted link,
        // or not signed by this link's keys is dropped without a reply.
        if (signalGeneration(msg) === "resume" && msg.sdp?.type === "offer") {
          void handleResumeOffer(from, msg);
          return;
        }
        if (isLinkRequest(data)) {
          if (!supports(from) || linkRole(deps.selfId(), from) !== "initiator") return;
          if (deps.canAcceptLink && !deps.canAcceptLink(from)) {
            deps.signaling().sendSignal(from, { busy: true, link: true });
            return;
          }
          if (current) {
            deps.signaling().sendSignal(from, { busy: true, link: true });
            return;
          }
          if ((opening && opening.peerId !== from) || (requested && requested.peerId !== from)) {
            deps.signaling().sendSignal(from, { busy: true, link: true });
            return;
          }
          void establish(from, "initiator").catch(() => {});
          return;
        }
        if (!isLinkOffer(data)) return;
        if (!supports(from) || linkRole(deps.selfId(), from) !== "responder") return;
        if (timedOutPeers.delete(from)) {
          // Consume one late offer from the timed-out attempt and tell its
          // sender explicitly to retry, instead of black-holing this peer for
          // the remainder of the page session.
          deps.signaling().sendSignal(from, { busy: true, link: true });
          return;
        }
        if (deps.canAcceptLink && !deps.canAcceptLink(from)) {
          deps.signaling().sendSignal(from, { busy: true, link: true });
          if (requested?.peerId === from) finishRequest(from, undefined, new LinkBusyError());
          return;
        }
        if (current) {
          deps.signaling().sendSignal(from, { busy: true, link: true });
          return;
        }
        if ((opening && opening.peerId !== from) || (requested && requested.peerId !== from)) {
          deps.signaling().sendSignal(from, { busy: true, link: true });
          return;
        }
        void establish(from, "responder", msg).catch(() => {});
      });
    },

    ensure(peerId: string): Promise<MixedPeerLink> {
      // An established link with a LIVE transport is its own answer, and it is
      // handed back before the capability gate is consulted at all.
      //
      // The gate is about links that do not exist yet. This one exists: it was
      // built with a two-channel offer this peer answered, authenticated by
      // commit-reveal, and its SAS compared. The announcement the gate reads
      // arrives over signalling and is pruned with the roster (peer-caps'
      // `retainPeers`), so a peer whose WebSocket dropped while its DataChannel
      // stayed up would make this reject the very link it is holding — and with
      // it every lane intent raised on a connection that is working perfectly.
      //
      // Scoped to `open` and to a link with no gap under it, deliberately.
      // Getting a HELD link back means a rebuild, addressed through the same
      // signalling layer whose answer just changed, so that stays behind the
      // gate below with every other new connection attempt.
      if (current && current.peerId === peerId && status === "open" && !recovering) {
        return Promise.resolve(current);
      }
      if (!supports(peerId)) return Promise.reject(new UnsupportedLinkError());
      if (current) {
        if (current.peerId !== peerId) return Promise.reject(new LinkBusyError());
        // Mid-gap intent joins the rebuild instead of attaching to the dead
        // transport the held link still points at.
        if (recovering && recovering.peerId === peerId) return recovering.promise;
        return Promise.resolve(current);
      }
      if (opening) return opening.peerId === peerId
        ? opening.promise
        : Promise.reject(new LinkBusyError());
      if (requested) return requested.peerId === peerId
        ? requested.promise
        : Promise.reject(new LinkBusyError());
      return linkRole(deps.selfId(), peerId) === "initiator"
        ? establish(peerId, "initiator")
        : request(peerId);
    },

    /** The peer this side has asked to connect and is now waiting on, or "".
     *  Deliberately NOT the peer of an in-flight `establish`: a responder starts
     *  establishing the instant the request signal arrives, which can be ahead
     *  of the debounced roster that first names its sender. This one is only
     *  ever set from our own `ensure` for a peer we already had in a roster, so
     *  a later roster without it is genuinely "that page is gone". */
    get requestedPeerId() { return requested?.peerId ?? ""; },

    /** The peer id this manager is currently bound to in any lifecycle phase.
     *  A server-confirmed physical departure uses this broader view to cancel
     *  an in-flight establishment as well as a requested or established link. */
    get boundPeerId() {
      return current?.peerId ?? opening?.peerId ?? requested?.peerId
        ?? recovering?.peerId ?? replacing?.peerId ?? "";
    },

    /** True while a transport rebuild for the current link is in flight. */
    get replacingTransport() { return replacing !== null; },

    replaceTransport,

    /** Answer a terminal `failed` status, and nothing else.
     *
     *  `failed` is the only status this manager can be left sitting in with
     *  nothing under it, and the workspace holds the screen on it so the failure
     *  can be read. Reading it is what this call ends. It closes no transport,
     *  aborts no attempt and touches no lane — the alternative, routing the
     *  dismissal through `close`, would also drop file intent the user still
     *  expects to be owed.
     *
     *  Refuses while ANY phase is live, so a dismissal can never hide a real
     *  state: a status of `failed` alongside a live `opening` or `recovering` is
     *  a transient this must not paper over. */
    clearFailed() {
      if (status !== "failed") return false;
      if (current || opening || replacing || requested || recovering) return false;
      status = "idle";
      return true;
    },

    /** `announce` sends the authenticated leave signal first. Explicit user
     *  disconnect only — see closeManager. */
    close(options?: { announce?: boolean }) { closeManager(options?.announce === true); },

    stop() {
      unlisten?.();
      unlisten = null;
      closeManager();
    },
  };
}

export type PeerLinkManager = ReturnType<typeof createPeerLinkManager>;
