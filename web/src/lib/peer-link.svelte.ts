// One authenticated Web link to one peer. This layer owns transport trust and
// the four nonce-bearing codecs; file/text product state machines consume it but
// must never construct replacement codecs while the link is alive.

import { deriveSession, generateKeyPair, sas, type SessionKeys } from "./crypto";
import { peerSupportsLink } from "./peer-caps.svelte";
import { Receiver, Sender } from "./transfer";
import { TextReceiver, TextSender } from "./text-wire";
import { connectLink, PeerBusyError, type Conn, type InboundSignal, type RtcConfig } from "./webrtc";
import type { SignalingClient } from "./signaling";

export const LINK_REQUEST_TIMEOUT_MS = 30_000;
export const LINK_REQUEST_RETRY_MS = 3_000;
export const LINK_AUTH_TIMEOUT_MS = 30_000;

export type PeerLinkStatus = "idle" | "requesting" | "connecting" | "open" | "failed";

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
}

export function isLinkOffer(data: unknown): data is InboundSignal {
  if (!data || typeof data !== "object") return false;
  const d = data as InboundSignal;
  return d.link === true && !d.resume && d.sdp?.type === "offer";
}

export function isLinkRequest(data: unknown): data is InboundSignal {
  return !!data && typeof data === "object"
    && (data as InboundSignal).linkRequest === true
    && !(data as InboundSignal).sdp;
}

/** Both peers compute the same transport role without creating competing SDP. */
export function linkRole(selfId: string, peerId: string): "initiator" | "responder" {
  return selfId < peerId ? "initiator" : "responder";
}

export function createPeerLinkManager(deps: PeerLinkDeps) {
  const supports = deps.supportsLink ?? peerSupportsLink;
  const openTransport = deps.connect ?? connectLink;
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
      const peerKey = new Promise<Uint8Array>((resolve) => (resolvePeer = resolve));
      let transportTerminal = false;
      conn = await openTransport({
        signaling: deps.signaling(), peerId, selfKey: self.publicKey, role,
        config: deps.rtcConfig(), initialSignal,
        signal: controller.signal,
        onPeerKey: resolvePeer,
        onStateChange: (next) => {
          if (next !== "failed" && next !== "closed") return;
          transportTerminal = true;
          if (conn && current?.peerId === peerId && current.conn === conn) {
            current = null;
            status = next === "failed" ? "failed" : "idle";
            try { conn.close(); } catch { /* terminal already */ }
          }
        },
      });
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
      const fileChannel = conn.getChannel("relayium");
      const textChannel = conn.getChannel("relayium-text");
      if (!fileChannel || !textChannel || transportTerminal || mine !== token) {
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
      current = link;
      status = "open";
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
    const send = () => deps.signaling().sendSignal(peerId, { linkRequest: true });
    const retry = setInterval(send, LINK_REQUEST_RETRY_MS);
    requested = { peerId, promise, resolve, reject, timer, retry };
    send();
    return promise;
  }

  function closeManager() {
    token++;
    const link = current;
    const pending = opening;
    current = null;
    opening = null;
    if (requested) finishRequest(requested.peerId, undefined, new Error("relayium: link closed"));
    status = "idle";
    pending?.controller.abort();
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

    close: closeManager,

    stop() {
      unlisten?.();
      unlisten = null;
      closeManager();
    },
  };
}

export type PeerLinkManager = ReturnType<typeof createPeerLinkManager>;
