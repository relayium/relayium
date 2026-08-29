// The browser half of the two-peer relay agreement: it owns one room's RTT
// maps, decides when the choice may be read, and holds the one step that reads
// it until then.
//
// `pickRelay` (ice.ts) is symmetric, so two peers holding the same pair of maps
// cannot disagree. What that guarantee needs, and did not have, is that both
// sides READ the maps after both have arrived. The RTC configuration is
// snapshotted once, when a connection is created, so a link established while
// measurement was still running is built on the fallback for its whole life —
// and the peer, which did wait, is on the relay it chose. Two peers, two relays,
// two hops, and roughly twice the metered relay bandwidth.
//
// So this is a GATE, not a value: `whenReady` is what `peer-link` waits on
// before it puts the first legal `link/1` request or offer on the wire and
// before it answers one.

import {
  pickRelay, relayChoiceDominates, relayDominanceElapsedMs, type RelayEntry,
} from "./ice";

/**
 * How long a room waits for a PEER's map before building on the fallback
 * instead.
 *
 * Counted from the moment a peer exists — `notePeer` — and deliberately not from
 * the moment the room starts measuring. Measuring starts at room join, but the
 * other person may take a minute to type the code, and a deadline armed at join
 * would have expired long before they arrived: the gate would then be open, with
 * no peer map in it, exactly when the late peer finally announces. Every legal
 * `link/1` frame after that is built on the fallback, which is the defect this
 * whole file exists to close, reintroduced from the other end.
 *
 * Our own probes still run eagerly at join, so in the ordinary case this grace
 * is spent waiting for one already-measured peer to speak rather than for
 * anything local — and when both maps are already in hand the gate opens without
 * consulting it at all (see `settled`).
 *
 * Five seconds, matching `RelaySelection.choiceDeadline` in RelayiumKit. A
 * browser probe may take up to nine (see `measureRelay`), so a relay slower than
 * this is not considered — which is the deliberate trade: a peer waiting five
 * seconds for a straggler is a user watching a spinner, and the fallback it
 * lands on still relays.
 */
export const RELAY_GATE_MS = 5_000;

/**
 * The largest round trip anyone may claim, in milliseconds.
 *
 * Mirrors `RelayRttMessage.maxRttMs`. The bound is not about plausibility: a map
 * arrives over signalling and is therefore peer-authored, untrusted input, and
 * `Infinity`, `NaN` or `1e30` reaching arithmetic that compares and sums RTTs
 * produces a "choice" that is neither. Rejecting per entry rather than per map
 * keeps a mostly-usable map from a peer on a newer build.
 */
export const MAX_RTT_MS = 60_000;

/**
 * The largest number of relays a peer's map may name.
 *
 * A pool is single digits; the cap exists so a hostile peer cannot make this
 * page hold an unbounded object keyed by strings it chose. Over the cap the map
 * is rejected WHOLE rather than truncated: a truncated map is a different map,
 * and silently selecting from one is exactly the asymmetry the exchange exists
 * to remove.
 */
export const MAX_RTT_ENTRIES = 32;

/**
 * Validate a peer's relay-RTT payload.
 *
 * Returns null for anything that is not a map — which is every SDP, ICE
 * candidate, capability hello and rename that shares this envelope — rather than
 * an empty object, because an empty map would read as "the peer measured
 * nothing" and overwrite one that was good.
 *
 * Ids are used only as object keys and as `RelayEntry.id` comparisons. Nothing
 * here reaches the DOM, `eval`, a URL or a template, and the id a connection is
 * finally built from is looked up IN THE LOCAL POOL rather than taken from the
 * peer — so an id this client never advertised selects nothing.
 */
export function parseRelayRtt(data: unknown): Record<string, number> | null {
  if (!data || typeof data !== "object") return null;
  const map = (data as { relayRtt?: unknown }).relayRtt;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const entries = Object.entries(map as Record<string, unknown>);
  if (entries.length > MAX_RTT_ENTRIES) return null;
  const out: Record<string, number> = {};
  for (const [id, value] of entries) {
    if (typeof id !== "string" || id === "" || id.length > 64) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value < 0 || value > MAX_RTT_MS) continue;
    out[id] = Math.round(value);
  }
  return out;
}

