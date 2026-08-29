import { describe, expect, it, vi } from "vitest";
import {
  MAX_RTT_ENTRIES, MAX_RTT_MS, RELAY_GATE_MS,
  createRelaySelection, parseRelayRtt,
} from "./relay-selection";
import type { RelayEntry } from "./ice";

const relay = (id: string): RelayEntry => ({
  id,
  iceServers: [{ urls: [`turn:${id}.example:3478`], username: `u-${id}`, credential: `c-${id}` }],
});

interface FakeTimer { cb: () => void; ms: number; cleared: boolean; fired: boolean }

/**
 * A selection with a hand-driven clock, so a deadline is a fact rather than a
 * wait.
 *
 * The room's two wake-ups are kept in two lists, exactly as the implementation
 * keeps them in two slots. `timers`/`expire`/`armCount` are the GRACE — the
 * bounded peer/fallback deadline — and mean what they always meant; the early
 * exit has its own `domTimers`/`fireDominance`/`domArmCount`, so a test can
 * state which of the two opened a gate rather than inferring it. `armCount` is
 * what makes "a fresh grace" testable: a second peer must produce a SECOND
 * arming, not inherit the first one's remaining time.
 *
 * The clock starts at zero and only `advance` moves it, so a room that never
 * touches it measures zero elapsed probe time — which is the state in which the
 * early exit can only be reached by evidence rather than by the clock.
 */
function harness(pool: RelayEntry[], deadlineMs = RELAY_GATE_MS) {
  const published: Record<string, number>[] = [];
  const timers: FakeTimer[] = [];
  const domTimers: FakeTimer[] = [];
  let clock = 0;
  // Grace handles are their plain index, so `fireTimer(0)` still names the
  // room's first grace; dominance handles are negative, which is what lets one
  // `clearTimer` serve both lists without either being able to clear the other.
  const selection = createRelaySelection({
    publish: (map) => published.push({ ...map }),
    deadlineMs,
    now: () => clock,
    setTimer: (cb, ms, kind) => {
      if (kind === "dominance") {
        domTimers.push({ cb, ms, cleared: false, fired: false });
        return -domTimers.length as unknown as ReturnType<typeof setTimeout>;
      }
      timers.push({ cb, ms, cleared: false, fired: false });
      return (timers.length - 1) as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      const h = handle as unknown as number;
      const t = h < 0 ? domTimers[-h - 1] : timers[h];
      if (t) t.cleared = true;
    },
  });
  selection.reset(pool);
  const liveIndex = () => timers.findIndex((t) => !t.cleared && !t.fired);
  const liveDom = () => domTimers.findIndex((t) => !t.cleared && !t.fired);
  return {
    selection, published,
    /** Run the grace deadline that is actually armed, if one is. */
    expire() {
      const i = liveIndex();
      if (i < 0) return;
      timers[i].fired = true;
      timers[i].cb();
    },
    /** Run a specific grace deadline's callback whether or not it was cleared —
     *  how a timer that fired in the same turn its owner was superseded
     *  behaves. */
    fireTimer(i: number) {
      const t = timers[i];
      if (!t) throw new Error(`no timer ${i}`);
      t.fired = true;
      t.cb();
    },
    get deadlineArmed() { return liveIndex() >= 0; },
    /** How many grace deadlines this room has ever armed. A second peer must
     *  produce a SECOND one rather than inherit the first's remaining time. */
    get armCount() { return timers.length; },

    /** Monotonic milliseconds since this room was created. */
    get nowMs() { return clock; },
    advance(ms: number) { clock += ms; },
    /** Run the early exit that is actually armed, if one is. */
    fireDominance() {
      const i = liveDom();
      if (i < 0) return;
      domTimers[i].fired = true;
      domTimers[i].cb();
    },
    /** Run a specific early exit whether or not it was cleared — a wake-up that
     *  was already in flight when its room was superseded. */
    fireDominanceTimer(i: number) {
      const t = domTimers[i];
      if (!t) throw new Error(`no dominance timer ${i}`);
      t.fired = true;
      t.cb();
    },
    get dominanceArmed() { return liveDom() >= 0; },
    /** The delay the armed early exit was asked for, which is what pins it to
     *  the pick's worse leg rather than to a constant. */
    get dominanceDelay() { const i = liveDom(); return i < 0 ? null : domTimers[i].ms; },
    get domArmCount() { return domTimers.length; },
  };
}

