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

/** A selection with a hand-driven clock, so a deadline is a fact rather than a wait. */
function harness(pool: RelayEntry[], deadlineMs = RELAY_GATE_MS) {
  const published: Record<string, number>[] = [];
  let fire: (() => void) | null = null;
  const selection = createRelaySelection({
    publish: (map) => published.push({ ...map }),
    deadlineMs,
    setTimer: (cb) => { fire = cb; return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => { fire = null; },
  });
  selection.reset(pool);
  return {
    selection, published,
    /** Run the armed deadline, if one is still armed. */
    expire() { const f = fire; fire = null; f?.(); },
    get deadlineArmed() { return fire !== null; },
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
    h.selection.receive({ relayRtt: { tok: 30, fra: 10 } });
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

    // Our own measurement is complete, but an older peer sends nothing at all,
    // so no choice can ever settle. Only the deadline ends this.
    expect(h.selection.gate.ready()).toBe(false);
    h.expire();
    expect(h.selection.gate.ready()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(h.selection.selectedRelayId).toBeNull();
  });

  it("wakes every waiter exactly once, whichever of settle and deadline wins", () => {
    const h = harness([relay("tok")]);
    const first = vi.fn();
    const second = vi.fn();
    h.selection.gate.whenReady(first);
    h.selection.gate.whenReady(second);

    h.selection.record("tok", 10);
    h.selection.receive({ relayRtt: { tok: 20 } });
    h.selection.finishMeasurement();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    // The deadline losing the race must be inert, not a second wake.
    h.expire();
    h.selection.receive({ relayRtt: { tok: 5 } });
    h.selection.finishMeasurement();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("merges a peer's map rather than assigning it", () => {
    const h = harness([relay("tok"), relay("fra")]);
    h.selection.receive({ relayRtt: { tok: 30, fra: 40 } });
    // A later, SHORTER message — a peer broadcasting genuine increments, or two
    // sends that crossed — must not drop what we already hold.
    h.selection.receive({ relayRtt: { fra: 20 } });
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
    h.selection.receive({ relayRtt: { tok: 5 } });
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
    h.selection.receive({ relayRtt: { fra: 9 } });
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
