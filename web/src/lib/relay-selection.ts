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

import { pickRelay, type RelayEntry } from "./ice";

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

export interface RelaySelectionOptions {
  /** Broadcast this side's cumulative map. Called once per relay that answers. */
  publish: (map: Record<string, number>) => void;
  deadlineMs?: number;
  setTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
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

  let pool: RelayEntry[] = [];
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
    }, ms);
  }

  /** Open the gate and run everything parked behind it, exactly once. */
  function release() {
    if (open) return;
    open = true;
    const parked = waiters;
    waiters = [];
    gracePeer = null;
    abandonDeadline();
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
    return measured && selected !== null;
  }

  function reselect() {
    selected = pickRelay(mine, theirs);
    if (settled()) release();
  }

  // Named rather than returned inline so `gate.notePeer` can delegate to the
  // one implementation above it instead of being a second copy of the same
  // arming rules.
  const selection = {
    /** This side's map so far — cumulative, and only ever growing within a room. */
    get mine() { return mine; },
    get theirs() { return theirs; },
    /** The relay both peers agreed on, or null. */
    get selectedRelayId() { return selected; },

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
      waiters = [];
      pool = next;
      mine = {};
      theirs = {};
      contributors = new Set();
      roster = new Set();
      selected = null;
      measured = false;
      gracePeer = null;
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
      if (gracePeer !== peerId) return;
      gracePeer = null;
      abandonDeadline();
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
      mine = {};
      theirs = {};
      contributors = new Set();
      roster = new Set();
      selected = null;
      measured = false;
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
