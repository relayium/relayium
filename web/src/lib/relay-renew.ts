// The relay-renewal controller: one per authenticated link.
//
// Protocol: `docs/protocol/relay-renew-v1.md`. Wire: `relay-renew-wire.ts`.
// Transport surface: `RenewTransport` in `webrtc-core.ts`.
//
// ## The one rule this file exists to keep
//
// **A deadline moves only on §6.5 commit.** Every other outcome — a denial, a
// timeout, a failed pin, an unparseable grant, a peer that does not implement
// this, a server that does not answer — leaves the deadline the link already
// had exactly as it was, and the existing truthful warning and expiry take over
// on schedule. There is deliberately no code path from "something went wrong"
// to "keep the link alive a bit longer".
//
// ## Why the state machine is explicit rather than promise-chained
//
// An epoch has four phases, five deadlines, two peers that may both start it,
// and an abort that can arrive in any of them. A promise chain would make
// cancellation implicit and would make "which epoch is this callback for?" a
// question answered by closure capture. Here every inbound event re-reads the
// current attempt and compares its epoch, so a message belonging to an epoch
// that has ended is dropped by the same check that drops one that never
// existed.
//
// ## The three states, not two
//
// `attempt` is an epoch in flight. `committed` is the epoch that WON, retained
// for a bounded window afterwards. The second one is not bookkeeping: the two
// peers do not commit at the same instant, and a side that cleared everything
// the moment its own ack arrived would stop answering the peer's retransmitted
// probe — leaving that peer to time out and keep an expiring deadline while
// this side believed the migration was shared. See `Committed`.

import {
  CAP_RENEW,
  RENEW_EPOCH_HARD_CAP_MS,
  RENEW_ICE_PROBE_MS,
  RENEW_MAX_EPOCHS_PER_ROUND,
  RENEW_MAX_HELD_CANDIDATES,
  RENEW_MAX_PROBE_VERIFICATIONS,
  RENEW_NONCE_BYTES,
  RENEW_PREPARE_SILENCE_MS,
  RENEW_PREPARE_TO_READY_MS,
  RENEW_PROBE_MAX_SENDS,
  RENEW_PROBE_RETRY_MS,
  RENEW_PROBE_TYPE_ACK,
  RENEW_PROBE_TYPE_PROBE,
  RENEW_READY_TO_ANSWER_MS,
  decodeRenewProbe,
  encodeRenewProbe,
  inboundCandidateUfrag,
  isRenewControlFrame,
  renewProbePayload,
  renewSignalPayload,
  sdpPin,
  sdpPinMatches,
  signRenewProbe,
  toBase64,
  verifyRenew,
  verifyRenewProbe,
  type IceGrant,
  type RenewAbortReason,
  type RenewEnvelope,
  type RenewSignal,
} from "./relay-renew-wire";
import type { MixedPeerLink } from "./peer-link.svelte";
import type { RelayDeadline } from "./relay-deadline";
import type { RenewTransport, RtcConfig } from "./webrtc";

/**
 * How far ahead of the boundary a renewal is attempted.
 *
 * ## `anchoredAt` is the grant's arming instant, NEVER "now"
 *
 * The margin is a fraction of the grant's LIFETIME, so it must be measured from
 * a fixed anchor. Measured from the current time it becomes a fraction of the
 * REMAINING time — and `remaining <= remaining / 3` is false for every positive
 * remaining, so the trigger would stay false until the deadline itself had
 * passed, making renewal unreachable.
 *
 * Ten minutes on a normal one-hour grant. A third of the lifetime is the floor,
 * so a 60-second accelerated test credential is renewed at 40 s in — that is,
 * with 20 s of margin — rather than never, and without a negative delay.
 */
export function renewMarginMs(deadlineAt: number, anchoredAt: number): number {
  const lifetime = Math.max(0, deadlineAt - anchoredAt);
  return Math.min(10 * 60_000, Math.max(0, Math.floor(lifetime / 3)));
}

/**
 * How long a failed epoch waits before another is spent.
 *
 * Without it the trigger's own poll cadence would burn all three of a round's
 * epochs inside fifteen seconds — a peer that is briefly idle, or a server
 * still collecting the second request, would cost the link every attempt it
 * had before the renewal window had really begun. A minute spreads three
 * attempts across a ten-minute margin, which is what that margin is for.
 */
export const RENEW_RETRY_BACKOFF_MS = 60_000;

/**
 * How long a committed epoch keeps answering the peer's probes.
 *
 * Exactly the peer's own ICE+probe bound, and that is the derivation rather
 * than a round number: the peer cannot still be probing for this epoch after
 * its `RENEW_ICE_PROBE_MS` window closes, because its own timer aborts the
 * epoch there. So this is the longest window in which a retransmitted probe can
 * still be genuine, and one millisecond past it nothing legitimate remains to
 * answer.
 */
export const RENEW_POST_COMMIT_ACK_MS = RENEW_ICE_PROBE_MS;

/**
 * Attempts that may fail BEFORE a configuration is granted.
 *
 * Separate from the three-migration ceiling, because the two failures cost
 * different things: a migration attempt restarts ICE on a live transport,
 * while a pre-grant failure is a signalling round trip that changed nothing.
 * Spending the migration budget on three transient database refusals — which
 * is what a single shared counter did — abandoned renewal permanently while
 * most of the margin was still unspent.
 *
 * Six, spaced by `RENEW_RETRY_BACKOFF_MS`, is about five minutes of retrying;
 * the real bound is the old deadline, past which `due()` refuses outright.
 */
export const RENEW_MAX_PREGRANT_ATTEMPTS = 6;


/**
 * Inbound renewal signals that may be queued for verification at once.
 *
 * A legal exchange has at most a handful in flight — prepare, ready, one SDP
 * and its candidates — and candidates are the only thing that arrives in any
 * volume. Past this the queue is refused rather than grown: an unbounded one
 * turns a signalling flood into unbounded memory plus an unbounded backlog of
 * HMACs, which is the work the per-epoch budgets exist to cap.
 */
export const RENEW_MAX_PENDING_SIGNALS = 32;

/** What the UI may say about renewal. Never "renewed" before §6.5 commit. */
export type RenewState =
  | "idle"        // nothing in flight; the link's existing deadline stands
  | "renewing"    // an epoch is in flight
  | "renewed"     // a migration committed; the deadline moved
  | "denied"      // the server refused this round; the old deadline stands
  | "unsupported" // the peer does not implement renewal
  | "failed";     // an epoch ended without committing; the old deadline stands

export interface RenewedConfig {
  /** What the transport migrates onto. */
  rtc: RtcConfig;
  /** The boundary that configuration states, derived at receipt. Null means the
   *  grant bounds nothing, which is refused rather than treated as "forever". */
  deadline: RelayDeadline | null;
}

