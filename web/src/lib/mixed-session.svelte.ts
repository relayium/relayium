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
import { peerSupportsLink, peerSupportsRenew } from "./peer-caps.svelte";
import { recoveryBlock, recoveryWindowMs, type RecoveryBlock } from "./link-recovery";
import {
  createRelayRenewal,
  renewMarginMs,
  type RelayRenewal,
  type RenewState,
  type RenewedConfig,
} from "./relay-renew";
import type { IceGrant } from "./relay-renew-wire";
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

/**
 * How recently a person must actually have moved data for this link to renew.
 *
 * The same ten minutes as the idle bound, and deliberately the same number for
 * the same reason: renewal is only ever available to a link that would still be
 * alive under today's rules. What differs is WHAT refreshes it — see
 * `MixedFileSessionDeps.onUserActivity`. A link kept alive by protocol chatter
 * stays alive exactly as it does today and cannot renew a paid relay grant.
 */
export const RENEW_ACTIVITY_WINDOW_MS = 10 * 60_000;

/** How often the renewal trigger is re-evaluated once the link is inside its
 *  renewal window. The answer can change between ticks — a user starts typing,
 *  a transfer resumes — so it is a bounded poll rather than one shot. It stops
 *  when the link does. */
export const RENEW_TICK_MS = 5_000;

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
  /**
   * Ask the room's server for a renewal round (`relay-renew-v1.md` §2).
   *
   * Absent disables renewal entirely for this session — including the
   * capability gate below — so a consumer that has not wired the round exchange
   * never spends an epoch and never advertises something it cannot do.
   */
  requestRenewRound?(round: number, rid: number): Promise<IceGrant | null>;
  /** Turn a granted body into the configuration this link migrates onto and the
   *  boundary that configuration states. See `renewGrantConfig` in ice.ts. */
  renewedConfig?(grant: IceGrant): RenewedConfig | null;
  /** Whether the peer announced `relay-renew/1`. Defaults to the roster
   *  predicate; a test seam may replace it. */
  supportsRenew?(peerId: string): boolean;
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
  /** What the relay renewal is doing. Never `renewed` before a migration has
   *  actually committed — see `relay-renew-v1.md` §6.5. */
  readonly renewState: RenewState;
  /** The server round this link's credentials come from. 0 is the original
   *  grant; each committed renewal advances it. */
  readonly renewRound: number;
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
  /**
   * The boundary a COMMITTED renewal installed, or null.
   *
   * Takes precedence over the room's original `relayDeadline()` once it exists,
   * and is cleared with the authentication step rather than with the transport:
   * a rebuilt transport still runs on the credentials the renewal obtained, and
   * re-reading the room's original answer there would silently move the
   * boundary back to one that has already lapsed.
   */
  let renewedBound: RelayDeadline | null = null;
  let renewState = $state<RenewState>("idle");
  let renewTimer: ReturnType<typeof setTimeout> | undefined;
  /** The last STRICT user-lane activity — actual bytes, ACK progress, or a
   *  message somebody wrote. 0 means "never on this link". Deliberately not
   *  `lastActivity`, which any lane traffic refreshes. */
  let lastUserActivity = 0;
  let renewal!: RelayRenewal;

  /** The bound whose anchor `boundAnchorAt` describes. Identity, not value. */
  let anchoredBoundRef: RelayDeadline | null = null;
  /**
   * When the CURRENT boundary was installed, on this clock.
   *
   * The renewal margin is a fraction of the grant's LIFETIME, so it needs a
   * fixed anchor; measured from "now" it becomes a fraction of the shrinking
   * remainder and the trigger never fires (see `renewMarginMs`). Recorded here
   * because this is the one place that knows when a boundary became current —
   * a link opening, or a committed migration installing a new one.
   */
  let boundAnchorAt = 0;

  /** The boundary this link is actually bounded by right now. */
  function currentBound(): RelayDeadline | null {
    const bound = renewedBound ?? deps.relayDeadline?.() ?? null;
    if (bound !== anchoredBoundRef) {
      anchoredBoundRef = bound;
      boundAnchorAt = now();
    }
    return bound;
  }

  function clearRenewTimer() {
    if (renewTimer !== undefined) clearTimer(renewTimer);
    renewTimer = undefined;
  }

  /**
   * §7.1's consent gate, and the reason an idle link still dies on schedule.
   *
   * Reads the STRICT signal only. A renewal control frame cannot reach it at
   * all — the lane demux consumes those before the activity hooks run — and
   * neither can a lifecycle control, a resume request, a pre-upload handoff or
   * a pending-consent prompt.
   */
  function userActive(): boolean {
    if (lastUserActivity === 0) return false;
    return now() - lastUserActivity < RENEW_ACTIVITY_WINDOW_MS;
  }

  function touchUser() {
    lastUserActivity = now();
  }

  /**
   * Arm the renewal trigger for the current link.
   *
   * Nothing is armed for a LAN or classified-direct path, or for a link with no
   * boundary: there is no credential to renew, and asking the server would be a
   * backend call a local-only session must never make.
   *
   * Inside the window this becomes a bounded poll, because the trigger's answer
   * can change between ticks: a user who was idle at the margin and starts
   * typing two minutes later should still renew. It stops when the link does.
   */
  function armRenewal() {
    clearRenewTimer();
    if (!manager?.current) return;
    if (path === "lan" || path === "p2p") return;
    const bound = currentBound();
    if (!bound) return;
    const at = now();
    // The same anchor the controller's own predicate uses, so the timer and the
    // decision it wakes cannot disagree about when the window opens.
    const start = bound.deadlineAt - renewMarginMs(bound.deadlineAt, boundAnchorAt);
    renewTimer = setTimer(onRenewTick, start > at ? start - at : RENEW_TICK_MS);
  }

  function onRenewTick() {
    renewTimer = undefined;
    if (!manager.current) return;
    renewal.tick();
    armRenewal();
  }

  /**
   * A migration committed (§6.5). This is the ONLY path that moves a deadline.
   *
   * The order matters and mirrors `onLinkChange`'s: install the new boundary,
   * re-run path classification (the migration may have landed on a direct path,
   * which the existing rule releases the boundary for), then re-arm. `armDeadline`
   * reads `path`, which `observePath` has just reset to null, so the link stays
   * bounded until the new path is classified rather than briefly unbounded.
   */
  function onRenewCommit(next: RelayDeadline) {
    const live = manager.current;
    if (!live) return;
    renewedBound = next;
    observePath(live);
    armDeadline();
    armRenewal();
  }

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
    deadline = currentBound();
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
          // …and a link with no boundary has nothing to renew, so the trigger
          // is re-evaluated against the same answer rather than left armed for
          // a credential that no longer bounds anything.
          armRenewal();
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
      clearRenewTimer();
      renewal.setLink(null);
      renewedBound = null;
      anchoredBoundRef = null;
      boundAnchorAt = 0;
      lastUserActivity = 0;
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
      // A NEW authentication step. Everything the renewal earned belonged to
      // the previous link: its round, its epochs and above all the boundary it
      // installed, which says nothing about credentials this link was issued.
      renewedBound = null;
      anchoredBoundRef = null;
      boundAnchorAt = 0;
      lastUserActivity = 0;
    }
    // Told about the replacement too: the controller aborts any epoch in flight
    // (a new PeerConnection means a new baseline, and the restart it was in the
    // middle of belonged to a transport that no longer exists) while keeping
    // the link-scoped epoch counter and round, so an aborted epoch's signed
    // messages can never be replayed into a later attempt.
    renewal.setLink(link);
    observePath(link);
    armIdle();
    // After observePath, which resets `path` to null — arming reads it.
    armDeadline();
    armRenewal();
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
  const requestRenewRound = deps.requestRenewRound;
  const renewedConfig = deps.renewedConfig;
  /**
   * Renewal is available only when this consumer wired BOTH halves of the
   * server exchange.
   *
   * Otherwise the capability gate answers "no" for every peer, `due()` never
   * fires, no epoch is ever spent — and, because the same predicate is what a
   * future announcement would be gated on, nothing is advertised that this
   * session could not honour.
   */
  const renewAvailable = !!requestRenewRound && !!renewedConfig;
  const supportsRenewPeer = deps.supportsRenew ?? peerSupportsRenew;
  renewal = createRelayRenewal({
    selfId: deps.selfId,
    now,
    setTimer,
    clearTimer,
    sendSignal: (peerId, envelope) => deps.signaling().sendSignal(peerId, envelope),
    requestRound: (round, rid) => requestRenewRound?.(round, rid) ?? Promise.resolve(null),
    renewedConfig: (grant) => renewedConfig?.(grant) ?? null,
    peerSupportsRenew: (peerId) => renewAvailable && supportsRenewPeer(peerId),
    userActive,
    deadline: currentBound,
    // Read AFTER `deadline()`, which is what refreshes it. Both are called from
    // `due()` in that order.
    deadlineAnchor: () => boundAnchorAt,
    commit: onRenewCommit,
    onStateChange: (next) => { renewState = next; },
  });
  file = createMixedFileSession({
    ensureLink,
    pickSaveTarget: deps.pickSaveTarget,
    requestNotify: deps.requestNotify,
    storedKeysToSend: deps.storedKeysToSend,
    onStoredKeys: deps.onStoredKeys,
    supportsPreupload: deps.supportsPreupload,
    now,
    onActivity: touch,
    onUserActivity: touchUser,
  });
  text = createMixedTextSession({
    ensureLink,
    now,
    onActivity: touch,
    onUserActivity: touchUser,
    // The lane's front demux. A renewal control frame is consumed here, ahead
    // of the conversation's activity hook and its rate budget — which is what
    // makes "probes are never user activity" structural rather than a promise.
    consumeControl: (data) => renewal.frame(data),
  });
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
    onRenewSignal: (peerId, envelope) => renewal.signal(peerId, envelope),
  });

  function close(clearFileState: boolean, announce = false) {
    clearIdle();
    clearPathTimer();
    clearDeadlineTimers();
    clearRenewTimer();
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
    get renewState() { return renewState; },
    get renewRound() { return renewal.round; },
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
      clearRenewTimer();
      renewal.stop();
      renewedBound = null;
      anchoredBoundRef = null;
      boundAnchorAt = 0;
      lastUserActivity = 0;
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
