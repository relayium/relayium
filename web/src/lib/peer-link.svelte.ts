// One authenticated Web link to one peer. This layer owns transport trust and
// the four nonce-bearing codecs; file/text product state machines consume it but
// must never construct replacement codecs while the link is alive.

import { deriveSession, generateKeyPair, sas, signResume, verifyResume, type SessionKeys } from "./crypto";
import { peerSupportsLink } from "./peer-caps.svelte";
import { Receiver, Sender } from "./transfer";
import { TextReceiver, TextSender } from "./text-wire";
import {
  LINK_CAPTURE_MAX_BYTES,
  connectLink,
  connectResumeLink,
  PeerBusyError,
  type Conn,
  type InboundSignal,
  type RtcConfig,
  type SignalAuth,
} from "./webrtc";
import type { SignalingClient } from "./signaling";

export const LINK_REQUEST_TIMEOUT_MS = 30_000;
export const LINK_REQUEST_RETRY_MS = 3_000;
export const LINK_AUTH_TIMEOUT_MS = 30_000;

export type PeerLinkStatus = "idle" | "requesting" | "connecting" | "open" | "failed";

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
  const timedOutPeers = new Set<string>();
  let token = 0;
  let unlisten: (() => void) | null = null;

  function publish(
    next: MixedPeerLink | null,
    nextStatus: PeerLinkStatus,
    captured?: CapturedLinkFrames,
  ) {
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

    const mine = ++token;
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
          if (conn && current?.peerId === peerId && current.conn === conn) {
            publish(null, next === "failed" ? "failed" : "idle");
            try { conn.close(); } catch { /* terminal already */ }
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
      if (capture.overflow || transportTerminal || mine !== token) {
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
      };
      if (mine !== token) {
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
      if (mine === token) status = "failed";
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
   * The published replacement reuses the exact SessionKeys, SAS and all four
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

    const mine = ++token;
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
          if (!conn || current?.peerId !== peerId || current.conn !== conn) return;
          publish(null, next === "failed" ? "failed" : "idle");
          try { conn.close(); } catch { /* terminal already */ }
        },
      });
      const fileChannel = conn.getChannel("relayium");
      const textChannel = conn.getChannel("relayium-text");
      if (!fileChannel || !textChannel) throw new Error("relayium: incomplete mixed link");
      // Capture starts before anything can await again, so a peer that speaks
      // first on the rebuilt lanes cannot outrun lane attachment.
      const capture = beginCapture(conn, fileChannel, textChannel);
      if (controller.signal.aborted || mine !== token || current !== link) {
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

  function closeManager() {
    token++;
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
      if (!supports(peerId)) return Promise.reject(new UnsupportedLinkError());
      if (current) return current.peerId === peerId
        ? Promise.resolve(current)
        : Promise.reject(new LinkBusyError());
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

    /** True while a transport rebuild for the current link is in flight. */
    get replacingTransport() { return replacing !== null; },

    replaceTransport,

    close: closeManager,

    stop() {
      unlisten?.();
      unlisten = null;
      closeManager();
    },
  };
}

export type PeerLinkManager = ReturnType<typeof createPeerLinkManager>;
