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
import { recoveryBlock, recoveryWindowMs, type RecoveryBlock } from "./link-recovery";
import type { RelayDeadline } from "./relay-deadline";
import type { SignalingClient } from "./signaling";
import type { ConnPath, RtcConfig } from "./webrtc";

/**
 * How long a link with no lane activity survives.
 *
 * Unchanged, and deliberately so: it is the quota and mobile-background bound,
 * and it is the ONLY bound a LAN link has. The relay credential deadline below
 * is a second, independent bound that applies to relayed links only — neither
 * replaces the other, and the earlier of the two wins.
 */
export const MIXED_LINK_IDLE_MS = 10 * 60_000;

/** Why a link ended in a way the user has to act on. "" while nothing has.
 *  Distinct from `status === "failed"`, which says a connection attempt failed
 *  and says nothing about what to do next. */
export type LinkEndReason = "" | "relayExpired" | "signalingLost";

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
  /** Pre-upload key handoff, forwarded verbatim to the file lane that owns the
   *  channel the frame travels on. See MixedFileSessionDeps. */
  storedKeysToSend?: MixedFileSessionDeps["storedKeysToSend"];
  onStoredKeys?: MixedFileSessionDeps["onStoredKeys"];
  supportsPreupload?: MixedFileSessionDeps["supportsPreupload"];
  /** Whether the signalling socket currently holds a room membership. Defaults
   *  to "yes" so every existing caller and test is unaffected. */
  joined?(): boolean;
  /** Whether the room refused or expired this page's rejoin. */
  rejoinRefused?(): boolean;
  /** Whether a peer id is still in the room, as the SERVER reports it. Defaults
   *  to "yes" so every existing caller and test is unaffected. Read only about
   *  the peer the current link points at, and only to answer "could this link be
   *  rebuilt" — never to decide whether it is alive. */
  peerPresent?(peerId: string): boolean;
  /** The relayed-link credential boundary derived from the room's ICE config,
   *  or null when nothing in it relays (LAN, or a code room the server issued no
   *  TURN username for). Read when a link opens, not cached across rooms. */
  relayDeadline?(): RelayDeadline | null;
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
  /** True once a relayed link has passed its warning boundary and before its
   *  credential deadline. False for LAN/P2P and for a link with no deadline. */
  readonly relayExpiring: boolean;
  /** Whether a transport loss right now could be recovered from. False marks a
   *  link that is still perfectly healthy but would be unrecoverable if it
   *  dropped — losing signalling does exactly that, and must do nothing else. */
  readonly recoveryAvailable: boolean;
  /** Why the last link ended, when the answer is one the user must act on.
   *  Survives the teardown on purpose: the workspace has to be able to say
   *  "start again" instead of silently vanishing. */
  readonly endReason: LinkEndReason;
  supports(peerId: string): boolean;
  ensure(peerId: string): Promise<MixedPeerLink>;
  active(): boolean;
  start(): void;
  /** `announce` tells the peer this is a deliberate departure, so it can stop
   *  holding the link instead of waiting out the recovery window. Reserved for
   *  the user's own disconnect action: a room reset, a peer that left the roster
   *  and page teardown are not that. */
  disconnect(options?: { announce?: boolean }): void;
  /**
   * A peer left the room's roster, with no `left` frame behind it.
   *
   * Weaker evidence than `peerDeparted` below and reaches strictly less: only
   * the relay-gate phases, which hold no transport at all. See
   * `PeerLinkManager.rosterPeerGone`.
   */
  rosterPeerGone(peerId: string): void;
  /**
   * The server confirmed this peer's signalling socket is gone.
   *
   * Returns true when the CURRENT link absorbed that fact and the caller must
   * not tear anything down, false when this session holds nothing for that peer
   * and the caller is free to cancel whatever it does hold.
   *
   * The rule it encodes is the correlated-loss invariant read from the far side:
   * the peer losing its socket is not the peer losing its DataChannel, so a
   * healthy transport is kept exactly as it is and only becomes UNRECOVERABLE.
   * A link that has already lost its transport is the opposite case — the
   * rebuild it is waiting for is addressed to an id that is not in the room —
   * so it ends now, and says why.
   */
  peerDeparted(peerId: string): boolean;
  /** Clear `endReason` after the user has read it. Tears nothing down. */
  dismissEnded(): void;
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
  /** The signalling identity the CURRENT link was established under. A rejoin
   *  that returns a different one is a different membership; the peer id this
   *  link points at belongs to the old one and is not addressable any more. */
  let establishedSelfId = "";
  /** The credential boundary this link is actually bounded by, or null. Sampled
   *  once per link from the room's config, never re-derived: re-deriving it
   *  against a clock that has since been stepped would move the boundary under
   *  a live link. */
  let deadline: RelayDeadline | null = null;
  let warnTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let relayExpiring = $state(false);
  let endReason = $state<LinkEndReason>("");

  function clearIdle() {
    if (idleTimer !== undefined) clearTimer(idleTimer);
    idleTimer = undefined;
  }

  function clearPathTimer() {
    if (pathTimer !== undefined) clearTimer(pathTimer);
    pathTimer = undefined;
  }

  function clearDeadlineTimers() {
    if (warnTimer !== undefined) clearTimer(warnTimer);
    if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
    warnTimer = undefined;
    deadlineTimer = undefined;
  }

  /**
   * Arm (or disarm) the credential boundary for the current link.
   *
   * Armed the moment a link opens whenever the room's ICE config states a TURN
   * expiry, and disarmed only once the path is CLASSIFIED as direct. That order
   * is deliberate: path classification is asynchronous and can take seconds, and
   * an unbounded window at the start of a relayed link is exactly the hole this
   * closes. A LAN room has no TURN credential at all, so nothing is ever armed
   * there and its 90-second recovery policy is untouched.
   *
   * Both timers fire on their own. That is the requirement: a relayed link must
   * reach a truthful terminal state at the deadline even when no transport event
   * ever arrives — a dead TURN allocation is silent, and `connectionState` on a
   * PeerConnection whose relay stopped answering can stay `connected` for a long
   * time.
   */
  function armDeadline() {
    clearDeadlineTimers();
    if (!manager?.current) {
      deadline = null;
      relayExpiring = false;
      return;
    }
    if (path === "lan" || path === "p2p") {
      deadline = null;
      relayExpiring = false;
      return;
    }
    deadline = deps.relayDeadline?.() ?? null;
    if (!deadline) {
      relayExpiring = false;
      return;
    }
    const at = now();
    relayExpiring = at >= deadline.warnAt;
    if (!relayExpiring) warnTimer = setTimer(onWarnTimer, deadline.warnAt - at);
    deadlineTimer = setTimer(onDeadlineTimer, Math.max(0, deadline.deadlineAt - at));
  }

  function onWarnTimer() {
    warnTimer = undefined;
    if (!manager.current || !deadline) return;
    relayExpiring = true;
  }

  function onDeadlineTimer() {
    deadlineTimer = undefined;
    if (!manager.current) return;
    // Set BEFORE the teardown: `close` publishes null synchronously, and the
    // teardown path clears everything else about this link.
    endReason = "relayExpired";
    // Not the explicit-disconnect teardown: queued batches and lane state stay as
    // they are, so the screen still shows what was in flight next to the reason
    // it stopped. Nothing is announced to the peer — its own credential is
    // expiring on the same schedule.
    close(false);
  }

  /** The live answer to "could this link be rebuilt if it dropped right now?" */
  function currentRecoveryBlock(): RecoveryBlock {
    const peerId = manager?.current?.peerId ?? "";
    return recoveryBlock({
      joined: deps.joined?.() ?? true,
      selfId: deps.selfId(),
      establishedSelfId,
      rejoinRefused: deps.rejoinRefused?.() ?? false,
      peerPresent: peerId === "" || (deps.peerPresent?.(peerId) ?? true),
      credentialDeadlineAt: deadline?.deadlineAt ?? null,
      now: now(),
    });
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
          // A classified DIRECT path is the only thing that releases a link from
          // its credential boundary; "unknown" never does.
          armDeadline();
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
    // A NEW authentication step clears the previous link's terminal reason: the
    // user acted, and the card explaining the old link must not survive next to
    // a live one. A transport replacement is the same step and clears nothing.
    const wasDeadline = deadline;
    const transportReplacement = !!link && !!publishedLink
      && link.peerId === publishedLink.peerId
      && link.keys === publishedLink.keys
      && link.fileSender === publishedLink.fileSender
      && link.fileReceiver === publishedLink.fileReceiver
      && link.textSender === publishedLink.textSender
      && link.textReceiver === publishedLink.textReceiver
      && link.storedKeysSender === publishedLink.storedKeysSender
      && link.storedKeysReceiver === publishedLink.storedKeysReceiver;
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
      clearDeadlineTimers();
      // The bounded recovery window is itself clipped to the credential, so a
      // relayed link that ran its window out ended AT the boundary and has to say
      // so. Without this the clamped window would report the generic "connection
      // failed", which sends the user to retry something that cannot succeed.
      if (_status === "failed" && wasDeadline && now() >= wasDeadline.deadlineAt && !endReason) {
        endReason = "relayExpired";
      }
      deadline = null;
      relayExpiring = false;
      establishedSelfId = "";
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
    if (!transportReplacement) {
      endReason = "";
      establishedSelfId = deps.selfId();
    }
    observePath(link);
    armIdle();
    // After observePath, which resets `path` to null — arming reads it.
    armDeadline();
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
    if (!(file.needsRecovery() || text.needsRecovery())) return false;
    // A lane wants the link back. Whether it can HAVE it back is a separate
    // question, and answering it here is what keeps `interrupted` honest: a held
    // link with no way to rebuild would sit "Connecting…" for its whole window
    // and then report a generic failure.
    const block = currentRecoveryBlock();
    if (!block) return true;
    endReason = block === "credential" ? "relayExpired" : "signalingLost";
    return false;
  }

  const ensureLink = (peerId: string) => manager.ensure(peerId);
  file = createMixedFileSession({
    ensureLink,
    pickSaveTarget: deps.pickSaveTarget,
    requestNotify: deps.requestNotify,
    storedKeysToSend: deps.storedKeysToSend,
    onStoredKeys: deps.onStoredKeys,
    supportsPreupload: deps.supportsPreupload,
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
    recoveryWindowMs: () => recoveryWindowMs(deadline?.deadlineAt ?? null, now()),
  });

  function close(clearFileState: boolean, announce = false) {
    clearIdle();
    clearPathTimer();
    clearDeadlineTimers();
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
    get relayExpiring() { return relayExpiring && !!manager.current; },
    get recoveryAvailable() {
      // Only a question about a link that exists. With none, "unavailable" would
      // put a warning on a screen with nothing to lose.
      if (!manager.current) return true;
      return currentRecoveryBlock() === "";
    },
    get endReason() { return endReason; },
    supports,
    ensure(peerId) {
      lastActivity = now();
      // The user is asking for a connection: whatever the last one ended of is
      // now history, and its card must not outlive the request that replaces it.
      endReason = "";
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
    rosterPeerGone(peerId) { manager.rosterPeerGone(peerId); },
    peerDeparted(peerId) {
      const link = manager.current;
      if (!link || link.peerId !== peerId) return false;
      // Held with no transport under it: the bounded driver is re-offering to a
      // peer that has left, and every remaining attempt is spend-for-nothing.
      // Set the reason BEFORE the teardown — `close` publishes null synchronously.
      if (manager.status === "interrupted") {
        endReason = "signalingLost";
        // Not the explicit-disconnect teardown, and nothing announced: queued
        // batches stay on screen next to the reason they stopped, and there is
        // no longer anybody on the other end of the signalling socket to tell.
        close(false);
        return true;
      }
      // Healthy transport. Untouched, deliberately: this is a signalling event
      // about a different transport. The only thing that changes is the answer
      // to "could it be rebuilt", which `peerPresent` now returns false for —
      // so a later transport death terminates immediately instead of spending a
      // recovery window it cannot win. See onTransportLost.
      return true;
    },
    /** Answer the terminal card and nothing else.
     *
     *  Deliberately NOT folded into `disconnect`: by the time a link has ended
     *  of an expired credential there is nothing left to disconnect, and the
     *  paths that DO call disconnect on a dead link (a peer leaving the roster,
     *  a room switch racing the same instant) would then erase the explanation
     *  before it was read. Clearing it is a decision, so it has its own call.
     *
     *  It answers BOTH terminal presentations. A plain failure carries no reason
     *  string at all — `endReason` names only the two endings that need naming —
     *  and the workspace now holds the screen on that too, so a dismissal that
     *  cleared the string alone would leave the card pinned and make the control
     *  look inert. `clearFailed` touches no transport and no lane, so a queued
     *  batch the user is still owed stays exactly where it was. */
    dismissEnded() {
      endReason = "";
      manager.clearFailed();
    },
    stop() {
      listening = false;
      clearIdle();
      clearPathTimer();
      clearDeadlineTimers();
      deadline = null;
      relayExpiring = false;
      endReason = "";
      establishedSelfId = "";
      file.reset();
      text.detach();
      manager.stop();
      pathGeneration++;
      path = null;
    },
  };
}
