// Product-level owner for one authenticated mixed peer link.
//
// The coordinator deliberately contains no file/text protocol logic. It makes
// the ownership boundary explicit: one manager creates the transport and its
// link-scoped codecs, then both independent lane state machines attach to that
// exact object before establishment is published to callers.

import {
  createMixedFileSession,
  type MixedFileSession,
  type MixedFileSessionDeps,
} from "./mixed-file-session.svelte";
import {
  createMixedTextSession,
  type MixedTextSession,
} from "./mixed-text-session.svelte";
import {
  createPeerLinkManager,
  type MixedPeerLink,
  type CapturedLinkFrames,
  type PeerLinkDeps,
  type PeerLinkManager,
  type PeerLinkStatus,
} from "./peer-link.svelte";
import { peerSupportsLink } from "./peer-caps.svelte";
import type { SignalingClient } from "./signaling";
import type { ConnPath, RtcConfig } from "./webrtc";

export const MIXED_LINK_IDLE_MS = 10 * 60_000;

export interface MixedSessionDeps {
  selfId(): string;
  signaling(): SignalingClient;
  rtcConfig(): RtcConfig;
  supportsLink?(peerId: string): boolean;
  /** Resource admission only; content consent remains lane-local. */
  canAcceptLink?(peerId: string): boolean;
  connect?: PeerLinkDeps["connect"];
  resume?: PeerLinkDeps["resume"];
  pickSaveTarget?: MixedFileSessionDeps["pickSaveTarget"];
  requestNotify?: MixedFileSessionDeps["requestNotify"];
  now?: () => number;
  idleMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onLinkState?(link: MixedPeerLink | null, status: PeerLinkStatus): void;
}

export interface MixedSession {
  readonly manager: PeerLinkManager;
  readonly file: MixedFileSession;
  readonly text: MixedTextSession;
  readonly link: MixedPeerLink | null;
  readonly status: PeerLinkStatus;
  /** Bumped when the authenticated link changes — establishment and teardown,
   *  but not an authenticated transport replacement that preserves its keys,
   *  codecs and SAS. Consumers use it to separate authentication steps. */
  readonly linkGeneration: number;
  readonly peerId: string;
  readonly sasCode: string;
  readonly path: ConnPath | null;
  supports(peerId: string): boolean;
  ensure(peerId: string): Promise<MixedPeerLink>;
  active(): boolean;
  start(): void;
  /** `announce` tells the peer this is a deliberate departure, so it can stop
   *  holding the link instead of waiting out the recovery window. Reserved for
   *  the user's own disconnect action: a room reset, a peer that left the roster
   *  and page teardown are not that. */
  disconnect(options?: { announce?: boolean }): void;
  stop(): void;
}