describe("relay-RTT payload validation", () => {
  it("takes only a well-formed map, and null for everything else on the envelope", () => {
    expect(parseRelayRtt({ relayRtt: { tok: 12 } })).toEqual({ tok: 12 });
    // Everything else that rides this envelope must read as "not a map" rather
    // than as an empty one, or it would overwrite a good map with nothing.
    expect(parseRelayRtt({ caps: ["link/1"] })).toBeNull();
    expect(parseRelayRtt({ sdp: { type: "offer" } })).toBeNull();
    expect(parseRelayRtt({ rename: "Phone" })).toBeNull();
    expect(parseRelayRtt(null)).toBeNull();
    expect(parseRelayRtt("relayRtt")).toBeNull();
    expect(parseRelayRtt({ relayRtt: [1, 2] })).toBeNull();
    expect(parseRelayRtt({ relayRtt: 5 })).toBeNull();
  });

  it("drops entries that are not finite, in range and string-keyed", () => {
    expect(parseRelayRtt({
      relayRtt: {
        ok: 30,
        inf: Infinity,
        nan: NaN,
        negative: -1,
        huge: MAX_RTT_MS + 1,
        stringy: "12",
        "": 5,
      },
    })).toEqual({ ok: 30 });
    expect(parseRelayRtt({ relayRtt: { edge: MAX_RTT_MS } })).toEqual({ edge: MAX_RTT_MS });
  });

  it("rejects an oversized map WHOLE rather than truncating it", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i <= MAX_RTT_ENTRIES; i++) big[`r${i}`] = i;
    expect(parseRelayRtt({ relayRtt: big })).toBeNull();
  });
});

