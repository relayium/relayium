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

/**
 * A selection with a hand-driven clock, so a deadline is a fact rather than a
 * wait.
 *
 * One slot, because the implementation holds at most one armed deadline: every
 * path that arms clears first. `armCount` is what makes "a fresh grace" testable
 * — a second peer must produce a SECOND arming, not inherit the first one's
 * remaining time.
 */
function harness(pool: RelayEntry[], deadlineMs = RELAY_GATE_MS) {
  const published: Record<string, number>[] = [];
  const timers: Array<{ cb: () => void; cleared: boolean; fired: boolean }> = [];
  const selection = createRelaySelection({
    publish: (map) => published.push({ ...map }),
    deadlineMs,
    setTimer: (cb) => {
      timers.push({ cb, cleared: false, fired: false });
      return (timers.length - 1) as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (handle) => {
      const t = timers[handle as unknown as number];
      if (t) t.cleared = true;
    },
  });
  selection.reset(pool);
  const liveIndex = () => timers.findIndex((t) => !t.cleared && !t.fired);
  return {
    selection, published,
    /** Run the deadline that is actually armed, if one is. */
    expire() {
      const i = liveIndex();
      if (i < 0) return;
      timers[i].fired = true;
      timers[i].cb();
    },
    /** Run a specific deadline's callback whether or not it was cleared — how a
     *  timer that fired in the same turn its owner was superseded behaves. */
    fireTimer(i: number) {
      const t = timers[i];
      if (!t) throw new Error(`no timer ${i}`);
      t.fired = true;
      t.cb();
    },
    get deadlineArmed() { return liveIndex() >= 0; },
    /** How many deadlines this room has ever armed. A second peer must produce a
     *  SECOND one rather than inherit the first's remaining time. */
    get armCount() { return timers.length; },
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
