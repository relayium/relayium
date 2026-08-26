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
 * How long a room waits for the two maps to meet before building on the
 * fallback instead.
 *
 * Counted from the moment the room STARTS measuring, not from the moment a link
 * is wanted: probing begins at room join and a peer typically arrives and
 * announces seconds later, so in the ordinary case the gate is already open and
 * costs nothing at all. Only a link asked for unusually early waits, and only
 * for the remainder.
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
  let selected: string | null = null;
  /** True once every probe has answered or timed out: `mine` can no longer grow. */
  let measured = false;
  let open = true;
  let waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearDeadline() {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  }

  /** Open the gate and run everything parked behind it, exactly once. */
  function release() {
    if (open) return;
    open = true;
    const parked = waiters;
    waiters = [];
    clearDeadline();
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

  return {
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
      clearDeadline();
      waiters = [];
      pool = next;
      mine = {};
      theirs = {};
      selected = null;
      measured = false;
      // No pool is nothing to wait for, which is every LAN room and every
      // STUN-only code. Those must stay immediate.
      open = next.length === 0;
      if (!open) timer = setTimer(() => { timer = undefined; release(); }, deadlineMs);
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
      clearDeadline();
      waiters = [];
      pool = [];
      mine = {};
      theirs = {};
      selected = null;
      measured = false;
      open = false;
      timer = setTimer(() => { timer = undefined; release(); }, deadlineMs);
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
    receive(data: unknown): boolean {
      const map = parseRelayRtt(data);
      if (!map) return false;
      theirs = { ...theirs, ...map };
      reselect();
      return true;
    },

    /** Re-broadcast to a peer that has just appeared, if there is anything to say. */
    greet() {
      if (Object.keys(mine).length === 0) return;
      opts.publish(mine);
    },

    /** The gate `peer-link` holds its first legal frame behind. */
    gate: {
      ready: () => open,
      whenReady(cb: () => void) {
        if (open) { cb(); return; }
        waiters.push(cb);
      },
    } satisfies RelayGate,
  };
}

export type RelaySelection = ReturnType<typeof createRelaySelection>;