export function createMixedSession(deps: MixedSessionDeps): MixedSession {
  const supports = deps.supportsLink ?? peerSupportsLink;
  const now = deps.now ?? Date.now;
  const idleMs = deps.idleMs ?? MIXED_LINK_IDLE_MS;
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;

  let manager!: PeerLinkManager;
  let file!: MixedFileSession;
  let text!: MixedTextSession;
  let path = $state<ConnPath | null>(null);
  // Distinct from pathGeneration: that one is an internal guard against a stale
  // path sample, this one is the link identity consumers observe.
  let linkGeneration = $state(0);
  let publishedLink: MixedPeerLink | null = null;
  let pathGeneration = 0;
  let lastActivity = now();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pathTimer: ReturnType<typeof setTimeout> | undefined;
  let listening = false;

  function clearIdle() {
    if (idleTimer !== undefined) clearTimer(idleTimer);
    idleTimer = undefined;
  }

  function clearPathTimer() {
    if (pathTimer !== undefined) clearTimer(pathTimer);
    pathTimer = undefined;
  }

  function armIdle() {
    clearIdle();
    if (!manager?.current) return;
    // A held link has no transport under it, so an idle close would race the
    // bounded recovery window for the same link — and win, silently.
    const activeLane = file.active() || text.active() || manager.status === "interrupted";
    const remaining = Math.max(0, lastActivity + idleMs - now());
    // Pending consent and active work are leases in their own right. Recheck on
    // a bounded cadence; never close in the middle of either lane's state machine.
    const delay = activeLane ? idleMs : remaining;
    idleTimer = setTimer(onIdleTimer, delay);
  }

  function touch() {
    lastActivity = now();
  }

  function onIdleTimer() {
    idleTimer = undefined;
    if (!manager.current) return;
    if (manager.status === "interrupted" || file.active() || text.active()) {
      lastActivity = now();
      armIdle();
      return;
    }
    if (now() - lastActivity < idleMs) {
      armIdle();
      return;
    }
    close(false);
  }

  function observePath(link: MixedPeerLink) {
    const mine = ++pathGeneration;
    clearPathTimer();
    path = null;
    let attempt = 0;
    const sample = async () => {
      if (mine !== pathGeneration || manager.current !== link) return;
      try {
        const next = await link.conn.path();
        if (mine !== pathGeneration || manager.current !== link) return;
        if (next !== "unknown") {
          path = next;
          return;
        }
      } catch {
        return;
      }
      attempt++;
      if (attempt >= 8) {
        path = "unknown";
        return;
      }
      pathTimer = setTimer(() => {
        pathTimer = undefined;
        void sample();
      }, 400);
    };
    void sample();
  }

  function onLinkChange(link: MixedPeerLink | null, _status: PeerLinkStatus, captured?: CapturedLinkFrames) {
    const transportReplacement = !!link && !!publishedLink
      && link.peerId === publishedLink.peerId
      && link.keys === publishedLink.keys
      && link.fileSender === publishedLink.fileSender
      && link.fileReceiver === publishedLink.fileReceiver
      && link.textSender === publishedLink.textSender
      && link.textReceiver === publishedLink.textReceiver;
    // A rebuilt transport is still the same authentication step. Incrementing
    // here would make the live-region announcer read an unchanged SAS again on
    // the next lane edge. Teardown and a later establishment both advance, so
    // two genuinely different links cannot share an identity even if their six
    // displayed digits collide.
    if (!transportReplacement) linkGeneration++;
    publishedLink = link;
    pathGeneration++;
    if (!link) {
      clearIdle();
      clearPathTimer();
      path = null;
      // Detach handlers before the old transport can deliver anything else.
      file.detach();
      text.detach();
      deps.onLinkState?.(null, _status);
      return;
    }
    // This callback runs synchronously inside manager establishment, before the
    // ensure promise resolves or an inbound request is replayed by either peer.
    // An authenticated transport replacement arrives the same way: a link object
    // carrying the same keys, SAS and codecs but new channels, published before
    // the old transport is closed. Both lanes therefore re-attach — retiring
    // whatever the retired transport was carrying — before any captured frame
    // from the new one replays.
    file.attach(link);
    text.attach(link);
    if (!link.fileChannel.onmessage || !link.textChannel.onmessage) {
      throw new Error("relayium: mixed lane attachment failed");
    }
    // Each SCTP stream is ordered independently. Preserve FIFO within each lane;
    // there is intentionally no cross-lane ordering contract.
    for (const frame of captured?.file ?? []) {
      link.fileChannel.onmessage?.({ data: frame } as MessageEvent);
    }
    for (const frame of captured?.text ?? []) {
      link.textChannel.onmessage?.({ data: frame } as MessageEvent);
    }
    lastActivity = now();
    observePath(link);
    armIdle();
    deps.onLinkState?.(link, _status);
  }

  /**
   * The link-level recovery policy: hold a dropped link only when a lane had
   * work worth reconnecting for.
   *
   * Both lanes are suspended FIRST, unconditionally and idempotently, and only
   * then asked whether they need recovery. That order is what makes this
   * independent of browser callback ordering: `RTCDataChannel.onclose` may run a
   * lane's own suspend before the PeerConnection reaches a terminal state, and
   * after that a pre-consent file or text state may already read terminal through
   * public `active()`. Each lane therefore records its own intent at the gap —
   * whichever call gets there first — and this reads that recorded answer.
   *
   * An idle drop is deliberately NOT held: reconnecting one would silently keep
   * a verification decision alive across a connection the user never saw
   * re-established. It tears down exactly as before, and the next intent builds
   * a fresh link with a fresh SAS.
   */
  function onTransportLost(): boolean {
    file.suspend();
    text.suspend();
    // `path` is deliberately left as observed and `linkGeneration` is NOT bumped
    // while held: this is the same authentication step on a new transport, not a
    // new one, so the SAS must not be announced again.
    return file.needsRecovery() || text.needsRecovery();
  }

  const ensureLink = (peerId: string) => manager.ensure(peerId);
  file = createMixedFileSession({
    ensureLink,
    pickSaveTarget: deps.pickSaveTarget,
    requestNotify: deps.requestNotify,
    now,
    onActivity: touch,
  });
  text = createMixedTextSession({ ensureLink, now, onActivity: touch });
  manager = createPeerLinkManager({
    selfId: deps.selfId,
    signaling: deps.signaling,
    rtcConfig: deps.rtcConfig,
    supportsLink: supports,
    canAcceptLink: deps.canAcceptLink,
    connect: deps.connect,
    resume: deps.resume,
    onLinkChange,
    onTransportLost,
  });

  function close(clearFileState: boolean, announce = false) {
    clearIdle();
    clearPathTimer();
    // Remove lane handlers first, so closing the shared Conn is not mistaken for
    // a lane-specific protocol failure. Explicit disconnect also drops queued
    // file intent; an automatic idle close can only run while the queue is empty.
    if (clearFileState) file.reset();
    else file.detach();
    text.detach();
    // Synchronous end to end. The leave signal is signed and sent inside this
    // call but never awaited, so the user's disconnect cannot be delayed — or
    // held open — by Web Crypto or by the signalling socket.
    manager.close({ announce });
    pathGeneration++;
    path = null;
  }

  return {
    get manager() { return manager; },
    get file() { return file; },
    get text() { return text; },
    get link() { return manager.current; },
    get status() { return manager.status; },
    get linkGeneration() { return linkGeneration; },
    get peerId() { return manager.current?.peerId || text.peerId || file.send?.peer || ""; },
    get sasCode() { return manager.current?.sas ?? ""; },
    get path() { return path; },
    supports,
    ensure(peerId) {
      lastActivity = now();
      return manager.ensure(peerId);
    },
    active() {
      return manager.status === "requesting" || manager.status === "connecting"
        || manager.status === "open" || manager.status === "interrupted"
        || file.active() || text.active();
    },
    start() {
      if (listening) return;
      listening = true;
      manager.listen();
    },
    disconnect(options) { close(true, options?.announce === true); },
    stop() {
      listening = false;
      clearIdle();
      clearPathTimer();
      file.reset();
      text.detach();
      manager.stop();
      pathGeneration++;
      path = null;
    },
  };
}