describe("relay selection gate", () => {
  it("is open immediately with no pool, which is every LAN room", () => {
    const h = harness([]);
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.deadlineArmed).toBe(false);
    const run = vi.fn();
    h.selection.gate.whenReady(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds a waiter until this side has FINISHED measuring and a common relay exists", () => {
    const h = harness([relay("tok"), relay("fra")]);
    const run = vi.fn();
    h.selection.gate.whenReady(run);

    // A common relay exists already — but our own probes are still running, so
    // latching here would pick from a one-element intersection. Both peers doing
    // that is how the pair converges on each other's nearest relay, the worst
    // pair available.
    h.selection.record("tok", 40);
    h.selection.receive("peer", { relayRtt: { tok: 30, fra: 10 } });
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();

    h.selection.record("fra", 15);
    h.selection.finishMeasurement();
    expect(h.selection.gate.ready()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.selection.selectedRelayId).toBe("fra");
  });

  it("publishes the cumulative map once per relay that answers", () => {
    const h = harness([relay("tok"), relay("fra"), relay("iad")]);
    h.selection.record("tok", 10);
    h.selection.record("fra", 20);
    expect(h.published).toEqual([{ tok: 10 }, { tok: 10, fra: 20 }]);
    // A relay that never answers is never published and is therefore ineligible;
    // it must not hold the two that did.
    h.selection.finishMeasurement();
    expect(h.selection.mine).toEqual({ tok: 10, fra: 20 });
  });

  it("falls back at the bounded deadline for a peer that never sends a map", () => {
    const h = harness([relay("tok")]);
    const run = vi.fn();
    h.selection.gate.whenReady(run);
    h.selection.record("tok", 10);
    h.selection.finishMeasurement();
    h.selection.notePeer("peer");

    // Our own measurement is complete, but an older peer sends nothing at all,
    // so no choice can ever settle. Only that peer's grace ends this.
    expect(h.selection.gate.ready()).toBe(false);
    h.expire();
    expect(h.selection.gate.ready()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.selection.selectedRelayId).toBeNull();
  });

  /**
   * **The peerless room, which is the ordinary shape of a pairing code.**
   *
   * One side creates a code and waits — often for minutes — while the other
   * person types it. A deadline armed when measurement started has long since
   * expired by then, so the gate would be open, with no peer map in it, for
   * exactly the first legal `link/1` frame it exists to hold.
   */
  it("does not start any deadline while the room is empty, however long it measures", () => {
    const h = harness([relay("tok")]);
    const run = vi.fn();
    h.selection.gate.whenReady(run);
    h.selection.record("tok", 10);
    h.selection.finishMeasurement();

    // Nothing to expire: there is no peer, and therefore no link this could
    // unblock and nothing it could be waiting for.
    expect(h.deadlineArmed).toBe(false);
    expect(h.armCount).toBe(0);
    h.expire();
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();

    // The late peer arrives. NOW the grace starts, in full.
    h.selection.notePeer("late");
    expect(h.armCount).toBe(1);
    expect(h.selection.gracePeerId).toBe("late");
    expect(h.selection.gate.ready()).toBe(false);

    // Its capability hello lands before its map — a native peer sends caps
    // first, a browser sends the map first, and neither ordering may decide
    // this. Nothing but a map (or the grace) opens the gate.
    expect(h.selection.receive("late", { caps: ["link/1"] })).toBe(false);
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();

    h.selection.receive("late", { relayRtt: { tok: 20 } });
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("tok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("gives a map-less late peer a full fresh grace, then falls back", () => {
    const h = harness([relay("tok")]);
    h.selection.record("tok", 10);
    h.selection.finishMeasurement();
    const run = vi.fn();
    h.selection.gate.whenReady(run);

    h.selection.notePeer("old-build");
    // Its retries — a request every three seconds — must not each push its own
    // deadline further out.
    h.selection.notePeer("old-build");
    h.selection.notePeer("old-build");
    expect(h.armCount).toBe(1);

    expect(h.selection.gate.ready()).toBe(false);
    h.expire();
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("abandons a departed peer's grace and its map, and gives the next peer a full one", () => {
    const h = harness([relay("tok"), relay("fra")]);
    h.selection.record("tok", 10);
    h.selection.record("fra", 40);
    h.selection.finishMeasurement();

    h.selection.notePeer("first");
    h.selection.receive("first", { relayRtt: { fra: 5 } });
    expect(h.selection.selectedRelayId).toBe("fra");
    // Not settled into an OPEN gate here only because "fra" is common — it is,
    // so this room is already open. Prove the departure case on a room that is
    // still waiting instead.
    expect(h.selection.gate.ready()).toBe(true);

    const later = harness([relay("tok"), relay("fra")]);
    later.selection.record("tok", 10);
    later.selection.finishMeasurement();
    later.selection.notePeer("first");
    later.selection.receive("first", { relayRtt: { fra: 5 } }); // nothing in common
    expect(later.selection.gate.ready()).toBe(false);
    expect(later.armCount).toBe(1);

    later.selection.peerGone("first");
    expect(later.selection.gracePeerId).toBeNull();
    expect(later.selection.theirs).toEqual({});
    // Its deadline is abandoned rather than left to fire: an expiry on behalf of
    // somebody who has left would open the gate before the NEXT peer had any
    // chance to send a map.
    expect(later.deadlineArmed).toBe(false);
    later.expire();
    expect(later.selection.gate.ready()).toBe(false);

    const run = vi.fn();
    later.selection.gate.whenReady(run);
    later.selection.notePeer("second");
    expect(later.armCount).toBe(2);
    expect(run).not.toHaveBeenCalled();
    later.selection.receive("second", { relayRtt: { tok: 12 } });
    expect(later.selection.gate.ready()).toBe(true);
    expect(later.selection.selectedRelayId).toBe("tok");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cannot be released by a peer that was superseded while its grace ran", () => {
    const h = harness([relay("tok")]);
    h.selection.record("tok", 10);
    h.selection.finishMeasurement();
    const run = vi.fn();
    h.selection.gate.whenReady(run);

    h.selection.notePeer("first");
    h.selection.notePeer("second");
    expect(h.armCount).toBe(2);
    expect(h.selection.gracePeerId).toBe("second");

    // The first peer's deadline was cleared, and would also be inert if it fired
    // anyway — a timer whose owner was superseded in the same turn. It answers
    // for "first", and "first" is not who this room is waiting for.
    h.fireTimer(0);
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();

    // The peer actually being waited for still ends it.
    h.expire();
    expect(h.selection.gate.ready()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cannot be released by a grace that a room switch left behind", () => {
    const h = harness([relay("tok")]);
    h.selection.record("tok", 10);
    h.selection.finishMeasurement();
    h.selection.notePeer("first");
    expect(h.armCount).toBe(1);

    // The page moves to another code. Everything scoped to the old room goes,
    // including the peer its grace was running for.
    h.selection.suspend();
    h.selection.reset([relay("fra")]);
    expect(h.selection.gracePeerId).toBeNull();
    const run = vi.fn();
    h.selection.gate.whenReady(run);

    h.fireTimer(0); // the departed room's grace, arriving late
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("wakes every waiter exactly once, whichever of settle and deadline wins", () => {
    const h = harness([relay("tok")]);
    const first = vi.fn();
    const second = vi.fn();
    h.selection.gate.whenReady(first);
    h.selection.gate.whenReady(second);

    h.selection.record("tok", 10);
    h.selection.receive("peer", { relayRtt: { tok: 20 } });
    h.selection.finishMeasurement();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // The deadline losing the race must be inert, not a second wake.
    h.expire();
    h.selection.receive("peer", { relayRtt: { tok: 5 } });
    h.selection.finishMeasurement();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("merges a peer's map rather than assigning it", () => {
    const h = harness([relay("tok"), relay("fra")]);
    h.selection.receive("peer", { relayRtt: { tok: 30, fra: 40 } });
    // A later, SHORTER message — a peer broadcasting genuine increments, or two
    // sends that crossed — must not drop what we already hold.
    h.selection.receive("peer", { relayRtt: { fra: 20 } });
    expect(h.selection.theirs).toEqual({ tok: 30, fra: 20 });
  });

  it("ignores a relay this room's pool does not contain", () => {
    const h = harness([relay("tok")]);
    h.selection.record("ghost", 1);
    expect(h.selection.mine).toEqual({});
    expect(h.published).toEqual([]);
  });

  it("carries nothing across a room switch, and holds the gate until the next pool is known", () => {
    const h = harness([relay("tok")]);
    h.selection.record("tok", 5);
    h.selection.receive("peer", { relayRtt: { tok: 5 } });
    h.selection.finishMeasurement();
    expect(h.selection.selectedRelayId).toBe("tok");

    // The room is ending and the next `/api/ice` answer has not arrived. Saying
    // "no relays" here would open the gate for a window in which a link could
    // commit to a configuration belonging to neither room.
    const stale = vi.fn();
    h.selection.suspend();
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.selection.selectedRelayId).toBeNull();
    expect(h.selection.mine).toEqual({});
    expect(h.selection.theirs).toEqual({});

    // A waiter from the OLD room is dropped rather than run: it belongs to a
    // socket that no longer exists.
    h.selection.gate.whenReady(stale);
    h.selection.reset([relay("fra")]);
    h.selection.record("fra", 8);
    h.selection.receive("peer", { relayRtt: { fra: 9 } });
    h.selection.finishMeasurement();
    expect(stale).not.toHaveBeenCalled();
    expect(h.selection.selectedRelayId).toBe("fra");
  });

  it("bounds a suspended room too, so a configuration that never arrives cannot stall the page", () => {
    const h = harness([relay("tok")]);
    h.selection.suspend();
    const run = vi.fn();
    h.selection.gate.whenReady(run);
    expect(run).not.toHaveBeenCalled();
    h.expire();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("greets a peer with what has been measured so far, and says nothing when that is nothing", () => {
    const h = harness([relay("tok")]);
    h.selection.greet();
    expect(h.published).toEqual([]);
    h.selection.record("tok", 11);
    h.selection.greet();
    expect(h.published).toEqual([{ tok: 11 }, { tok: 11 }]);
  });
});

/**
 * A roster that no longer names a peer is a departure too.
 *
 * The hub sends `left` for a physical disconnect, but this page can miss one —
 * its own socket drops, and the roster it is handed on reconnect is the first
 * and last word on who went while it was away. Before this, `onPeers` only ever
 * ARMED: the departed peer's measurements stayed merged in the room, so the
 * replacement's supposedly fresh grace found a choice already waiting for it and
 * built its link on a relay chosen by somebody who was no longer there.
 */
/**
 * **The early exit: a silent relay must not hold a choice the room already has.**
 *
 * A browser probe runs for nine seconds before it gives up, and the gate's peer
 * grace is five — so one advertised relay that drops packets silently used to
 * cost every pairing the whole five seconds and then open on the FALLBACK,
 * with a perfectly good common relay sitting in both maps the entire time. That
 * is the production shape a dead relay in the pool produced.
 *
 * What retires the silent probe is arithmetic, not a guess: it has been running
 * for the elapsed time, so it cannot report less, and a relay that cannot report
 * less than the current pick's worse leg cannot become the pick.
 */
describe("the relay gate, when a probe is still running", () => {
  it("opens on a fast common relay in well under a second while a nine-second probe stays silent", () => {
    const h = harness([relay("fast"), relay("dead")]);
    const run = vi.fn();
    h.selection.gate.whenReady(run);
    h.selection.notePeer("peer");
    expect(h.armCount).toBe(1); // the five-second grace, armed and never fired

    // 30 ms in, the near relay answers and the peer's map is already here.
    h.advance(30);
    h.selection.record("fast", 30);
    h.selection.receive("peer", { relayRtt: { fast: 40 } });
    expect(h.selection.gate.ready()).toBe(false);
    // The wake-up is one millisecond past the pick's worse leg — 40 — measured
    // from the first result, not a constant and not the grace.
    expect(h.dominanceDelay).toBe(41);

    h.advance(41);
    h.fireDominance();
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("fast");
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.nowMs).toBeLessThan(1_000);
    // The grace neither fired nor opened anything, and nothing waits on the
    // silent probe's nine-second timeout.
    expect(h.deadlineArmed).toBe(false); // release abandons it
    expect(h.armCount).toBe(1);
  });

  /**
   * **Elapsed time is counted from the first RESULT, never from `reset`.**
   *
   * `App.svelte` calls `reset` and then `measureRelays`, so an arbitrarily long
   * main-thread stall can sit between the two. Anchoring on `reset` would credit
   * that stall to probes that had not started, which over-estimates the one
   * quantity the rule uses as a LOWER bound — and retires relays that can still
   * win. A first result is the earliest instant every probe is known to have
   * started; see `measureRelays`.
   *
   * Five seconds of stall here: an anchor at `reset` would have opened this gate
   * immediately, on a probe that had been running for nothing at all.
   */
  it("measures a probe's elapsed time from the first result, not from the room's reset", () => {
    const h = harness([relay("fast"), relay("dead")]);
    h.selection.notePeer("peer");
    h.advance(5_000); // the stall a reset anchor would have charged to the probes

    h.selection.record("fast", 30);
    h.selection.receive("peer", { relayRtt: { fast: 40 } });
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.dominanceDelay).toBe(41);

    h.advance(40);
    h.fireDominance();
    expect(h.selection.gate.ready()).toBe(false);
    h.advance(1);
    h.fireDominance();
    expect(h.selection.gate.ready()).toBe(true);
  });

  /**
   * Equality is not domination: a pending relay that ties on the worse leg still
   * goes to `pickRelay`'s sum and then to its id, either of which can hand it
   * the room. Retiring a candidate that could tie is retiring one that could
   * win, and the two peers would then disagree.
   */
  it("keeps waiting at exactly the pick's worse leg, and stops one millisecond later", () => {
    const h = harness([relay("a"), relay("b")]);
    h.selection.notePeer("peer");
    h.selection.record("a", 40);
    h.selection.receive("peer", { relayRtt: { a: 40 } });

    h.advance(40);
    h.fireDominance();
    expect(h.selection.gate.ready()).toBe(false);
    // Woken early, the exit re-arms on the remainder rather than being lost.
    expect(h.dominanceDelay).toBe(1);

    h.advance(1);
    h.fireDominance();
    expect(h.selection.gate.ready()).toBe(true);
  });

  /** The half the equality rule protects: `b` ties on the worse leg and takes
   *  the room on the sum. Retiring it at equality would have chosen `a` here,
   *  while a peer that waited chose `b`. */
  it("lets a pending relay that ties on the worse leg still take the room", () => {
    const h = harness([relay("a"), relay("b")]);
    h.selection.notePeer("peer");
    h.selection.record("a", 40);
    h.selection.receive("peer", { relayRtt: { a: 40, b: 10 } });
    h.advance(40);
    h.fireDominance();
    expect(h.selection.gate.ready()).toBe(false);

    h.selection.record("b", 40); // max(40,10)=40, sum 50 < 80 → b
    h.selection.finishMeasurement();
    expect(h.selection.selectedRelayId).toBe("b");
  });

  it("keeps waiting for a pending relay that can still beat the pick", () => {
    const h = harness([relay("tok"), relay("fra")]);
    h.selection.notePeer("peer");
    h.selection.record("tok", 400);
    h.selection.receive("peer", { relayRtt: { tok: 400, fra: 10 } });
    // Far from the bound: `fra` has been running 399 ms, and a 399 ms round trip
    // still beats max(400, 400).
    h.advance(399);
    h.fireDominance();
    expect(h.selection.gate.ready()).toBe(false);
    h.selection.record("fra", 399);
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("fra");
  });

  /**
   * The clock is not the only way a probe stops mattering. If the PEER has
   * already measured a relay and found it worse than the pick's worse leg, then
   * the worse of the two legs is worse whatever our own probe reports — so it is
   * retired with no elapsed time at all, and no wake-up is scheduled.
   */
  it("retires a pending relay on the peer's leg alone, with no clock and no timer", () => {
    const h = harness([relay("fast"), relay("far")]);
    const run = vi.fn();
    h.selection.gate.whenReady(run);
    h.selection.notePeer("peer");
    h.selection.record("fast", 30);
    h.selection.receive("peer", { relayRtt: { fast: 20, far: 900 } });

    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("fast");
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.nowMs).toBe(0);
    expect(h.domArmCount).toBe(0);
  });

  /** Every relay in the pool has answered, so `mine` cannot grow: the room does
   *  not need `finishMeasurement` to tell it that, and waiting for the probe
   *  machinery to unwind is waiting for nothing. */
  it("opens once every relay in the pool has answered, without waiting to be told measurement finished", () => {
    const h = harness([relay("a"), relay("b")]);
    h.selection.notePeer("peer");
    h.selection.record("a", 10);
    h.selection.record("b", 90);
    h.selection.receive("peer", { relayRtt: { a: 15, b: 400 } });
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("a");
  });

  it("cannot be opened by an early exit the room switch left behind", () => {
    const h = harness([relay("fast"), relay("dead")]);
    h.selection.notePeer("peer");
    h.selection.record("fast", 30);
    h.selection.receive("peer", { relayRtt: { fast: 40 } });
    expect(h.domArmCount).toBe(1);

    h.selection.reset([relay("other"), relay("dead")]);
    h.selection.notePeer("peer");
    h.advance(10_000);
    // The previous room's wake-up, arriving in the next one — and its elapsed
    // reading would be true of a room that no longer exists.
    h.fireDominanceTimer(0);
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.selection.selectedRelayId).toBeNull();
  });

  it("cannot be opened by an early exit a suspend left behind", () => {
    const h = harness([relay("fast"), relay("dead")]);
    h.selection.notePeer("peer");
    h.selection.record("fast", 30);
    h.selection.receive("peer", { relayRtt: { fast: 40 } });

    h.selection.suspend();
    h.advance(10_000);
    h.fireDominanceTimer(0);
    expect(h.selection.gate.ready()).toBe(false);
  });

  /**
   * A departure unmakes the choice the early exit was armed for, and the
   * wake-up that was already in flight must not open the gate for the peer that
   * replaces it. Same rule as the grace, on its own token — see `relock`.
   */
  it("cannot be opened by an early exit a departure left behind", () => {
    const h = harness([relay("fast"), relay("dead")]);
    h.selection.noteRoster(["first"]);
    h.selection.notePeer("first");
    h.selection.record("fast", 30);
    h.selection.receive("first", { relayRtt: { fast: 40 } });
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.domArmCount).toBe(1);

    h.selection.peerGone("first");
    h.selection.notePeer("second");
    h.advance(41);
    // The departed peer's wake-up, arriving after the departure re-locked the
    // gate. Its elapsed reading is still true of our own probes — the room did
    // not restart them — but the choice it was armed for no longer exists, and
    // an invalidated wake-up must not act on that.
    h.fireDominanceTimer(0);
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.selection.selectedRelayId).toBeNull();
    // What ends the replacement's wait is its OWN map, evaluated against a
    // local measurement that is by now genuinely settled — or its own full
    // fresh grace, which is still armed and still five seconds.
    expect(h.armCount).toBe(2);
    h.selection.receive("second", { relayRtt: { fast: 40 } });
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("fast");
  });

  /** A peer that sends nothing at all still costs exactly the bounded grace —
   *  the early exit has no choice to be early about, so it changes nothing. */
  it("leaves the map-less fallback exactly as it was", () => {
    const h = harness([relay("fast"), relay("dead")]);
    h.selection.notePeer("peer");
    h.selection.record("fast", 30);
    h.advance(10_000);
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.dominanceArmed).toBe(false); // nothing chosen, nothing to be early about
    h.expire();
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBeNull();
  });

  /**
   * A peer's cumulative map can arrive out of order, and `receive` merges rather
   * than assigns. What must not happen is an early exit surviving a re-derived
   * choice: the wake-up is a function of the pick's worse leg, so a new map
   * supersedes it rather than adding to it.
   */
  it("re-derives the early exit when a peer's map moves the choice", () => {
    const h = harness([relay("a"), relay("b"), relay("dead")]);
    h.selection.notePeer("peer");
    h.selection.record("a", 30);
    h.selection.record("b", 300);
    h.selection.receive("peer", { relayRtt: { a: 500 } });
    expect(h.dominanceDelay).toBe(501); // pick a, worse leg 500

    h.selection.receive("peer", { relayRtt: { a: 20, b: 310 } });
    expect(h.selection.selectedRelayId).toBe("a");
    expect(h.dominanceDelay).toBe(31); // worse leg is now 30
    expect(h.domArmCount).toBe(2);

    h.advance(31);
    h.fireDominance();
    expect(h.selection.gate.ready()).toBe(true);
  });
});

describe("the relay gate, when a roster stops naming a peer", () => {
  /**
   * The ordinary first seconds of a room: one relay has answered and another is
   * still being probed, so a choice can EXIST without being settled.
   *
   * That window is the only place a peer's measurements sit on record with the
   * gate still shut — which is exactly the state a departure has to clear, and
   * the state the replacement peer arrives into.
   */
  function midProbe() {
    const h = harness([relay("tok"), relay("fra")]);
    h.selection.record("tok", 10); // …and "fra" has not answered yet
    h.selection.noteRoster(["first"]);
    h.selection.notePeer("first");
    h.selection.receive("first", { relayRtt: { tok: 200 } });
    expect(h.selection.selectedRelayId).toBe("tok"); // a choice, but not a settled one
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.armCount).toBe(1);
    return h;
  }

  it("takes the departed peer's map with it, not merely its grace", () => {
    const h = midProbe();

    expect(h.selection.noteRoster([])).toEqual(["first"]);
    expect(h.selection.theirs).toEqual({});
    expect(h.selection.selectedRelayId).toBeNull();
    // Its deadline is abandoned rather than left to fire: an expiry on behalf of
    // somebody who has left would open the gate before the next peer had any
    // chance to send a map.
    expect(h.selection.gracePeerId).toBeNull();
    expect(h.deadlineArmed).toBe(false);

    // An empty room waits indefinitely on purpose — there is no link to build.
    const run = vi.fn();
    h.selection.gate.whenReady(run);
    h.selection.record("fra", 20);
    h.selection.finishMeasurement();
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("gives a different replacement peer a full grace that only its own map can end", () => {
    const h = midProbe();

    // One frame carrying both halves, which is what a replacement looks like.
    expect(h.selection.noteRoster(["second"])).toEqual(["first"]);
    h.selection.notePeer("second");
    // A SECOND arming, not the remainder of the first peer's.
    expect(h.armCount).toBe(2);
    expect(h.selection.gracePeerId).toBe("second");

    const run = vi.fn();
    h.selection.gate.whenReady(run);

    // Our own probes finish. This is the pre-fix release: with "first"'s numbers
    // still merged, `finishMeasurement` settled the room on them and opened the
    // gate with "second" never having spoken — and "second"'s link was then built
    // on a relay chosen by a peer who had left.
    h.selection.record("fra", 20);
    h.selection.finishMeasurement();
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();

    h.selection.receive("second", { relayRtt: { fra: 9 } });
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("fra");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("will not let a rejoined same id be released by the wait it abandoned", () => {
    const h = harness([relay("tok")]);
    h.selection.record("tok", 10);
    h.selection.finishMeasurement();
    h.selection.noteRoster(["a"]);
    h.selection.notePeer("a");
    expect(h.armCount).toBe(1);

    // "a" drops out of the roster and comes straight back under the same id.
    expect(h.selection.noteRoster([])).toEqual(["a"]);
    expect(h.selection.gracePeerId).toBeNull();
    expect(h.selection.noteRoster(["a"])).toEqual([]);
    h.selection.notePeer("a");
    expect(h.armCount).toBe(2);
    expect(h.selection.gracePeerId).toBe("a");

    const run = vi.fn();
    h.selection.gate.whenReady(run);

    // The FIRST wait, arriving late. Its peer id matches the peer being waited
    // for again — which is the whole trap an id check cannot see — and it must
    // still be inert, because the deadline it is answering for started before
    // the departure.
    h.fireTimer(0);
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();

    // The rejoin's own grace is what ends the wait.
    h.expire();
    expect(h.selection.gate.ready()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is idempotent with an explicit left, in either order", () => {
    const first = midProbe();
    first.selection.peerGone("first"); // the hub's `left` frame
    expect(first.selection.theirs).toEqual({});
    expect(first.selection.gracePeerId).toBeNull();
    const armed = first.armCount;
    // …and the roster that follows it. Nothing left to retire, and nothing
    // reported to the caller a second time — the link manager's half of the
    // cleanup has already run for this peer.
    expect(first.selection.noteRoster([])).toEqual([]);
    expect(first.armCount).toBe(armed);

    // The other order, which is just as ordinary: the roster beats the frame.
    const second = midProbe();
    expect(second.selection.noteRoster([])).toEqual(["first"]);
    const alsoArmed = second.armCount;
    second.selection.peerGone("first");
    expect(second.selection.theirs).toEqual({});
    expect(second.selection.gracePeerId).toBeNull();
    expect(second.armCount).toBe(alsoArmed);
    expect(second.selection.gate.ready()).toBe(false);
  });

  it("will not let a roster retire a peer it never named itself", () => {
    const h = harness([relay("tok")]);
    h.selection.record("tok", 10);
    // A map from a peer this roster has not caught up with. The hub relays a
    // signal and broadcasts a roster from two different goroutines, so a roster
    // computed before that peer joined can still reach this socket behind its
    // map — and the older of the two frames must not delete the newer's
    // evidence. A departure this misses is still reported by `left`.
    h.selection.receive("late", { relayRtt: { tok: 30 } });
    expect(h.selection.noteRoster([])).toEqual([]);
    expect(h.selection.theirs).toEqual({ tok: 30 });
  });

  it("does nothing at all in a room with no relay pool", () => {
    // Every LAN room and every STUN-only deployment. There is no relay to agree
    // on, so the gate is open from the start and a departure has nothing to
    // retire — which is what keeps the representative handoff
    // `SignalingClient.onPeerLeft` describes, where a roster id changes while
    // the socket and DataChannel live on, out of all of this.
    const h = harness([]);
    expect(h.selection.gate.ready()).toBe(true);
    h.selection.receive("lan-a", { relayRtt: { tok: 5 } });
    expect(h.selection.noteRoster(["lan-a"])).toEqual([]);
    expect(h.selection.noteRoster(["lan-b"])).toEqual([]); // the handoff
    expect(h.selection.noteRoster([])).toEqual([]);
    expect(h.selection.theirs).toEqual({ tok: 5 });
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.armCount).toBe(0);
  });

  it("carries no roster across a room switch", () => {
    const h = midProbe();

    // The page moves to another code. The suspended window has no pool, so a
    // roster arriving in it is not this room's to diff either.
    h.selection.suspend();
    expect(h.selection.noteRoster([])).toEqual([]);
    h.selection.reset([relay("fra")]);

    // The new room starts with no roster of its own, so its first frame is pure
    // arrival: nobody from the old room can be reported departed in it.
    expect(h.selection.noteRoster(["second"])).toEqual([]);
    h.selection.notePeer("second");
    const run = vi.fn();
    h.selection.gate.whenReady(run);

    // The old room's grace, arriving late, and now also the old room's roster.
    h.fireTimer(0);
    expect(h.selection.gate.ready()).toBe(false);
    expect(run).not.toHaveBeenCalled();

    // …and the new room's own roster still reports its own departures.
    expect(h.selection.noteRoster([])).toEqual(["second"]);
    expect(h.selection.gracePeerId).toBeNull();
  });
});

describe("the relay gate, when the peer it had already opened for leaves", () => {
  /**
   * A gate that has FULLY SETTLED and opened, with nothing built on it yet.
   *
   * Our own probes have finished and the peer's map named a relay both sides
   * measured, so the choice can no longer change from here and the gate released
   * on it. Nothing has asked for a link, so no transport exists — which is the
   * whole window: the decision is made, and the connection it was made for does
   * not exist.
   *
   * `tok` is what these two maps agree on; a replacement below chooses `fra`, so
   * which peer decided is never ambiguous.
   */
  function settledOpenGate() {
    const h = harness([relay("tok"), relay("fra")]);
    h.selection.noteRoster(["first"]);
    h.selection.notePeer("first");
    h.selection.record("tok", 10);
    h.selection.record("fra", 90);
    h.selection.receive("first", { relayRtt: { tok: 15, fra: 400 } });
    h.selection.finishMeasurement();
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("tok");
    expect(h.armCount).toBe(1);
    return h;
  }

  /**
   * **The hole this section closes.**
   *
   * Clearing the departed peer's map unmade the CHOICE, and stopped there. The
   * PERMISSION it had already been granted stood: the gate was open, so the
   * replacement's first legal `link/1` frame went out with no wait at all — on
   * the fallback, or on the relay the departed peer had chosen, before its own
   * map could arrive.
   */
  it("re-locks for an explicit left, and the replacement gets a full fresh grace", () => {
    const h = settledOpenGate();

    h.selection.peerGone("first");
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.selection.selectedRelayId).toBeNull();
    // An empty room waits indefinitely, exactly as it does before any peer has
    // ever arrived: there is no link to build.
    expect(h.selection.gracePeerId).toBeNull();
    expect(h.deadlineArmed).toBe(false);

    const run = vi.fn();
    h.selection.gate.whenReady(run);
    h.selection.notePeer("second");
    // A SECOND arming, not the remains of the first peer's.
    expect(h.armCount).toBe(2);
    expect(h.selection.gracePeerId).toBe("second");
    expect(run).not.toHaveBeenCalled();

    h.selection.receive("second", { relayRtt: { fra: 4 } });
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("fra");
    expect(run).toHaveBeenCalledTimes(1);
  });

  /** The same hole through the departure the hub may send no `left` for. */
  it("re-locks for a roster-only departure, and arms the replacement in the same frame", () => {
    const h = settledOpenGate();

    // One frame carrying both halves, which is what a replacement looks like.
    expect(h.selection.noteRoster(["second"])).toEqual(["first"]);
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.selection.selectedRelayId).toBeNull();
    // The peer the same frame DID name is already being waited for: a gate that
    // re-locks with somebody in the room must not wait for a frame that may
    // never come.
    expect(h.selection.gracePeerId).toBe("second");
    expect(h.armCount).toBe(2);

    // App's own `notePeer` for the arrival is then idempotent, as it is
    // everywhere else: one grace for this peer, not one per signal.
    h.selection.notePeer("second");
    expect(h.armCount).toBe(2);

    const run = vi.fn();
    h.selection.gate.whenReady(run);
    expect(run).not.toHaveBeenCalled();

    h.selection.receive("second", { relayRtt: { fra: 4 } });
    expect(h.selection.selectedRelayId).toBe("fra");
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * **A replacement that never sends a map waits out its own deadline.**
   *
   * The re-locked gate is bounded by the same rule as the first one, or closing
   * it would trade a link on the wrong relay for a link that is never built.
   */
  it("bounds the re-locked gate by the replacement's own deadline", () => {
    const h = settledOpenGate();
    h.selection.peerGone("first");
    h.selection.notePeer("second");

    const run = vi.fn();
    h.selection.gate.whenReady(run);
    expect(run).not.toHaveBeenCalled();

    h.expire();
    expect(h.selection.gate.ready()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.selection.selectedRelayId).toBeNull(); // the fallback, not a stale choice
  });

  /**
   * **The gate may not reach a transport that already exists.**
   *
   * `takeChoice` is the read on the connection path, so this is a page that has
   * built a connection on the agreed relay. Its configuration is snapshotted
   * inside that connection for its whole life; re-locking afterwards would hold
   * frames for a link that is already up, which is the one thing a gate about
   * future builds must never do.
   */
  it("will not re-lock a choice a transport has already been built on", () => {
    const h = settledOpenGate();
    expect(h.selection.takeChoice()).toBe("tok");

    expect(h.selection.noteRoster([])).toEqual(["first"]);
    expect(h.selection.gate.ready()).toBe(true);
    const run = vi.fn();
    h.selection.gate.whenReady(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * A gate can be open on one peer's ELAPSED deadline while another sits in the
   * room having sent nothing. Re-locking on the first one's departure must give
   * that peer a grace rather than an indefinite hold: nothing else would arm one
   * until its next frame, and a peer with no map has no reason to send another.
   */
  it("gives a peer that is still in the room its own grace rather than an indefinite hold", () => {
    const h = harness([relay("tok")]);
    h.selection.noteRoster(["first", "second"]);
    h.selection.notePeer("first");
    h.selection.record("tok", 10);
    h.selection.finishMeasurement();
    expect(h.selection.gate.ready()).toBe(false);

    h.expire(); // a map-less peer's answer: the bounded fallback
    expect(h.selection.gate.ready()).toBe(true);

    h.selection.peerGone("first");
    expect(h.selection.gate.ready()).toBe(false);
    expect(h.selection.gracePeerId).toBe("second");
    expect(h.armCount).toBe(2);

    h.expire();
    expect(h.selection.gate.ready()).toBe(true);
  });

  /** Both departure signals arrive for an ordinary disconnect, in either order.
   *  The second must find nothing left to do rather than re-lock a second time
   *  or restart the replacement's grace. */
  it("is idempotent across an explicit left and the roster that follows it", () => {
    const h = settledOpenGate();

    h.selection.peerGone("first");
    expect(h.selection.noteRoster([])).toEqual([]);
    expect(h.selection.gate.ready()).toBe(false);

    h.selection.notePeer("second");
    h.selection.notePeer("second");
    expect(h.armCount).toBe(2);

    h.selection.receive("second", { relayRtt: { fra: 4 } });
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.selection.selectedRelayId).toBe("fra");
  });

  /** No pool is nothing to agree on, so there is nothing to re-lock either: LAN
   *  and every STUN-only code stay immediate through a departure. */
  it("does nothing at all in a room with no relay pool", () => {
    const h = harness([]);
    h.selection.noteRoster(["first"]);
    h.selection.notePeer("first");
    expect(h.selection.gate.ready()).toBe(true);

    h.selection.peerGone("first");
    h.selection.noteRoster([]);
    expect(h.selection.gate.ready()).toBe(true);
    expect(h.armCount).toBe(0);
  });
});