export interface RelayRenewalDeps {
  selfId(): string;
  now(): number;
  setTimer?(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer?(timer: ReturnType<typeof setTimeout>): void;
  /** Deliver a signed renewal envelope to the peer. */
  sendSignal(peerId: string, envelope: RenewEnvelope): void;
  /**
   * Ask the server for `round`, correlating on `rid`.
   *
   * Resolves `null` when nothing answered within the caller's own bound — which
   * is what an older server that ignores `ice-renew` looks like, and is
   * deliberately indistinguishable from it here.
   */
  requestRound(round: number, rid: number): Promise<IceGrant | null>;
  /** Whether the peer announced `relay-renew/1`. An unsigned hint (`link:§1.6`),
   *  used only to avoid spending epochs on a peer that cannot answer. */
  peerSupportsRenew(peerId: string): boolean;
  /**
   * Recent authenticated USER-lane activity: actual file bytes or ACK progress,
   * or user text, inside the activity window.
   *
   * NOT a UI "active" flag, not pending consent, not queued work, not
   * keepalives, and not renewal control traffic. See §7.1 — and note that the
   * last of those is structural rather than a promise: a control frame is
   * consumed by the demux before the lane's activity hook can see it.
   */
  userActive(): boolean;
  /** The boundary the link is bounded by right now, or null (LAN / direct). */
  deadline(): RelayDeadline | null;
  /**
   * The local-clock instant the CURRENT boundary was installed.
   *
   * The margin's fixed anchor — see `renewMarginMs`. It has to come from the
   * owner of the deadline rather than be sampled here, because this controller
   * first looks at a grant long after the link installed it, and anchoring to
   * that first look would reproduce the moving-target defect in a subtler form.
   */
  deadlineAnchor(): number;
  /** Turn a granted body into a configuration and its boundary. Null when the
   *  grant carries nothing this client can migrate onto. */
  renewedConfig(grant: IceGrant): RenewedConfig | null;
  /**
   * Publish a committed migration. Called ONLY after §6.5 proof.
   *
   * The caller re-runs its own path classification and re-arms its timers from
   * `deadline`; this controller does not own either.
   */
  commit(deadline: RelayDeadline, round: number): void;
  onStateChange?(state: RenewState): void;
  /** Test seam. Production uses `crypto.getRandomValues`. */
  randomBytes?(length: number): Uint8Array;
}

type Phase = "preparing" | "awaitingReady" | "negotiating" | "probing";

/**
 * How many of the epoch's eight verifications are reserved for each kind.
 *
 * `RENEW_MAX_PROBE_VERIFICATIONS` (8) is the TOTAL, and it is partitioned
 * rather than shared first-come-first-served. Unpartitioned, a flood of junk
 * probe frames spends all eight before the peer's genuine ACK arrives — and
 * that ACK is the only thing that can ever complete a migration, so the flood
 * would cost the renewal without forging anything. Four each bounds the junk
 * and still leaves a genuine exchange far more than it needs: one probe and
 * one ACK complete it, and the retransmit schedule tops out at five sends.
 */
export const RENEW_ACK_VERIFY_RESERVE = 4;
export const RENEW_PROBE_VERIFY_RESERVE = 4;

/**
 * The epoch's verification budget — **one object for the whole epoch, before
 * and after commit.**
 *
 * It is MOVED into the committed record rather than replaced, because commit
 * is not a fresh start for this: the peer is still probing the same epoch, and
 * giving the committed state its own counters would make the real total eight
 * before plus eight after. A previously unseen peer nonce after commit is a
 * legitimate arrival — this side commits on the peer acknowledging ITS nonce,
 * which says nothing about whether the peer's own probe was ever verified here
 * — so that case must still be affordable out of what remains.
 */
interface EpochBudget {
  ackSpent: number;
  probeSpent: number;
  /** One HMAC at a time, so a burst costs one verification rather than one per
   *  frame. */
  verifying: boolean;
  /**
   * The single ACK slot held while a verification is already running.
   *
   * Without it, the peer's genuine ACK arriving during a junk probe's
   * verification is simply dropped: ACKs are not retransmitted on their own —
   * the peer only re-sends its PROBE — so a dropped ACK costs this side the
   * commit while the peer goes on believing the migration is shared. One slot,
   * newest wins, drained when the running verification finishes.
   */
  pendingAck: { nonce: string; tag: string; frame: NonNullable<ReturnType<typeof decodeRenewProbe>> } | null;
}

function newBudget(): EpochBudget {
  return { ackSpent: 0, probeSpent: 0, verifying: false, pendingAck: null };
}

/** A verified inbound probe, remembered so an exact duplicate is answered
 *  without a second HMAC — and so a frame that merely REUSES the nonce with a
 *  different tag is not. */
interface VerifiedProbe {
  /** The tag that actually verified, base64. */
  tag: string;
  /** The ack frame already built for it. */
  ack: ArrayBuffer | null;
}

interface Attempt {
  epoch: number;
  phase: Phase;
  /** The round this attempt is migrating onto, once granted. */
  round: number | null;
  config: RenewedConfig | null;
  /** This side has applied `config` and announced `ready`. */
  localReady: boolean;
  /** The peer announced `ready` at the same round. */
  peerRound: number | null;
  /** Any authenticated signal from the peer has arrived for this attempt. What
   *  separates "the peer does not implement renewal" from "the server is
   *  slow" — two silences that must not reach the same verdict. */
  peerResponded: boolean;
  /** The ufrag of the local description created for this epoch. */
  localUfrag: string;
  /** The ufrag of the remote description applied for this epoch. */
  remoteUfrag: string;
  /** Inbound candidates that arrived before this epoch's remote description,
   *  keyed by the ufrag each names. Bounded. */
  held: Map<string, RTCIceCandidateInit[]>;
  heldCount: number;
  /** §6.3 observation: the selected local candidate belongs to this epoch. */
  observed: boolean;
  /** The instant observation first held, so an ack that predates it cannot
   *  satisfy §6.5. */
  observedAt: number;
  /** This side's own probe nonce for this epoch. */
  nonce: Uint8Array | null;
  nonceBase64: string;
  sends: number;
  /** A verified peer probe waiting for local observation. Single slot: the
   *  latest nonce wins, which is what the peer's own retransmit expects. */
  pendingAck: Uint8Array | null;
  /** nonce(base64) → what verified, and the ack built for it. */
  verified: Map<string, VerifiedProbe>;
  /**
   * A configuration was accepted for this attempt, so the round's migration
   * budget has been charged for it. Exactly once, whatever ends it.
   */
  charged: boolean;
  /** The credential round this attempt is accounted against, fixed when it
   *  began so the charge cannot drift from the gate that admitted it. */
  key: number;
  /** Shared with the committed record this epoch may become. */
  budget: EpochBudget;
  timers: Map<string, ReturnType<typeof setTimeout>>;
}

/**
 * The epoch that committed, retained for a bounded window.
 *
 * ## Why this exists
 *
 * Commit is not simultaneous. This side commits when the peer's ack for ITS
 * nonce arrives; the peer commits when ours reaches it. Between those two
 * instants the peer is still retransmitting, and if this side had torn
 * everything down on its own commit those retransmits would land on an empty
 * state machine, be dropped, and the peer's epoch would time out — one side
 * renewed, the other left on an expiring credential, with nothing anywhere
 * reporting the split.
 *
 * So the committed epoch keeps exactly three abilities and no more: it answers
 * a probe it has already verified (from cache, no new HMAC), it verifies a
 * bounded number of probe nonces it has not seen (the case where every earlier
 * ack was lost), and it keeps emitting this side's own trickle candidates under
 * the committed epoch. It CANNOT start negotiation, cannot move a deadline
 * again, and cannot be promoted back into an attempt.
 */
interface Committed {
  epoch: number;
  round: number;
  localUfrag: string;
  verified: Map<string, VerifiedProbe>;
  /** The SAME object the attempt carried. Not a new allowance. */
  budget: EpochBudget;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export interface RelayRenewal {
  readonly state: RenewState;
  /** The round this link has migrated onto. 0 until one commits. */
  readonly round: number;
  /** Bind to a link, or to none. Called from the link-change hook, so a
   *  transport replacement and a teardown both reach it. */
  setLink(link: MixedPeerLink | null): void;
  /** Called on a bounded cadence and whenever the deadline changes. Decides
   *  whether an attempt is due, and starts one. Idempotent. */
  tick(): void;
  /** Consume a data-lane frame. True means it was ours and MUST NOT be
   *  forwarded to the text session, its activity hook or its rate budget. */
  frame(data: unknown): boolean;
  /** Consume an inbound renewal envelope from this link's peer. */
  signal(peerId: string, envelope: RenewEnvelope): void;
  /** Release every timer and callback. */
  stop(): void;
}

export function createRelayRenewal(deps: RelayRenewalDeps): RelayRenewal {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const randomBytes = deps.randomBytes
    ?? ((length: number) => crypto.getRandomValues(new Uint8Array(length)));

  let link: MixedPeerLink | null = null;
  let state: RenewState = "idle";
  /**
   * The highest epoch this link has ever SPENT, monotonic and never reused.
   *
   * Anchored to the session keys rather than to the link object, so a `link:§8`
   * transport rebuild — which publishes a new object carrying the same keys,
   * and may pass through a null in between — cannot reset it. That reset is
   * what a replay attack needs: an aborted epoch's `prepare` is a validly
   * signed message the peer can keep, and replaying it into a counter that had
   * gone back to zero starts a second attempt at an epoch already spent, which
   * charges the server for a round the link already asked for.
   */
  let epochCounter = 0;
  /** Whose keys `epochCounter` and `round` belong to. The SessionKeys object
   *  itself: a transport rebuild republishes the same one, a genuinely new
   *  link never can. */
  let keysAnchor: MixedPeerLink["keys"] | null = null;
  /** The round this link currently holds credentials for. */
  let round = 0;
  /**
   * Granted migration epochs spent, **keyed by the credential round they were
   * spent on, and never refunded.**
   *
   * ## Why a map, charged at acceptance, and never cleared
   *
   * Three properties, each load-bearing, and no single counter holds all three:
   *
   *  - **Never refunded on commit.** Failure, success and repair all spend the
   *    same credential, so they share one ceiling. A round that cost two failed
   *    migrations before one succeeded has one epoch left, not three.
   *  - **Charged when a configuration is ACCEPTED**, not when the attempt ends.
   *    An attempt can be ended by things the peer controls — an authenticated
   *    abort, supersession by a higher prepare — and charging on the way out
   *    leaves those exits free.
   *  - **Keyed by round**, so a spent round blocks only itself. The next round
   *    is a different credential and a different right.
   *
   * A fourth attempt on a round is refused before any RTC configuration or SDP
   * is produced.
   */
  const migrationSpent = new Map<number, number>();
  /** Rounds retained. A round advances only by server issuance and `stale` is
   *  bounded by `isSaneRound`, so this is slack rather than a real limit — but
   *  a map fed by a remote number does not get to be unbounded. */
  const MIGRATION_ROUNDS_RETAINED = 8;

  const spentOn = (r: number) => migrationSpent.get(r) ?? 0;
  const roundExhausted = (r: number) => spentOn(r) >= RENEW_MAX_EPOCHS_PER_ROUND;
  function chargeMigration(r: number) {
    migrationSpent.set(r, spentOn(r) + 1);
    trim(migrationSpent);
  }
  /**
   * Attempts that ended BEFORE a configuration was granted, **keyed by the
   * round they were approaching.**
   *
   * Bounded twice over: by this count and by the old deadline, past which
   * `due()` refuses outright. A pre-grant failure costs nothing but a
   * signalling round trip and a backoff, so it may be retried more often than
   * a migration — but not without limit, or a server that answers
   * `unavailable` forever would have this link asking until it expires.
   *
   * Keyed for the same reason the migration budget is: a round whose approach
   * has been exhausted must block only ITSELF. Repairs aimed at a committed
   * round 1 are approaches to round 1, and a global counter let them use up
   * the link's ability to ever ask for round 2 — a different credential the
   * link has every right to.
   */
  const approachSpent = new Map<number, number>();
  const approachFor = (r: number) => approachSpent.get(r) ?? 0;
  function chargeApproach(r: number) {
    approachSpent.set(r, approachFor(r) + 1);
    trim(approachSpent);
  }

  /**
   * The credential round an attempt is accounted against.
   *
   * **One key, used verbatim by the gate that admits an attempt and by the
   * charge that ends it.** Any divergence between those two makes the bound
   * meaningless in one direction or the other: a gate reading a key nothing
   * charges never fires, and two keys for one round is two pools where the
   * protocol allows one.
   *
   * A locally triggered attempt is about the round it will ask the server for.
   * An attempt the PEER opened, at a moment when this side already holds a
   * round that can still be repaired, is about that installed round: until the
   * server proves otherwise it can only be a §6.7 repair, and charging it to
   * the next round would let a peer spend credit this link needs to reach that
   * round in earnest.
   *
   * When the installed round IS the next one — obtained but not yet committed —
   * both rules name it, so local and remote attempts share its single pool
   * rather than getting one each.
   */
  function attemptKey(remote: boolean): number {
    if (!remote) return round + 1;
    const repairable = installed !== null && installed.round >= round;
    // **Timing is what separates a repair from an approach**, not merely
    // whether a repair is possible.
    //
    // A peer that opens an epoch while this side is NOT yet in its own renewal
    // window cannot be reaching for the next round: the server has none to give
    // until the issuance floor elapses, so the only thing that epoch can become
    // is a repair of what is already installed. Once this side IS in its window
    // the next round is genuinely available, and a peer driving it is doing the
    // same thing this side's own trigger would — so it is accounted the same
    // way, against the round being sought.
    //
    // Classifying every remote epoch as a repair strands the link: once the
    // installed round's migrations are spent, a legitimate peer-initiated R+1
    // is refused for ever, even though that round has its own untouched budget.
    return repairable && !inRenewalWindow() ? installed!.round : round + 1;
  }

  /**
   * Is this side inside the window in which it would itself seek the next
   * round?
   *
   * The timing half of `due()`, factored out so the trigger and the
   * classification above cannot drift apart: "the peer is early" has to mean
   * exactly "this side would not have started yet".
   */
  function inRenewalWindow(): boolean {
    const bound = deps.deadline();
    if (!bound) return false;
    const at = deps.now();
    if (at >= bound.deadlineAt) return false;
    return at >= bound.deadlineAt - renewMarginMs(bound.deadlineAt, deps.deadlineAnchor());
  }

  function trim(m: Map<number, number>) {
    while (m.size > MIGRATION_ROUNDS_RETAINED) {
      const oldest = m.keys().next();
      if (oldest.done) break;
      m.delete(oldest.value);
    }
  }
  /**
   * The configuration this link has INSTALLED, and the round it belongs to.
   *
   * Link-scoped, and survives a `link:§8` transport rebuild: a rebuilt
   * transport runs on the credentials the renewal obtained, and forgetting them
   * would make a same-round repair impossible and re-derive a boundary from a
   * grant that is no longer current. Reset only when a link with different
   * session keys begins.
   */
  let installed: { round: number; config: RenewedConfig } | null = null;
  /**
   * Bumped whenever an in-flight round request stops being the one this
   * attempt wants — today, when a same-round repair is adopted instead.
   *
   * A server reply is asynchronous and arrives long after the decision that
   * made it irrelevant. Without this fence a late `denied` for R+1 aborts an
   * epoch that has already adopted R, and a late `granted` for R+1 overwrites
   * the adopted configuration with one the peer never agreed to.
   */
  let requestGeneration = 0;
  /** The server refused this round outright; asking again cannot help. */
  let roundDenied = false;
  /** Two prepares went unanswered: this peer does not implement renewal. */
  let peerUnsupported = false;
  let prepareSent = 0;
  /** No new epoch before this instant. See RENEW_RETRY_BACKOFF_MS. */
  let retryNotBefore = 0;
  let attempt: Attempt | null = null;
  let committed: Committed | null = null;
  /** Set once this link has verified ANY renewal signal from its peer. */
  let peerAuthenticated = false;
  let stopped = false;

  function publishState(next: RenewState) {
    if (state === next) return;
    state = next;
    deps.onStateChange?.(next);
  }

  // ── timers ────────────────────────────────────────────────────────────────

  function arm(a: Attempt, name: string, ms: number, fn: () => void) {
    const existing = a.timers.get(name);
    if (existing !== undefined) clearTimer(existing);
    a.timers.set(name, setTimer(() => {
      a.timers.delete(name);
      // Every timer re-checks that its attempt is still the current one. A
      // fired-but-superseded timer is the single most common way a bounded
      // state machine ends something it no longer owns.
      if (attempt !== a || stopped) return;
      fn();
    }, ms));
  }

  function disarm(a: Attempt, name: string) {
    const existing = a.timers.get(name);
    if (existing === undefined) return;
    clearTimer(existing);
    a.timers.delete(name);
  }

  function clearTimers(a: Attempt) {
    for (const timer of a.timers.values()) clearTimer(timer);
    a.timers.clear();
  }

  function clearCommitted() {
    const c = committed;
    if (!c) return;
    committed = null;
    if (c.timer !== undefined) clearTimer(c.timer);
    c.timer = undefined;
  }

  // ── sending ───────────────────────────────────────────────────────────────

  /** The last queued send per link. See `emit`. */
  const sendTail = new WeakMap<MixedPeerLink, Promise<void>>();

  /**
   * Sign and send one renewal signal.
   *
   * Fire and forget by design: signing is asynchronous, and a renewal that
   * cannot be announced is a renewal that times out — which is a state this
   * machine already has, with the right consequence (the old deadline stands).
   *
   * `alive` is re-evaluated AFTER the signature lands, because signing is an
   * await the state can move across. It is a predicate rather than an attempt
   * reference so that a committed epoch can keep trickling candidates under it
   * (see `Committed`) while an abandoned attempt still cannot emit anything.
   *
   * **Sent in the order emitted, per link.** The mirror of the inbound chain
   * (see `signalChain`): two signals emitted back to back — `prepare` and then
   * `ready` — would otherwise go out in whichever order their HMACs finish,
   * which WebCrypto does not promise. A `ready` that overtakes its `prepare`
   * reaches a peer with no attempt yet, is dropped as unroutable and never
   * resent, and an R4 repair then waits out the whole epoch. A server round
   * trip between the two makes that unlikely; it does not make it impossible.
   *
   * So signing starts at once, in parallel, and only the SEND waits its turn
   * behind the previous emission on the same link. Every fence is read at that
   * turn, after both awaits. The queue is keyed by link object: a replacement
   * link starts with its own, so a signature stuck on the old one cannot hold
   * it up, and whatever the old one still had queued fails `link !== live`.
   * A turn never rejects — a failed signature or send is logged and costs only
   * its own signal — so one failure cannot stall the rest of the queue.
   */
  function emit(signal: RenewSignal, alive: () => boolean) {
    const live = link;
    if (!live) return;
    const peerId = live.peerId;
    const payload = renewSignalPayload(signal, deps.selfId(), peerId);
    const signed = signRenewSignal(live, payload).then(
      (auth): string | null => auth,
      (err) => {
        console.error("relayium renew sign error", err);
        return null;
      },
    );
    const previous = sendTail.get(live) ?? Promise.resolve();
    const turn = previous.then(() => signed).then((auth) => {
      try {
        if (auth === null || stopped || link !== live || !alive()) return;
        deps.sendSignal(peerId, { link: true, renew: signal, auth });
      } catch (err) {
        console.error("relayium renew send error", err);
      }
    });
    sendTail.set(live, turn);
  }

  /** An abort is the one signal worth sending for an attempt that has already
   *  ended: it is how the PEER learns to stop. */
  const ALWAYS = () => true;

  async function signRenewSignal(live: MixedPeerLink, payload: string): Promise<string> {
    const mac = await crypto.subtle.sign(
      "HMAC", live.keys.resumeAuth, new TextEncoder().encode(payload),
    );
    return toBase64(new Uint8Array(mac));
  }

  // ── attempt lifecycle ─────────────────────────────────────────────────────

  function endAttempt(a: Attempt, reason: RenewAbortReason | null, next: RenewState) {
    if (attempt !== a) return;
    clearTimers(a);
    attempt = null;
    const transport = link?.conn.renew;
    transport?.suspendUnsignedRestart(false);
    // Only detach the candidate route when no COMMITTED epoch still owns it. A
    // failed attempt after a successful one must not silence the trickle the
    // committed epoch is still entitled to send.
    if (!committed) transport?.onCandidate(null);
    transport?.onSelectedPair(null);
    if (reason) emit({ type: "abort", epoch: a.epoch, reason }, ALWAYS);
    publishState(next);
  }

  /**
   * Dispose of an attempt exactly once, charging what it actually cost.
   *
   * **Every path that ends an attempt goes through here** — a local failure, a
   * timeout, an authenticated abort from the peer, a supersession by a higher
   * prepare, a transport rebuild. Any exit that skipped it would be an exit the
   * peer could take for free, and a peer may abort or re-prepare at will.
   *
   * The migration budget is charged at ACCEPTANCE, not here, so `charged` only
   * decides whether this attempt additionally costs a pre-grant slot. An
   * attempt that never got a configuration consumed a round-trip and nothing
   * else, and is charged as such — including when it was superseded, because a
   * supersession that refunded it would make signed prepares an unbounded
   * source of requests.
   */
  function finishAttempt(
    a: Attempt,
    opts: { announce: RenewAbortReason | null; state: RenewState; backoff: boolean },
  ) {
    if (attempt !== a) return;
    // An attempt that never accepted a configuration is charged against the
    // round it was accounted to when it began — the same key the gate used to
    // admit it. An attempt that DID accept one has already paid that round's
    // migration ceiling and owes nothing here.
    if (!a.charged) chargeApproach(a.key);
    if (opts.backoff) retryNotBefore = deps.now() + RENEW_RETRY_BACKOFF_MS;
    endAttempt(a, opts.announce, opts.state);
  }

  /** End an attempt because something about it did not hold. Never touches the
   *  deadline — that is the whole invariant. */
  function abort(a: Attempt, reason: RenewAbortReason) {
    finishAttempt(a, {
      announce: reason,
      state: reason === "denied" ? "denied" : "failed",
      backoff: true,
    });
  }

  function beginAttempt(epoch: number, remote = false): Attempt {
    const a: Attempt = {
      epoch,
      phase: "preparing",
      round: null,
      config: null,
      localReady: false,
      peerRound: null,
      peerResponded: false,
      localUfrag: "",
      remoteUfrag: "",
      held: new Map(),
      heldCount: 0,
      observed: false,
      observedAt: 0,
      nonce: null,
      nonceBase64: "",
      sends: 0,
      pendingAck: null,
      verified: new Map(),
      charged: false,
      key: attemptKey(remote),
      budget: newBudget(),
      timers: new Map(),
    };
    attempt = a;
    // Monotonic, and recorded the instant the epoch is spent rather than when
    // it ends: an attempt that is superseded mid-flight has still consumed its
    // number, and a replay of it must find the counter already past.
    epochCounter = Math.max(epochCounter, epoch);
    // **Neither budget is charged here.** Which one this attempt spends is not
    // known until it either obtains a configuration or fails without one.
    publishState("renewing");
    link?.conn.renew?.suspendUnsignedRestart(true);
    // The whole-epoch ceiling, armed once and never re-armed: a sequence of
    // individually-legal phases must not add up to an unbounded attempt.
    arm(a, "epoch", RENEW_EPOCH_HARD_CAP_MS, () => abort(a, "timeout"));
    return a;
  }

  // ── the trigger ───────────────────────────────────────────────────────────

  /**
   * Whether an attempt is due right now.
   *
   * Every clause is a refusal to spend an epoch, and each is here because
   * spending one anyway would be wrong rather than merely wasteful:
   *
   *  - no link, or no transport renewal surface: nothing to migrate.
   *  - no deadline: LAN or a classified direct path. There is nothing bounded
   *    to renew, and asking the server would be a backend call a local-only
   *    session must never make.
   *  - the peer does not implement it: an epoch would be a prepare into silence.
   *  - the round was denied, or its epochs are spent: asking again cannot help
   *    inside this round.
   *  - the grant has already lapsed: there is nothing left to renew, and the
   *    link is about to reach its truthful terminal state anyway.
   *  - no recent user-lane activity: §7.1. This is the consent gate, and it is
   *    the reason an idle link still dies on schedule.
   */
  function due(): boolean {
    if (stopped || attempt || peerUnsupported || roundDenied) return false;
    const live = link;
    if (!live?.conn.renew) return false;
    if (!deps.peerSupportsRenew(live.peerId)) return false;
    // Per ROUND, on the key this attempt would carry. A round whose budget is
    // spent blocks only itself: the next round is a different credential and
    // carries its own right.
    if (approachFor(attemptKey(false)) >= RENEW_MAX_PREGRANT_ATTEMPTS) return false;
    if (roundExhausted(round + 1)
      && !(installed && installed.round >= round && !roundExhausted(installed.round))) {
      return false;
    }
    if (!deps.deadline()) return false;
    if (deps.now() < retryNotBefore) return false;
    // The one timing expression, shared with `attemptKey`. It refuses an
    // already-lapsed grant — a lapsed credential must not read as "well past
    // the threshold, go" — and anchors the margin to when the grant was
    // INSTALLED rather than to now. See `renewMarginMs`.
    if (!inRenewalWindow()) return false;
    // Last, because it is the one that can change between ticks and the one a
    // reader most needs to see is not bypassed by any branch above.
    return deps.userActive();
  }

  function tick() {
    if (!due()) return;
    const a = beginAttempt(epochCounter + 1);
    prepareSent++;
    emit({ type: "prepare", epoch: a.epoch }, () => attempt === a);
    // **Peer silence, specifically.** A slow SERVER is a different failure with
    // a different verdict: concluding "this peer does not implement renewal"
    // because the round took too long would black-hole a perfectly capable peer
    // for the life of the link. Disarmed the moment any authenticated signal
    // from the peer arrives, and `peerAuthenticated` covers the case where it
    // answered on an earlier attempt.
    arm(a, "prepare", RENEW_PREPARE_TO_READY_MS, () => {
      if (a.peerResponded || peerAuthenticated) { abort(a, "timeout"); return; }
      if (prepareSent >= 2) {
        peerUnsupported = true;
        finishAttempt(a, { announce: "timeout", state: "unsupported", backoff: true });
        return;
      }
      abort(a, "timeout");
    });
    // A second prepare before that bound, so "two prepares about ten seconds
    // apart with no reply" is a real observation rather than a description.
    arm(a, "prepare-retry", RENEW_PREPARE_SILENCE_MS, () => {
      if (a.phase !== "preparing") return;
      prepareSent++;
      emit({ type: "prepare", epoch: a.epoch }, () => attempt === a);
    });
    void askServer(a);
  }

  // ── the server round ──────────────────────────────────────────────────────

  async function askServer(a: Attempt, asking = round + 1, staleRetries = 1): Promise<void> {
    const rid = randomUint32();
    const generation = requestGeneration;
    let grant: IceGrant | null;
    try {
      grant = await deps.requestRound(asking, rid);
    } catch (err) {
      console.error("relayium renew round error", err);
      grant = null;
    }
    if (stopped || attempt !== a) return;
    // **The fence.** This reply is for a round this attempt stopped wanting —
    // it adopted the peer's already-installed round instead. A late `denied`
    // would abort a migration that is already under way, and a late `granted`
    // would install a configuration the peer never agreed to.
    if (generation !== requestGeneration) return;
    // An older server ignores `ice-renew` entirely, and that is exactly what a
    // null looks like. Treated as `unavailable` rather than as a failure of the
    // peer: the link falls back to today's behaviour on its existing deadline.
    if (!grant || grant.rid !== rid) { awaitRepairOrAbort(a, "unavailable"); return; }
    if (grant.status === "stale") {
      // Resynchronise ONCE to the round the server reports. Bounded, because an
      // adversarial or looping server must not be able to spin this.
      if (staleRetries <= 0 || !isSaneRound(grant.round)) { awaitRepairOrAbort(a, "unavailable"); return; }
      await askServer(a, grant.round, staleRetries - 1);
      return;
    }
    if (grant.status === "denied") {
      // Terminal for this round: quota, verification or membership will not
      // change by asking again. The deadline is untouched.
      roundDenied = true;
      abort(a, "denied");
      return;
    }
    if (grant.status === "unavailable") { awaitRepairOrAbort(a, "unavailable"); return; }

    const config = deps.renewedConfig(grant);
    if (!config) { abort(a, "unavailable"); return; }
    // **No blind extension.** A relayed link that is handed a configuration
    // stating no expiry would otherwise become unbounded — the single outcome
    // this whole feature must never produce. Refused as unavailable.
    if (!config.deadline) { abort(a, "unavailable"); return; }
    // …and a "renewal" that moves the boundary EARLIER, or not at all, is not
    // one. Applying it would retire a live allocation for a shorter-lived one.
    const bound = deps.deadline();
    if (bound && config.deadline.deadlineAt <= bound.deadlineAt) { abort(a, "unavailable"); return; }
    const transport = link?.conn.renew;
    if (!transport) { abort(a, "closed"); return; }
    // **Refused before any RTC configuration or SDP exists.** Three granted
    // migration epochs is what one credential round is worth, and a fourth is
    // not made legitimate by the server replaying the same cached grant.
    if (roundExhausted(grant.round)) { abort(a, "unavailable"); return; }

    a.round = grant.round;
    a.config = config;
    try {
      transport.setConfiguration(config.rtc);
    } catch (err) {
      console.error("relayium renew setConfiguration error", err);
      abort(a, "unavailable");
      return;
    }
    // Accepted. Charged once, here, so that whatever ends this attempt — a
    // timeout, the peer, a higher prepare — the round has already paid.
    a.charged = true;
    chargeMigration(grant.round);
    // Remembered at link scope, so a peer that has not committed this round can
    // be repaired onto it without a second issuance. See `installed`.
    installed = { round: grant.round, config };
    a.localReady = true;
    a.phase = "awaitingReady";
    // The prepare RETRY stops — this side has said everything it needs to — but
    // the peer-silence timer stays armed. A grant proves the server answered;
    // it says nothing about whether the peer is there.
    disarm(a, "prepare-retry");
    emit({ type: "ready", epoch: a.epoch, round: grant.round }, () => attempt === a);
    arm(a, "ready", RENEW_READY_TO_ANSWER_MS, () => abort(a, "timeout"));
    maybeOffer(a);
  }

  /**
   * A round request failed without a configuration — but that may not be the
   * end of the epoch.
   *
   * R4's whole shape: this side already HOLDS a usable round, and the peer,
   * which does not, is driving this epoch to migrate onto it. The server has
   * nothing new to give — the issuance floor has not elapsed, which is exactly
   * why it answered `unavailable` or `rate` — and asking again cannot change
   * that. What CAN still arrive is the peer's `ready(E, R)` naming the round
   * already installed here, and aborting now would throw that away.
   *
   * So when a repair is possible the epoch stays alive, with no configuration,
   * bounded by the timers it already has: the peer-silence timer and the whole-
   * epoch ceiling. If no such `ready` arrives, it times out and is charged to
   * the pre-grant budget exactly as an ordinary refusal would have been.
   *
   * `denied` never reaches here. A policy refusal is terminal for the round and
   * has nothing to do with whether a credential is already in hand.
   */
  function awaitRepairOrAbort(a: Attempt, reason: RenewAbortReason) {
    const held = installed;
    const bound = held?.config.deadline;
    const repairable = !!held && held.round >= round && !!bound && deps.now() < bound.deadlineAt;
    if (!repairable) { abort(a, reason); return; }
    a.phase = "awaitingReady";
  }

  function isSaneRound(next: number): boolean {
    // A server that reports a round at or below the one already held has
    // nothing to resynchronise to, and one that jumps arbitrarily is not a
    // reason to keep asking.
    return next > round && next <= round + RENEW_MAX_EPOCHS_PER_ROUND + 1;
  }

  function randomUint32(): number {
    const bytes = randomBytes(4);
    return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  }

  // ── negotiation ───────────────────────────────────────────────────────────

  /** Both sides hold round R. The link's ESTABLISHED initiator offers — never a
   *  freshly computed role, so a migration cannot turn two peers into two
   *  offerers. */
  function maybeOffer(a: Attempt) {
    if (a.phase !== "awaitingReady") return;
    if (!a.localReady || a.round === null || a.peerRound !== a.round) return;
    const live = link;
    const transport = live?.conn.renew;
    if (!live || !transport) { abort(a, "closed"); return; }
    a.phase = "negotiating";
    disarm(a, "ready");
    if (live.role !== "initiator") {
      // The responder waits for the offer, bounded by the epoch ceiling and by
      // its own answer deadline once the offer lands.
      arm(a, "offer", RENEW_READY_TO_ANSWER_MS, () => abort(a, "timeout"));
      return;
    }
    void (async () => {
      let sdp: RTCSessionDescriptionInit;
      try {
        sdp = await transport.offer();
      } catch (err) {
        console.error("relayium renew offer error", err);
        if (attempt === a) abort(a, "sdp");
        return;
      }
      if (stopped || attempt !== a || link !== live) return;
      a.localUfrag = transport.localUfrag();
      if (a.localUfrag === "") { abort(a, "sdp"); return; }
      bindCandidates(transport);
      emit({
        type: "sdp", epoch: a.epoch, round: a.round!,
        sdpType: "offer", sdp: sdp.sdp ?? "",
      }, () => attempt === a);
      // The description is on the wire; its candidates may follow it now. Same
      // ordering rule the establishment path keeps, re-established because a
      // restart's candidates belong to a ufrag the peer has only just learned.
      transport.releaseCandidates();
      // **Deliberately NOT the probe window.** The offerer has restarted ICE
      // but has no answer yet, so the remote generation under any pair it forms
      // is still the OLD one. Observing there would satisfy §6.3's local clause
      // against a path whose far end has not migrated at all. The window opens
      // when the answer is applied — see `onSdp`.
      arm(a, "answer", RENEW_READY_TO_ANSWER_MS, () => abort(a, "timeout"));
    })();
  }

  /**
   * Route this epoch's local candidates into signed `ice` signals.
   *
   * A candidate whose own ufrag cannot be read is DROPPED, never labelled by
   * the mutable "current epoch" — see §5.2.
   *
   * The route survives commit. After a migration every later local candidate
   * still belongs to the committed ufrag and must keep travelling signed under
   * the committed epoch: the transport refuses to route them any other way, so
   * a callback that stopped at commit would silently end trickle for the rest
   * of the connection. It does NOT reopen migration — the epoch and round are
   * fixed at the committed values and nothing here can start negotiation.
   */
  function bindCandidates(transport: RenewTransport) {
    // **Reads the current state rather than closing over one attempt.** The
    // transport holds a single candidate route, so a callback bound to attempt
    // N is REPLACED when attempt N+1 binds — and if N+1 then fails, the route
    // is left pointing at a closure that recognises neither the live attempt
    // nor the committed epoch, and trickle for the generation the transport is
    // actually on stops for the rest of the connection. Deciding per candidate
    // is what makes that unrepresentable.
    transport.onCandidate((candidate: RTCIceCandidate) => {
      if (stopped) return;
      const a = attempt;
      const c = committed;
      let epoch: number;
      let round: number;
      let localUfrag: string;
      let alive: () => boolean;
      if (a && a.round !== null && a.localUfrag !== "") {
        epoch = a.epoch; round = a.round; localUfrag = a.localUfrag;
        alive = () => attempt === a;
      } else if (c) {
        epoch = c.epoch; round = c.round; localUfrag = c.localUfrag;
        alive = () => committed === c;
      } else {
        return;
      }
      const raw = candidate.candidate;
      const ufrag = inboundCandidateUfrag(
        raw, typeof candidate.usernameFragment === "string" ? candidate.usernameFragment : "",
      );
      if (ufrag === "" || ufrag !== localUfrag) return;
      emit({
        type: "ice", epoch, round,
        candidate: raw,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        usernameFragment: ufrag,
      }, alive);
    });
  }

  /**
   * Open the ICE+probe window.
   *
   * Both descriptions for this epoch must be applied first. That is the
   * correction for observing against a half-migrated transport: with only the
   * local restart done, a freshly formed pair can pass §6.3's local clause
   * while the remote end is still on the previous generation entirely.
   */
  function beginIceWindow(a: Attempt) {
    if (a.localUfrag === "" || a.remoteUfrag === "") { abort(a, "sdp"); return; }
    a.phase = "probing";
    disarm(a, "answer");
    disarm(a, "offer");
    arm(a, "ice", RENEW_ICE_PROBE_MS, () => abort(a, "timeout"));
    const transport = link?.conn.renew;
    if (!transport) { abort(a, "closed"); return; }
    transport.onSelectedPair(() => { void observe(a); });
    pollObservation(a);
  }

  // ── §6.3 observation ──────────────────────────────────────────────────────

  /**
   * Poll rather than rely on the selected-pair event.
   *
   * The event tells you the pair changed; it does not tell you which generation
   * the local candidate belongs to, and one of the three browsers does not
   * expose it at all. `selectedGeneration` is the answer in every case, so the
   * event is a wake-up and this is the guarantee. Bounded by the ICE+probe
   * deadline, which is what stops it.
   */
  function pollObservation(a: Attempt) {
    if (stopped || attempt !== a || a.observed) return;
    void observe(a);
    arm(a, "observe", 500, () => pollObservation(a));
  }

  async function observe(a: Attempt) {
    if (stopped || attempt !== a || a.observed) return;
    if (a.phase !== "probing") return;
    const transport = link?.conn.renew;
    if (!transport) return;
    let generation: { local: string | null; remote: string | null };
    try {
      generation = await transport.selectedGeneration();
    } catch {
      return;
    }
    if (stopped || attempt !== a || a.observed) return;
    // Null is a real answer: no pair yet, a `prflx` candidate this side never
    // gathered, an ambiguous transport address, or a report whose authoritative
    // selection could not be read. Observation stays false, the epoch times
    // out, and the old deadline is kept.
    if (generation.local === null || a.localUfrag === "") return;
    if (generation.local !== a.localUfrag) return;
    // Where the stats name the far end's generation too, it must be this
    // epoch's: a pair whose remote candidate still belongs to the previous
    // generation is not a migrated path. Absent, nothing is inferred — the
    // dual-endpoint proof below is what carries the claim either way.
    if (generation.remote !== null && generation.remote !== a.remoteUfrag) return;
    a.observed = true;
    a.observedAt = deps.now();
    disarm(a, "observe");
    // A peer probe that arrived and verified before this instant has been
    // waiting for exactly this. Answering it now, and not earlier, is what
    // makes an ack mean "my side of the new path is up too".
    flushPendingAck(a);
    startProbing(a);
  }

  // ── §6.4 probing ──────────────────────────────────────────────────────────

  function startProbing(a: Attempt) {
    if (a.nonce) return;
    a.nonce = randomBytes(RENEW_NONCE_BYTES);
    a.nonceBase64 = toBase64(a.nonce);
    sendProbe(a);
  }

  function sendProbe(a: Attempt) {
    if (stopped || attempt !== a || !a.nonce) return;
    if (a.sends >= RENEW_PROBE_MAX_SENDS) return;
    a.sends++;
    void sendControl(
      { epoch: a.epoch, round: a.round ?? 0, alive: () => attempt === a },
      RENEW_PROBE_TYPE_PROBE, a.nonce, a.nonceBase64,
    );
    arm(a, "probe", RENEW_PROBE_RETRY_MS, () => sendProbe(a));
  }

  interface ControlContext {
    epoch: number;
    round: number;
    /** Re-checked after the HMAC. A committed epoch is still alive for acks. */
    alive(): boolean;
  }

  /**
   * Put one control frame on the text lane, bypassing the text send queue.
   *
   * Deliberately not `enqueueControl`: this frame is not part of any
   * conversation, must not be ordered against protected frames, and must not
   * exist in the text session's state at all. It is written straight to the
   * channel, which is also why a failed write is only logged — a control frame
   * that did not go out costs a retransmit, and five of them costs the epoch.
   *
   * Returns the exact bytes sent, so an ack can be cached and replayed for a
   * duplicate probe without spending a second HMAC.
   */
  async function sendControl(
    ctx: ControlContext, type: number, nonce: Uint8Array, nonceBase64: string,
  ): Promise<ArrayBuffer | null> {
    const live = link;
    if (!live) return null;
    const kind = type === RENEW_PROBE_TYPE_PROBE ? "link-renew-probe" : "link-renew-ack";
    const payload = renewProbePayload(
      kind, deps.selfId(), live.peerId, ctx.epoch, ctx.round, nonceBase64,
    );
    let tag: Uint8Array;
    try {
      tag = await signRenewProbe(live.keys.resumeAuth, payload);
    } catch (err) {
      console.error("relayium renew probe sign error", err);
      return null;
    }
    if (stopped || link !== live || !ctx.alive()) return null;
    const frameBytes = encodeRenewProbe({
      type: type as typeof RENEW_PROBE_TYPE_PROBE,
      epoch: ctx.epoch,
      round: ctx.round,
      nonce,
      tag,
    });
    if (live.textChannel.readyState !== "open") return frameBytes;
    try {
      live.textChannel.send(frameBytes);
    } catch (err) {
      console.error("relayium renew probe send error", err);
    }
    return frameBytes;
  }

  function flushPendingAck(a: Attempt) {
    const nonce = a.pendingAck;
    if (!nonce) return;
    a.pendingAck = null;
    void ackProbe(a, nonce);
  }

  async function ackProbe(a: Attempt, nonce: Uint8Array) {
    const encoded = toBase64(nonce);
    const sent = await sendControl(
      { epoch: a.epoch, round: a.round ?? 0, alive: () => attempt === a || committed?.epoch === a.epoch },
      RENEW_PROBE_TYPE_ACK, nonce, encoded,
    );
    // Cached against the record that verified it, so a retransmit is answered
    // from memory. Recorded even when the channel was not writable: the frame
    // is still the right answer if the peer asks again.
    const record = (attempt === a ? a.verified : committed?.verified)?.get(encoded);
    if (record && sent) record.ack = sent;
  }

  /** Replay a cached ack. No HMAC, no state change — the answer already exists. */
  function resendAck(record: VerifiedProbe) {
    const live = link;
    if (!live || !record.ack) return;
    if (live.textChannel.readyState !== "open") return;
    try {
      live.textChannel.send(record.ack);
    } catch (err) {
      console.error("relayium renew probe send error", err);
    }
  }

  // ── §6.5 commit ───────────────────────────────────────────────────────────

  function commit(a: Attempt) {
    const config = a.config;
    const live = link;
    if (!config?.deadline || a.round === null || !live) { abort(a, "closed"); return; }
    /**
     * **A repair of the round already held, not a new one.**
     *
     * R4's asymmetric case: this side committed round R, the peer did not, and
     * the peer drives a fresh epoch to migrate onto the SAME R using the
     * configuration this side already installed. That is a genuine migration —
     * the path really did move and really was proven — but it buys no time:
     * the credential is the one this deadline was already derived from.
     *
     * So the boundary and its anchor are left exactly as they are, and the
     * round's epoch budget is NOT refunded. Re-arming here would hand a link
     * an unbounded series of extensions for one credential, which is the one
     * outcome this whole feature must never produce.
     */
    const sameRound = a.round === round;
    if (!sameRound) {
      round = a.round;
      // **`migrationSpent` is NOT cleared.** A credential that cost two failed
      // migrations before it succeeded has one epoch left, not three: failure,
      // success and repair all spend the same round. Clearing here is what let
      // one credential fund an unbounded series of migrations.
      //
      // The backoff resets; the pre-grant map does not need to, because it is
      // already keyed by the round being approached and this is a new one.
      approachSpent.delete(a.round);
      roundDenied = false;
      retryNotBefore = 0;
    }
    clearTimers(a);
    attempt = null;
    // The bounded post-commit window. See `Committed`: the peer has not
    // committed yet, and its retransmitted probes must still be answered.
    clearCommitted();
    const c: Committed = {
      epoch: a.epoch,
      round: a.round,
      localUfrag: a.localUfrag,
      verified: a.verified,
      // MOVED, not replaced. See `EpochBudget`.
      budget: a.budget,
      timer: undefined,
    };
    committed = c;
    c.timer = setTimer(() => {
      c.timer = undefined;
      if (committed === c) {
        committed = null;
        // The candidate route belonged to this epoch and nothing else owns it.
        link?.conn.renew?.onCandidate(null);
      }
    }, RENEW_POST_COMMIT_ACK_MS);
    const transport = live.conn.renew;
    transport?.suspendUnsignedRestart(false);
    transport?.onSelectedPair(null);
    publishState("renewed");
    if (!sameRound) deps.commit(config.deadline, a.round);
    // An ack held while the commit's own verification was running still has to
    // be answered — it belongs to this epoch, and the committed record owns the
    // budget now.
    drainPendingAck();
  }

  // ── inbound signalling ────────────────────────────────────────────────────

  /**
   * Inbound signalling is SERIALISED, and that is not tidiness.
   *
   * Verification is asynchronous, so two signals handed over in the same turn
   * race their HMACs and can be applied out of order. The reachable case is a
   * peer whose round was already cached and which therefore sends `prepare`
   * and `ready` back to back: if the `ready` verifies first it finds no attempt
   * yet, is dropped as unroutable, and is never resent — the two sides then sit
   * waiting for each other until the epoch times out. Nothing about that is
   * visible in either side's state; it simply does not renew.
   *
   * §3.5 requires one HMAC at a time and a cap on pending work. The chain is
   * the first; `signalPending` is the second, so a flood costs a bounded queue
   * rather than unbounded memory and an unbounded verification backlog.
   */
  let signalChain: Promise<void> = Promise.resolve();
  let signalPending = 0;

  function signal(peerId: string, envelope: RenewEnvelope) {
    const live = link;
    if (stopped || !live || live.peerId !== peerId) return;
    if (signalPending >= RENEW_MAX_PENDING_SIGNALS) return;
    const inner = envelope.renew;
    signalPending++;
    signalChain = signalChain
      .then(() => accept(live, inner, envelope.auth))
      .catch((err) => console.error("relayium renew signal error", err))
      .finally(() => { signalPending--; });
  }

  async function accept(live: MixedPeerLink, inner: RenewSignal, auth: string) {
    {
      if (stopped || link !== live) return;
      // Cheap epoch routing BEFORE the HMAC (§3.5), evaluated HERE rather than
      // at enqueue time: the message ahead of this one in the chain is exactly
      // what may have made this one routable.
      if (!routable(inner)) return;
      const payload = renewSignalPayload(inner, live.peerId, deps.selfId());
      let ok: boolean;
      try {
        ok = await verifyRenew(live.keys.resumeAuth, payload, auth);
      } catch (err) {
        console.error("relayium renew verify error", err);
        return;
      }
      if (stopped || link !== live || !ok) return;
      // The first verified renewal signal is what locks this connection's
      // unsigned SDP out. Monotonic, authenticated, and independent of the
      // `caps` hint.
      if (!peerAuthenticated) {
        peerAuthenticated = true;
        live.conn.renew?.lockUnsignedSdp();
      }
      // Re-checked after the await: verification is a point the state moves
      // across, and a replay that became routable before it must not stay
      // routable after.
      if (!routable(inner)) return;
      const a = attempt;
      if (a && (inner.type === "prepare" || inner.epoch === a.epoch)) {
        a.peerResponded = true;
        disarm(a, "prepare");
        disarm(a, "prepare-retry");
      }
      apply(live, inner);
    }
  }

  /**
   * Can this side act on this message at all?
   *
   * The `prepare` rule is the replay guard. With no attempt in flight, a
   * prepare is only routable if its epoch is STRICTLY newer than anything this
   * link has ever spent — otherwise a previously valid, correctly signed
   * prepare for an epoch that already failed can be replayed to start a second
   * attempt at that number and charge the server for the round again.
   */
  function routable(inner: RenewSignal): boolean {
    if (inner.type === "prepare") {
      if (peerUnsupported) return false;
      // Equal coalesces with the attempt in flight; anything else must be
      // strictly newer than every epoch spent, including one a refused
      // prepare spent while this attempt ran (then higher is adopted).
      if (attempt && inner.epoch === attempt.epoch) return true;
      return inner.epoch > epochCounter;
    }
    return attempt !== null && inner.epoch === attempt.epoch;
  }

  function apply(live: MixedPeerLink, inner: RenewSignal) {
    if (inner.type === "prepare") { onPrepare(inner.epoch); return; }
    const a = attempt;
    if (!a || a.epoch !== inner.epoch) return;
    switch (inner.type) {
      case "abort":
        // The peer ended it. Nothing to send back, and the deadline stands —
        // but it IS charged and it DOES back off. An abort the peer chose to
        // send must not be a way to make this side start over for free.
        if (inner.reason === "denied") roundDenied = true;
        finishAttempt(a, {
          announce: null,
          state: inner.reason === "denied" ? "denied" : "failed",
          backoff: true,
        });
        return;
      case "ready":
        /**
         * **Recorded first, unconditionally, and that order is the whole fix.**
         *
         * This `ready` is authenticated and belongs to the epoch in flight, so
         * the peer's round is a fact about this attempt whether or not this
         * side has its own configuration yet. The two server replies arrive
         * independently, and the peer's landing first is ordinary — not a
         * repair, not an error, just asymmetric delivery.
         *
         * Gating the record on a §6.7 adoption attempt made the ordinary first
         * round deadlock: with no local grant yet and nothing installed, the
         * adoption correctly declined, the record was skipped, and the peer's
         * `ready` was dropped for good. The peer never re-sends one, so both
         * ends then waited out the epoch with no ICE restart at all. Caught
         * against real Chrome by delaying one side's round reply by a second.
         *
         * Recording confers no authority: `maybeOffer` still requires this
         * side's OWN verified configuration and exact round agreement, so a
         * peer naming a round this side never obtained simply never agrees.
         */
        a.peerRound = inner.round;
        // Only now consider a repair, which is the narrower case: no
        // configuration of this side's own, but one already installed for
        // exactly the round the peer named.
        maybeAdoptInstalledRound(a);
        maybeOffer(a);
        return;
      case "sdp":
        void onSdp(live, a, inner);
        return;
      case "ice":
        void onCandidate(a, inner);
        return;
    }
  }

  function onPrepare(epoch: number) {
    // Verified and routable: the peer has spent this epoch whether or not it
    // is refused below. Recorded first, so the same signed prepare replayed
    // after the refusing condition clears is stale (G34-N13).
    epochCounter = Math.max(epochCounter, epoch);
    const live = link;
    if (!live?.conn.renew) return;
    // §7.1: joining is consent too, and this side may have none to give right
    // now. `unavailable` rather than `denied`, deliberately: a person who is
    // idle at this instant may be typing in thirty seconds, and `denied` is
    // reserved for the server's policy refusal, which asking again cannot
    // change. The peer's own backoff is what keeps a repeatedly-idle pair
    // bounded.
    if (!deps.userActive() || !deps.deadline()) {
      emit({ type: "abort", epoch, reason: "unavailable" }, ALWAYS);
      return;
    }
    if (roundDenied) {
      emit({ type: "abort", epoch, reason: "denied" }, ALWAYS);
      return;
    }
    const a = attempt;
    if (a) {
      if (epoch === a.epoch) return; // simultaneous prepare: one attempt, already running
      if (epoch < a.epoch) return;
      // A higher VALID authenticated prepare wins; both ends converge upward.
      // Charged, because the superseded attempt really did consume a request —
      // otherwise a peer could walk the epoch counter upward indefinitely and
      // never pay for any of it. No backoff: the replacement starts now, and
      // delaying it would defeat the convergence this rule exists for.
      finishAttempt(a, { announce: null, state: "renewing", backoff: false });
    }
    // Admitted on exactly the key it will be charged on — see `attemptKey`.
    const key = attemptKey(true);
    const affordable = approachFor(key) < RENEW_MAX_PREGRANT_ATTEMPTS && !roundExhausted(key);
    if (!affordable) {
      emit({ type: "abort", epoch, reason: "unavailable" }, ALWAYS);
      return;
    }
    const next = beginAttempt(epoch, true);
    prepareSent++;
    emit({ type: "prepare", epoch }, () => attempt === next);
    void askServer(next);
  }

  /**
   * The asymmetric-commit repair (R4).
   *
   * One side commits a round and the other does not — its ack was lost, its
   * post-commit window expired, its epoch timed out. The committed side then
   * holds round R while its peer is asking the server for R+1, and the two can
   * never meet: R+1 will not be issued until the issuance floor allows it, and
   * the peer that already has R has nothing to gain from a new credential.
   *
   * So when the peer says `ready(E, R)` for the exact round this side has
   * installed, this side adopts its OWN stored configuration for R rather than
   * waiting for R+1. No new issuance is needed, and nothing is taken on the
   * peer's word: the configuration used is the one this side already fetched
   * and verified, and the `ready` that triggered it was signed under the link's
   * own key.
   *
   * A no-op in every case that is not a repair — including the ordinary one
   * where this side simply has not been granted its round yet, which is a
   * matter of timing and not something to decide anything about.
   */
  function maybeAdoptInstalledRound(a: Attempt) {
    const peerRound = a.peerRound;
    if (peerRound === null) return;
    // Already holding a configuration for this epoch. If it agrees with the
    // peer, the ordinary path proceeds; if it does not, adopting the peer's
    // would mean discarding one already applied to the transport.
    if (a.round !== null) return;
    const held = installed;
    // Every exclusion R4 names, in order: nothing installed, a round this side
    // never fetched, one older than the round already held, and a configuration
    // whose credential has already lapsed.
    if (!held || peerRound !== held.round) return;
    if (peerRound < round) return;
    const bound = held.config.deadline;
    if (!bound || deps.now() >= bound.deadlineAt) return;
    // A repair is a migration epoch on that round like any other, and the
    // fourth one is refused here — before the transport is reconfigured.
    if (roundExhausted(held.round)) return;
    const transport = link?.conn.renew;
    if (!transport) return;
    // The in-flight R+1 request is no longer this attempt's. Fenced before the
    // configuration is applied, so a reply that lands during it is already
    // stale by the time it is read.
    requestGeneration++;
    try {
      transport.setConfiguration(held.config.rtc);
    } catch (err) {
      console.error("relayium renew setConfiguration error", err);
      return;
    }
    a.round = held.round;
    a.config = held.config;
    a.charged = true;
    chargeMigration(held.round);
    a.localReady = true;
    a.phase = "awaitingReady";
    disarm(a, "prepare-retry");
    emit({ type: "ready", epoch: a.epoch, round: held.round }, () => attempt === a);
    arm(a, "ready", RENEW_READY_TO_ANSWER_MS, () => abort(a, "timeout"));
  }

  async function onSdp(
    live: MixedPeerLink, a: Attempt,
    inner: Extract<RenewSignal, { type: "sdp" }>,
  ) {
    const transport = live.conn.renew;
    if (!transport) { abort(a, "closed"); return; }
    if (a.round === null || inner.round !== a.round) { abort(a, "sdp"); return; }
    const offering = inner.sdpType === "offer";
    // Only the established initiator offers, and only the responder answers.
    // Anything else is a message this side must not act on.
    if (offering !== (live.role === "responder")) { abort(a, "sdp"); return; }
    if (!offering && a.localUfrag === "") { abort(a, "sdp"); return; }

    const baseline = transport.baseline();
    if (!baseline) { abort(a, "sdp"); return; }
    // **Pinned BEFORE the peer connection is mutated.**
    //
    // The tag proves who sent this description; it does not prove the transport
    // underneath may be replaced. Checking the received bytes first means a
    // description carrying a foreign DTLS identity, a changed m-line set or a
    // flipped answerer role never reaches `setRemoteDescription` at all —
    // rather than being applied and then objected to, which would already have
    // moved the agent onto it.
    if (!sdpPinMatches(baseline, sdpPin(inner.sdp), inner.sdpType === "answer")) {
      abort(a, "sdp");
      return;
    }
    let applied;
    try {
      applied = await transport.applyRemote({ type: inner.sdpType, sdp: inner.sdp });
    } catch (err) {
      console.error("relayium renew remote description error", err);
      if (attempt === a) abort(a, "sdp");
      return;
    }
    if (stopped || attempt !== a || link !== live) return;
    // Defence in depth: the same check against what the agent actually holds,
    // in case a stack rewrote part of the description while applying it.
    if (!sdpPinMatches(baseline, applied, inner.sdpType === "answer")) {
      abort(a, "sdp");
      return;
    }
    a.remoteUfrag = transport.remoteUfrag();
    // Non-empty AND actually new. A remote description whose ufrag equals the
    // one this epoch started from is not a migration: it is the previous
    // generation being handed back, and binding to it would make every fresh
    // candidate look foreign.
    if (a.remoteUfrag === "") { abort(a, "sdp"); return; }
    await flushHeldCandidates(a, transport);
    if (stopped || attempt !== a) return;

    if (!offering) {
      // The initiator now holds the answer. Both descriptions for this epoch
      // are applied, so the probe window may open.
      beginIceWindow(a);
      return;
    }
    let answer: RTCSessionDescriptionInit;
    try {
      answer = await transport.answer();
    } catch (err) {
      console.error("relayium renew answer error", err);
      if (attempt === a) abort(a, "sdp");
      return;
    }
    if (stopped || attempt !== a || link !== live) return;
    a.localUfrag = transport.localUfrag();
    if (a.localUfrag === "") { abort(a, "sdp"); return; }
    bindCandidates(transport);
    emit({
      type: "sdp", epoch: a.epoch, round: a.round,
      sdpType: "answer", sdp: answer.sdp ?? "",
    }, () => attempt === a);
    transport.releaseCandidates();
    beginIceWindow(a);
  }

  async function onCandidate(a: Attempt, inner: Extract<RenewSignal, { type: "ice" }>) {
    if (a.round === null || inner.round !== a.round) return;
    const transport = link?.conn.renew;
    if (!transport) return;
    // The candidate's OWN generation, requiring the two sources to agree where
    // both are present. A relay that relabels one copy gets a drop.
    const ufrag = inboundCandidateUfrag(inner.candidate, inner.usernameFragment);
    if (ufrag === "") return;
    const init: RTCIceCandidateInit = {
      candidate: inner.candidate,
      sdpMid: inner.sdpMid,
      sdpMLineIndex: inner.sdpMLineIndex,
      usernameFragment: ufrag,
    };
    if (a.remoteUfrag === "") {
      // This epoch's remote description has not landed yet. Held by the ufrag
      // the candidate names, so a candidate from the PREVIOUS generation cannot
      // be released into this one when it does.
      if (a.heldCount >= RENEW_MAX_HELD_CANDIDATES) return;
      a.heldCount++;
      const bucket = a.held.get(ufrag);
      if (bucket) bucket.push(init);
      else a.held.set(ufrag, [init]);
      return;
    }
    if (ufrag !== a.remoteUfrag) return;
    try {
      await transport.addCandidate(init);
    } catch {
      // Rejected by the agent — malformed, or for a generation it has moved
      // past. Non-fatal and never takes its siblings with it.
    }
  }

  async function flushHeldCandidates(a: Attempt, transport: RenewTransport) {
    const bucket = a.held.get(a.remoteUfrag) ?? [];
    // Every generation's queue is dropped, not only the one released: an old
    // ufrag's candidates have nothing left to belong to.
    a.held.clear();
    a.heldCount = 0;
    for (const init of bucket) {
      if (stopped || attempt !== a) return;
      try {
        await transport.addCandidate(init);
      } catch { /* see onCandidate */ }
    }
  }

  // ── inbound data-lane frames ──────────────────────────────────────────────

  /**
   * The front demux.
   *
   * Returns true for anything whose first byte is `0x0d`, INCLUDING a frame
   * that then fails every later check. That is deliberate: a malformed control
   * frame is still ours, and letting it fall through would hand the text lane a
   * frame that resets its idle timer and spends its rate budget — the two
   * things §6.2 forbids.
   */
  function frame(data: unknown): boolean {
    if (!isRenewControlFrame(data)) return false;
    if (stopped || !link) return true;
    const decoded = decodeRenewProbe(data);
    if (!decoded) return true;
    const encoded = toBase64(decoded.nonce);
    const tag = toBase64(decoded.tag);

    const a = attempt;
    if (a && decoded.epoch === a.epoch && decoded.round === (a.round ?? 0)) {
      handleControl(a, decoded, encoded, tag);
      return true;
    }
    // The committed window: the peer has not committed yet and is still
    // retransmitting. It may be answered, but nothing here can move a deadline.
    const c = committed;
    if (c && decoded.epoch === c.epoch && decoded.round === c.round
        && decoded.type === RENEW_PROBE_TYPE_PROBE) {
      handleCommittedProbe(c, decoded, encoded, tag);
    }
    return true;
  }

  /**
   * Is there budget for one more verification of this kind?
   *
   * Both the per-kind reservation and the total are checked. The total is
   * redundant while the two reserves sum to it, and is kept anyway so that
   * changing one reserve cannot silently raise the ceiling.
   */
  function canVerify(budget: EpochBudget, type: number): boolean {
    if (budget.ackSpent + budget.probeSpent >= RENEW_MAX_PROBE_VERIFICATIONS) return false;
    return type === RENEW_PROBE_TYPE_ACK
      ? budget.ackSpent < RENEW_ACK_VERIFY_RESERVE
      : budget.probeSpent < RENEW_PROBE_VERIFY_RESERVE;
  }

  function spend(budget: EpochBudget, type: number) {
    if (type === RENEW_PROBE_TYPE_ACK) budget.ackSpent++;
    else budget.probeSpent++;
  }

  function handleControl(
    a: Attempt,
    decoded: NonNullable<ReturnType<typeof decodeRenewProbe>>,
    encoded: string, tag: string,
  ) {
    if (decoded.type === RENEW_PROBE_TYPE_PROBE) {
      const known = a.verified.get(encoded);
      // **An exact duplicate, tag included.** Matching on the nonce alone would
      // let a forged frame that merely reuses a nonce collect a free ack
      // without ever holding the key. The tag is part of the identity of "a
      // frame already verified".
      if (known) {
        if (known.tag === tag) resendAck(known);
        return;
      }
    } else {
      // An ack is only interesting for THIS side's current nonce. Checking it
      // before the HMAC is what stops a flood of acks for invented nonces from
      // buying verification work.
      if (!a.nonce || a.nonceBase64 !== encoded) return;
      if (!a.observed) return;
    }
    const budget = a.budget;
    if (budget.verifying) {
      // An ELIGIBLE ack — it already passed the nonce and observation checks
      // above — held in the single slot rather than dropped. A probe is not
      // held: the peer retransmits those, so losing one costs two seconds.
      if (decoded.type === RENEW_PROBE_TYPE_ACK) {
        budget.pendingAck = { nonce: encoded, tag, frame: decoded };
      }
      return;
    }
    if (!canVerify(budget, decoded.type)) return;
    spend(budget, decoded.type);
    budget.verifying = true;
    void verifyControl(a, decoded, encoded, tag).finally(() => {
      budget.verifying = false;
      drainPendingAck();
    });
  }

  /**
   * Feed the held ack back in, once the verification that displaced it is done.
   *
   * Re-entered through the ordinary path rather than verified directly, so the
   * eligibility checks run again against whatever the state has become — the
   * epoch may have ended, or this side may have committed, while the HMAC that
   * displaced it was running.
   */
  function drainPendingAck() {
    const a = attempt;
    const budget = a ? a.budget : committed?.budget;
    const held = budget?.pendingAck;
    if (!a || !budget || !held) return;
    budget.pendingAck = null;
    if (held.frame.epoch !== a.epoch || held.frame.round !== (a.round ?? 0)) return;
    handleControl(a, held.frame, held.nonce, held.tag);
  }

  /** A retransmitted probe for the epoch this side has already committed. */
  function handleCommittedProbe(
    c: Committed,
    decoded: NonNullable<ReturnType<typeof decodeRenewProbe>>,
    encoded: string, tag: string,
  ) {
    const known = c.verified.get(encoded);
    if (known) {
      if (known.tag === tag) resendAck(known);
      return;
    }
    // A nonce this side never saw, after commit.
    //
    // **Legitimate, and paid for out of what the epoch has left.** This side
    // commits when the peer acknowledges ITS nonce, which says nothing about
    // whether the peer's own probe was ever verified here — so the first
    // sighting of a peer nonce genuinely can fall after commit. It draws on the
    // SAME budget object the attempt carried (see `EpochBudget`), from the
    // probe reservation, so the epoch's real total stays eight.
    const budget = c.budget;
    if (budget.verifying || !canVerify(budget, RENEW_PROBE_TYPE_PROBE)) return;
    spend(budget, RENEW_PROBE_TYPE_PROBE);
    budget.verifying = true;
    void (async () => {
      const live = link;
      if (!live) return;
      const payload = renewProbePayload(
        "link-renew-probe", live.peerId, deps.selfId(), decoded.epoch, decoded.round, encoded,
      );
      let ok = false;
      try {
        ok = await verifyRenewProbe(live.keys.resumeAuth, payload, decoded.tag);
      } catch (err) {
        console.error("relayium renew probe verify error", err);
      }
      if (stopped || !ok || committed !== c || link !== live) return;
      const record: VerifiedProbe = { tag, ack: null };
      c.verified.set(encoded, record);
      const sent = await sendControl(
        { epoch: c.epoch, round: c.round, alive: () => committed === c },
        RENEW_PROBE_TYPE_ACK, decoded.nonce, encoded,
      );
      if (sent) record.ack = sent;
    })().finally(() => {
      budget.verifying = false;
    });
  }

  async function verifyControl(
    a: Attempt,
    decoded: NonNullable<ReturnType<typeof decodeRenewProbe>>,
    encoded: string, tag: string,
  ) {
    const live = link;
    if (!live) return;
    const kind = decoded.type === RENEW_PROBE_TYPE_PROBE ? "link-renew-probe" : "link-renew-ack";
    const payload = renewProbePayload(
      kind, live.peerId, deps.selfId(), decoded.epoch, decoded.round, encoded,
    );
    let ok: boolean;
    try {
      ok = await verifyRenewProbe(live.keys.resumeAuth, payload, decoded.tag);
    } catch (err) {
      console.error("relayium renew probe verify error", err);
      return;
    }
    if (stopped || !ok || attempt !== a || link !== live) return;
    if (decoded.type === RENEW_PROBE_TYPE_PROBE) {
      a.verified.set(encoded, { tag, ack: null });
      if (a.observed) void ackProbe(a, decoded.nonce);
      // Single slot: the peer retransmits the same nonce, and a newer one
      // supersedes an older one that this side never got to answer.
      else a.pendingAck = decoded.nonce;
      return;
    }
    // An ACK for this side's own current nonce.
    //
    // **Every clause of §6.5, restated as code.** The local path was observed;
    // the observation happened BEFORE this ack landed; and the nonce is the one
    // this side is currently retransmitting. A peer only sends this after its
    // own observation held, which is the third leg — and the one this side
    // cannot check, which is exactly why the tag has to be unforgeable.
    if (!a.observed) return;
    if (a.nonceBase64 !== encoded) return;
    if (deps.now() < a.observedAt) return;
    commit(a);
  }

  // ── link binding ──────────────────────────────────────────────────────────

  /** Everything that belongs to one authenticated link. Reset together, and
   *  only when the KEYS change — never merely because a transport was rebuilt. */
  function resetLinkScope() {
    epochCounter = 0;
    round = 0;
    migrationSpent.clear();
    approachSpent.clear();
    roundDenied = false;
    peerUnsupported = false;
    prepareSent = 0;
    retryNotBefore = 0;
    requestGeneration++;
    // R7: the installed configuration belongs to the AUTHENTICATED link, not to
    // a transport. It survives a §8 rebuild and dies only here, with the keys.
    installed = null;
  }

  function setLink(next: MixedPeerLink | null) {
    const previous = link;
    if (previous === next) return;
    const a = attempt;
    // A transport replacement means a new PeerConnection with a new baseline:
    // this epoch's restart, its ufrags and its observation all belonged to a
    // connection that no longer exists. The peer is told, so it stops too —
    // but only when it IS the same authenticated link, because a different one
    // has a different peer and a different key and there is nobody to tell.
    const rebuilt = !!next && !!previous
      && previous.keys === next.keys && previous.peerId === next.peerId;
    if (a) {
      // **Deliberately not charged.** A rebuild is not this attempt failing;
      // the connection it ran on ceased to exist. The migration budget is
      // already safe either way — it is charged at acceptance, so a rebuild
      // can never refund a granted epoch — and only the pre-grant slot is
      // waived. Charging it here would let ordinary transport flapping, which
      // the recovery window already bounds, exhaust a link's ability to renew
      // for a reason that has nothing to do with renewal.
      clearTimers(a);
      attempt = null;
    }
    clearCommitted();
    previous?.conn.renew?.suspendUnsignedRestart(false);
    previous?.conn.renew?.onCandidate(null);
    previous?.conn.renew?.onSelectedPair(null);
    link = next;
    // **After the swap, deliberately.** `emit` re-checks that the link it
    // captured is still current once its signature lands, and on a rebuild the
    // current link is the NEW object — so an abort emitted before this line was
    // signed against the old one and silently dropped, leaving the peer to time
    // its epoch out with nothing said.
    if (a && rebuilt) emit({ type: "abort", epoch: a.epoch, reason: "closed" }, ALWAYS);
    if (!next) {
      // **The counter is NOT reset here.** A teardown that is really a
      // transport rebuild can publish null in between, and resetting on that
      // null would hand a replayed `prepare` a counter back at zero. The scope
      // is reset when a link with DIFFERENT keys arrives, which is the only
      // event that genuinely ends an authenticated link.
      peerAuthenticated = false;
      publishState("idle");
      return;
    }
    if (keysAnchor !== next.keys) {
      keysAnchor = next.keys;
      resetLinkScope();
      peerAuthenticated = false;
      publishState("idle");
      return;
    }
    // Same authenticated link on a rebuilt transport. The epoch counter, the
    // round and the peer's support verdict all survive; what does not is the
    // per-CONNECTION lock, because this is a different PeerConnection whose
    // baseline has only just been pinned.
    peerAuthenticated = false;
    publishState(state === "renewed" ? "renewed" : "idle");
  }

  function stop() {
    stopped = true;
    const a = attempt;
    if (a) {
      clearTimers(a);
      attempt = null;
    }
    clearCommitted();
    const transport = link?.conn.renew;
    transport?.suspendUnsignedRestart(false);
    transport?.onCandidate(null);
    transport?.onSelectedPair(null);
    link = null;
    keysAnchor = null;
    state = "idle";
  }

  return {
    get state() { return state; },
    get round() { return round; },
    setLink,
    tick,
    frame,
    signal,
    stop,
  };
}

/** Re-exported so a consumer that only imports this module still has the one
 *  capability string, rather than a second literal that could drift. */
export { CAP_RENEW };