export interface RelayGate {
  /** True when the RTC configuration may be snapshotted for a new connection. */
  ready(): boolean;
  /**
   * A peer exists: it is on the roster, it has announced, or a link with it is
   * being asked for right now. Starts that peer's bounded grace, which is the
   * ONLY thing that ever opens this gate without a peer map in hand.
   *
   * Never opens the gate synchronously, so a caller may note a peer and then
   * test `ready()` in the same turn without the answer changing under it.
   * Idempotent per peer: the retries a peer sends while it waits must not each
   * extend its own grace.
   */
  notePeer(peerId: string): void;
  /**
   * Run `cb` once, as soon as the gate is open — synchronously and immediately
   * when it already is, so a caller on a path that must not lose a frame can
   * check `ready()` first and stay in the same turn.
   */
  whenReady(cb: () => void): void;
}

/**
 * Which of the room's two wake-ups a timer is.
 *
 * `grace` is the bounded peer/fallback deadline — the one that opens the gate on
 * nothing when a peer never speaks. `dominance` is the early exit: the instant
 * at which our own unfinished probes can no longer beat the relay already
 * chosen (see `relayChoiceDominates`). They are separate slots, with separate
 * invalidation tokens, because they mean opposite things — one gives up, the
 * other stops waiting for an answer it already has — and because abandoning one
 * must not silently disarm the other.
 */
export type RelayTimerKind = "grace" | "dominance";

export interface RelaySelectionOptions {
  /** Broadcast this side's cumulative map. Called once per relay that answers. */
  publish: (map: Record<string, number>) => void;
  deadlineMs?: number;
  setTimer?: (cb: () => void, ms: number, kind: RelayTimerKind) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Monotonic elapsed-time source, in milliseconds.
   *
   * MUST be monotonic: it is what stands in for an unfinished probe's round trip
   * (`relayChoiceDominates`), where it is used as a LOWER bound — so the unsafe
   * direction is a clock that runs FAST. A wall clock stepped FORWARD (an NTP
   * correction, a user setting the date, a VM resuming) inflates elapsed past
   * the probe's real running time and retires a relay that could still win. A
   * backward step is the harmless one: elapsed shrinks, the bound gets weaker,
   * and the room waits longer than it strictly had to. `performance.now()` is
   * monotonic; `Date.now()` is not.
   */
  now?: () => number;
}

/**
 * One room's relay agreement.
 *
 * Every method is epoch-scoped through `reset`: a room switch supersedes the
 * maps, the choice, the deadline and every parked waiter in one call, so nothing
 * measured against one pairing code's credentials can select a relay in the
 * next one's.
 */
export function createRelaySelection(opts: RelaySelectionOptions) {
  const deadlineMs = opts.deadlineMs ?? RELAY_GATE_MS;
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
  const now = opts.now ?? (() => performance.now());

  let pool: RelayEntry[] = [];
  /** `pool`'s ids, which is what the dominance rule iterates. Derived once per
   *  room rather than per evaluation; the pool never changes within one. */
  let poolIds: string[] = [];
  /**
   * **The instant this room's probes are all known to have started**, on the
   * monotonic clock, or null before that is known.
   *
   * The FIRST `record` of the room, and deliberately not `reset`. The anchor
   * `relayChoiceDominates` needs is one at or after every pending probe's own
   * start, because elapsed time is being used as a LOWER bound on what those
   * probes will report; an anchor taken any earlier over-estimates that bound
   * and retires relays that can still win. `reset` is exactly such an earlier
   * anchor — `App.svelte` calls it before `measureRelays`, so an arbitrarily
   * long main-thread stall can sit between it and the first probe.
   *
   * A first result is the anchor instead because `measureRelays` starts every
   * probe in one synchronous job and cannot publish anything until that job has
   * ended; the proof is on `measureRelays`, and `ice.test.ts` pins it against a
   * stalled construction. What this costs is the time up to the first answer,
   * which is not credited to the bound — conservative, and in the shape this
   * exists for (one fast relay, one silent one) a few tens of milliseconds.
   *
   * Null therefore means "no sound bound yet", which is also exactly the state
   * in which `mine` is empty and no relay can have been chosen at all.
   */
  let probeAnchorMs: number | null = null;
  let mine: Record<string, number> = {};
  let theirs: Record<string, number> = {};
  /** Who `theirs` was learned from, so a room that loses every contributor stops
   *  offering a departed peer's map to the next one. */
  let contributors = new Set<string>();
  let selected: string | null = null;
  /** True once every probe has answered or timed out: `mine` can no longer grow. */
  let measured = false;
  let open = true;
  let waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The early-exit wake-up, held in its own slot. It coexists with the grace —
   *  a room routinely has both armed at once — so it cannot share `timer`, and
   *  it carries its own token so abandoning one never disarms the other. */
  let domTimer: ReturnType<typeof setTimeout> | undefined;
  /** `waitToken`'s counterpart for the dominance wake-up. Same job: a callback
   *  that was already in flight when its room was superseded must be able to
   *  recognise that, whether or not `clearTimer` also stopped it. */
  let domToken = 0;
  /** The peer whose grace is currently running, or null when nobody is here to
   *  wait for. A room with no peer waits indefinitely on purpose: there is no
   *  link to build and therefore nothing the fallback would unblock. */
  let gracePeer: string | null = null;
  /**
   * The peers this room's LAST roster frame named.
   *
   * The room's own record of who is here, and the only thing a departure can be
   * derived from when no `left` frame arrives — see `noteRoster`. Epoch-scoped
   * like everything else here: `reset` and `suspend` empty it, so a roster from
   * the previous code can never name a departure in the next one.
   */
  let roster = new Set<string>();
  /**
   * Identity of the deadline currently armed — bumped every time one is armed,
   * retargeted or abandoned, and captured by the parked callback so a superseded
   * one can recognise itself.
   *
   * The peer id alone cannot do this. A peer that leaves and comes straight back
   * under the SAME id abandons one grace and arms another, and the first
   * callback would then find its own id in `gracePeer` and open the gate on a
   * deadline that started before the departure — the stale release this whole
   * peer scoping exists to prevent, reached by the one route an id check cannot
   * see. Today `clearTimer` also happens to stop that callback ever running;
   * this makes the invariant hold whether or not it does, which is what a test
   * that fires an abandoned deadline directly can state.
   */
  let waitToken = 0;
  /**
   * Whether anything in this room has already been BUILT from what this gate
   * released.
   *
   * Set by `takeChoice`, which is the one read on the connection path: every
   * caller of `App.svelte`'s `rtcConfig()` passes the answer straight to a
   * transport constructor, so a read is a transport, and a transport is a
   * configuration this page is committed to for the life of that connection.
   *
   * The gate can therefore tell its two states apart, which is what a departure
   * turns on: a choice merely settled and standing open is state about links
   * that do not exist yet and may be taken back, while one a transport has
   * consumed may not — see `relock`. Room-scoped like everything else here.
   */
  let built = false;

  /**
   * Stop waiting, and make the wait that was running unrecognisable.
   *
   * Not merely cleared — INVALIDATED. Everything that abandons a deadline goes
   * through here, so no path can leave a parked callback that would still match
   * the room it wakes up in.
   */
  function abandonDeadline() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    waitToken += 1;
  }

  /** Start the one deadline this room may have, superseding any other. */
  function armDeadline(ms: number, onExpire: () => void) {
    abandonDeadline();
    const token = waitToken;
    timer = setTimer(() => {
      timer = undefined;
      // Superseded, abandoned, or armed again after a departure while this was
      // parked. Its expiry is not this room's answer, and whoever replaced it is
      // running its own full wait.
      if (waitToken !== token) return;
      onExpire();
    }, ms, "grace");
  }

  /**
   * Stop the early exit, and make the one that was running unrecognisable.
   *
   * The exact counterpart of `abandonDeadline`, on its own token: a room that
   * abandons a departed peer's grace has not learned anything about its own
   * probes, and a room whose choice changed has not learned anything about the
   * peer it is waiting for.
   */
  function abandonDominance() {
    if (domTimer !== undefined) clearTimer(domTimer);
    domTimer = undefined;
    domToken += 1;
  }

  /**
   * Whether our own unfinished probes can still change the choice.
   *
   * Null elapsed — no local result yet — is passed through as "no sound bound",
   * not as zero. See `probeAnchorMs`.
   */
  function dominant(): boolean {
    return relayChoiceDominates(
      selected, mine, theirs, poolIds,
      probeAnchorMs === null ? null : now() - probeAnchorMs,
    );
  }

  /**
   * Schedule the instant at which the early exit becomes true, if it is not
   * already and could still become so.
   *
   * Necessary because the rule turns true with the CLOCK rather than with an
   * event: a room whose peer has spoken and whose fast relay has answered gets
   * no further callback until the silent probe's nine-second timeout, and
   * waiting for that is the whole defect. Superseded on every re-derivation of
   * the choice, because the deadline it computes is a function of the pick's
   * worse leg, and that moves when the pick does.
   */
  function armDominance() {
    abandonDominance();
    if (open || measured || selected === null || probeAnchorMs === null) return;
    const worstLeg = Math.max(mine[selected], theirs[selected]);
    const delay = relayDominanceElapsedMs(worstLeg) - (now() - probeAnchorMs);
    // Not reachable while `dominant()` is false — the rule and this deadline are
    // the same inequality — but a caller-supplied clock is a caller-supplied
    // clock. Written as "not positive" rather than "at most zero" so a NaN
    // delay stops here too: a wake-up that re-arms itself on NaN forever is the
    // one failure mode a timer this file owns could actually spin on.
    if (!(delay > 0)) return;
    const token = domToken;
    domTimer = setTimer(() => {
      domTimer = undefined;
      if (domToken !== token) return; // superseded, or a room that has moved on
      if (settled()) release();
      // Woken early — only a hand-driven clock can do that — so re-arm on the
      // remainder rather than lose the exit until the next event.
      else armDominance();
    }, delay, "dominance");
  }

  /** Open the gate and run everything parked behind it, exactly once. */
  function release() {
    if (open) return;
    open = true;
    const parked = waiters;
    waiters = [];
    gracePeer = null;
    abandonDeadline();
    abandonDominance();
    for (const cb of parked) cb();
  }

  /**
   * The choice may be read once it can no longer change from THIS side: our own
   * measurement has finished and a common relay exists.
   *
   * Not "the first moment any relay is common to both maps". With both peers
   * still probing, each side's own increment beats the peer's matching broadcast
   * by one network delay, so each would evaluate its nearest relay against the
   * peer's older prefix — and the two then SWAP, picking each other's nearest,
   * which is the worst pair available. `RelayNegotiator` carries the same rule
   * for the same reason.
   */
  function settled(): boolean {
    if (selected === null) return false;
    // "Our own measurement has finished" is the sufficient condition, not the
    // necessary one. What actually matters is that no probe still running can
    // change the answer, and a probe that has been running longer than the
    // current pick's worse leg cannot — see `relayChoiceDominates`. Without
    // that, one silently dropped relay spends the whole nine-second probe
    // budget holding a choice the room already has, and the peer grace expires
    // first: five seconds of spinner for an answer that was ready in 200 ms.
    return measured || dominant();
  }

  function reselect() {
    selected = pickRelay(mine, theirs);
    if (settled()) release();
    // The choice moved, so the instant its worse leg retires every pending
    // probe moved with it. Recomputed rather than adjusted.
    else armDominance();
  }

  /**
   * **Close a gate that opened for a peer that has since gone, before anything
   * was built with it.**
   *
   * The gate opens once, and until this it stayed open for the rest of the room.
   * That is right for as long as the peer it opened for is here — the choice is
   * that peer's, and the link about to be built is with it — and wrong the
   * moment that peer leaves before any transport exists. The gate is then
   * standing open with nobody's map behind it, so the NEXT peer's first legal
   * `link/1` frame is built the instant it is wanted: on the departed peer's
   * relay, or on the fallback, before its own map can possibly arrive. It is the
   * same defect the peer-scoped grace closed at the front of a room, reached
   * from the one direction that grace cannot see — after the release.
   *
   * So the gate goes back to waiting and a replacement arms a full fresh grace,
   * exactly as the first peer did. `RelaySelection`/`LinkWorkspaceModel` carry
   * the same rule natively, because the two ends of a pairing must agree about
   * when a link may be built at all.
   *
   * ## The three states it leaves alone
   *
   *  - **A room with no pool**: nothing to choose, nothing to reopen. Every LAN
   *    room and every STUN-only code stays immediate.
   *  - **A choice a peer that is still here is contributing to.** A room that
   *    loses one of two contributors keeps the merged map and the choice made
   *    from it, which is the same answer merging has always given.
   *  - **A choice a transport has consumed** — see `built`. Its configuration is
   *    snapshotted inside a connection that exists; re-locking would be the gate
   *    reaching a transport rather than the builds ahead of it, and the page
   *    would hold frames for a link that is already up.
   */
  function relock() {
    if (!open || pool.length === 0 || built) return;
    if (contributors.size > 0) return;
    open = false;
    // `theirs` is empty whenever nothing is contributing one — `receive` is the
    // only writer and always records its sender — so the choice is already null
    // here. What is taken back is the PERMISSION, which is the whole of what an
    // open gate is.
    gracePeer = null;
    // Nothing is armed while the gate is open, so these arm nothing new; they
    // invalidate. A wake-up that fired in the same turn its owner was
    // superseded must not be able to recognise the room it wakes up in — and
    // that is as true of the early exit as of the grace, because a re-locked
    // gate is one whose choice was just unmade.
    abandonDeadline();
    abandonDominance();
    // A peer that is STILL here gets its own bounded grace rather than an
    // indefinite hold: the gate may have been opened by somebody else's elapsed
    // deadline, and nothing would arm a grace for this one until its next frame,
    // which may never come. Sorted, so the choice is the same on every run.
    const [next] = [...roster].sort();
    if (next) selection.notePeer(next);
  }

  // Named rather than returned inline so `gate.notePeer` can delegate to the
  // one implementation above it instead of being a second copy of the same
  // arming rules.
  const selection = {
    /** This side's map so far — cumulative, and only ever growing within a room. */
    get mine() { return mine; },
    get theirs() { return theirs; },
    /** The relay both peers agreed on, or null. A plain read: the debug panel's
     *  mirrors and the tests use it, and neither is building anything. */
    get selectedRelayId() { return selected; },

    /**
     * The relay both peers agreed on, read in order to BUILD with it.
     *
     * The one read on the connection path — `App.svelte`'s `rtcConfig()`, whose
     * every caller hands the answer straight to a transport constructor. It is
     * the same value `selectedRelayId` gives; what it adds is the record that
     * this room has now committed a connection to it, which is what stops a
     * later departure taking the gate back underneath a transport that exists.
     * See `built` and `relock`.
     */
    takeChoice(): string | null {
      built = true;
      return selected;
    },

    /**
     * A new room. Everything scoped to the old one goes, including its parked
     * waiters: they belong to a socket that no longer exists, and running them
     * would establish into a room this page has left.
     *
     * **Dropping a waiter is not settling it.** Whatever parked it is still
     * holding whatever it parked — a promise, an inbound offer — so the owner of
     * those has to be told the room ended BEFORE this is called. In this page
     * that is `workspace.resetRoom()`, which closes the link manager; see
     * `resetRelaySelection` in `App.svelte`.
     */
    reset(next: RelayEntry[]) {
      abandonDeadline();
      abandonDominance();
      waiters = [];
      pool = next;
      poolIds = next.map((r) => r.id);
      probeAnchorMs = null;
      mine = {};
      theirs = {};
      contributors = new Set();
      roster = new Set();
      selected = null;
      measured = false;
      gracePeer = null;
      built = false;
      // No pool is nothing to wait for, which is every LAN room and every
      // STUN-only code. Those must stay immediate.
      //
      // No deadline is armed here, and that is the correction this file carries:
      // the wait belongs to a peer, so `notePeer` arms it. A code room routinely
      // sits alone for minutes, and a deadline started at this line expires
      // while nobody is here to have answered it.
      open = next.length === 0;
    },

    /**
     * A peer is here — on the roster, announced, or named by a link intent.
     *
     * Arms that peer's bounded grace, once. A second call for the same peer is
     * inert (its request retries every three seconds, and each one must not push
     * its own deadline further out), and a call for a DIFFERENT peer supersedes
     * the old grace with a full fresh one, because the peer the old one was
     * waiting for is not the peer a link would now be built with.
     *
     * Deliberately never opens the gate in this call, even when the maps are
     * already in hand — they cannot be: a settled pair releases through
     * `reselect` the moment it settles, which requires a peer map, which
     * requires a peer. So `ready()` cannot change under a caller that notes a
     * peer and then tests it.
     */
    notePeer(peerId: string) {
      if (open || pool.length === 0 || !peerId) return;
      if (gracePeer === peerId) return;
      gracePeer = peerId;
      armDeadline(deadlineMs, release);
    },

    /**
     * The room's roster, exactly as the last frame named it.
     *
     * Returns the peers this room knew that the frame does NOT name — the
     * departures nothing else reports — after retiring each one through
     * `peerGone`. The caller owns the other half: an intent this page is holding
     * for a departed peer is the link manager's, not this file's.
     *
     * ## Why a roster removal is a departure here, and not everywhere
     *
     * `SignalingClient.onPeerLeft` documents the general rule: a roster id
     * changing by itself can be a harmless focus handoff between pages of the
     * same installation, whose socket and DataChannel are both still alive. That
     * rule is about the LAN room, and it stays true there — the hub only ever
     * substitutes one representative for another when the peers carry an
     * installation id, and `App` sends one only in the LAN room (`deviceId: () =>
     * (roomCode ? "" : lanDevice)`). A pairing-code room advertises no
     * installation, so no peer in it can be represented by another, and the hub
     * computes each roster from live membership at the instant it sends it.
     *
     * That is why this is scoped to a room with a POOL, which a LAN room never
     * has: no relays, nothing to agree on, nothing a departure would have to
     * retire — so LAN and the STUN-only deployment do not reach any of this.
     *
     * ## What counts as known, and what deliberately does not
     *
     * Only what a roster frame has itself named. A peer's RTT map arrives as a
     * `signal`, and the hub relays a signal and broadcasts a roster from two
     * different goroutines: a roster computed BEFORE that peer joined can still
     * be handed to this socket after its map. Letting a contributor be departed
     * by a roster that never knew it would let the older of the two frames
     * delete the newer one's evidence. Two roster frames racing each other are a
     * different matter — reordering them can only re-add a peer that is gone,
     * whose grace is bounded anyway, or drop one that is here, which closes the
     * gate rather than opening it early, and the next frame corrects both.
     *
     * A peer known only from a signal is not lost by this. The hub sends `left`
     * to every remaining peer of a code room — again because no installation id
     * means no sibling to withhold it from — and `peerGone` is the same call.
     */
    noteRoster(ids: string[]): string[] {
      // No pool is every LAN room, every STUN-only deployment, and the window
      // between `suspend` and the next `/api/ice` answer. None of them has a
      // relay to retire or a roster worth remembering.
      if (pool.length === 0) return [];
      const present = new Set(ids.filter((id) => id !== ""));
      // Sorted so the cleanup order is the same on every run.
      const departed = [...roster].filter((id) => !present.has(id)).sort();
      roster = present;
      for (const id of departed) selection.peerGone(id);
      return departed;
    },

    /**
     * A peer left the room.
     *
     * Its grace is abandoned rather than allowed to expire: opening the gate on
     * behalf of somebody who is gone would let the NEXT peer's first link frame
     * be built before that peer had any chance to send a map. The gate simply
     * goes back to waiting, and the next `notePeer` starts a full grace.
     *
     * Its map goes with it once nothing else is contributing one, for the same
     * reason: a fresh grace that is instantly satisfied by a departed peer's
     * measurements is not a grace at all.
     *
     * And an ALREADY OPEN gate goes with it too — see `relock`. Clearing the map
     * without that closed only half of the hole: the choice was unmade, but the
     * permission it had already been granted stood, so a replacement peer's first
     * legal frame went out with no wait at all.
     *
     * **The one departure path**, reached by a hub `left` frame and by a roster
     * that no longer names the peer alike. Idempotent, and has to be: both
     * signals arrive for an ordinary disconnect, in either order.
     */
    peerGone(peerId: string) {
      roster.delete(peerId);
      if (contributors.delete(peerId) && contributors.size === 0) {
        theirs = {};
        reselect();
      }
      if (gracePeer === peerId) {
        gracePeer = null;
        abandonDeadline();
      }
      relock();
    },

    /**
     * A room is ending and the next one's pool is not known yet.
     *
     * Distinct from `reset([])`, which would say "this room has no relays" and
     * open the gate — letting a link established in the window between the
     * switch and the new `/api/ice` answer commit to a configuration from
     * neither room. The gate closes here and the deadline is armed here, so a
     * configuration that never arrives at all costs the same bounded wait as one
     * that arrives slowly rather than stalling the page.
     */
    suspend() {
      waiters = [];
      pool = [];
      poolIds = [];
      probeAnchorMs = null;
      abandonDominance();
      mine = {};
      theirs = {};
      contributors = new Set();
      roster = new Set();
      selected = null;
      measured = false;
      built = false;
      open = false;
      // The one deadline that is NOT peer-scoped, and it is a different thing:
      // it bounds a configuration that may never arrive, not a peer that may
      // never speak. `notePeer` cannot touch it — an empty pool is not a room
      // whose peer is worth waiting for — and `reset` clears it as soon as the
      // next `/api/ice` answer lands.
      gracePeer = null;
      armDeadline(deadlineMs, release);
    },

    /**
     * One relay answered. Recorded, and the cumulative map is put on the wire
     * immediately — an incremental map is only useful to the peer if the peer
     * actually receives the increments.
     */
    record(id: string, rttMs: number) {
      if (!pool.some((r) => r.id === id)) return;
      // The first result of the room is the anchor every later elapsed reading
      // is taken from, because it is the earliest instant this file can prove is
      // at or after every probe's own start. See `probeAnchorMs`.
      if (probeAnchorMs === null) probeAnchorMs = now();
      mine = { ...mine, [id]: rttMs };
      opts.publish(mine);
      reselect();
    },

    /** Every probe has answered or timed out. `mine` can no longer grow. */
    finishMeasurement() {
      measured = true;
      reselect();
    },

    /**
     * A peer's map, MERGED rather than assigned.
     *
     * A native peer sends this several times as its own probes land, each send
     * carrying everything it has measured so far. Merging is what keeps a SHORT
     * message from undoing that: a peer that broadcasts genuine increments
     * rather than cumulative maps, or one whose sends crossed, can hand us fewer
     * entries than we already hold, and assigning wholesale would drop the rest
     * for the rest of the room. Nothing removes a relay from a peer's map
     * mid-room, so forgetting an entry is never correct.
     *
     * Answers whether the payload was a map at all, so the caller can tell a
     * consumed frame from one that still belongs to somebody else.
     */
    receive(from: string, data: unknown): boolean {
      const map = parseRelayRtt(data);
      if (!map) return false;
      contributors.add(from);
      theirs = { ...theirs, ...map };
      reselect();
      return true;
    },

    /** Re-broadcast to a peer that has just appeared, if there is anything to say. */
    greet() {
      if (Object.keys(mine).length === 0) return;
      opts.publish(mine);
    },

    /** The peer whose bounded grace is running, or null. Exposed for tests and
     *  for the debug panel; nothing on the connection path reads it. */
    get gracePeerId() { return gracePeer; },

    /** The gate `peer-link` holds its first legal frame behind. */
    gate: {
      ready: () => open,
      notePeer: (peerId: string) => { selection.notePeer(peerId); },
      whenReady(cb: () => void) {
        if (open) { cb(); return; }
        waiters.push(cb);
      },
    } satisfies RelayGate,
  };
  return selection;
}

export type RelaySelection = ReturnType<typeof createRelaySelection>;
