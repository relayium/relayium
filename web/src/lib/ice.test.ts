import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchIceConfig, fetchIceServers, hasTurnServer, measureRelays, pickRelay,
  relayChoiceDominates, relayDominanceElapsedMs, type RelayEntry,
} from "./ice";

// 服务端下发什么就是什么的夹具。故意不写成公共 STUN 的地址——那会让人以为
// 代码里还有一个第三方默认值。
const STUN = [{ urls: "stun:relay.example:3478" }];
// /api/ice 挂掉时回落到**空列表**，不是公共 STUN —— 见 ice.ts 的注释。
const FALLBACK_STUN: never[] = [];

describe("fetchIceServers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests /api/ice with ?code= for a pairing code and returns the list", async () => {
    const servers = [
      { urls: ["stun:s:3478"] },
      { urls: ["turn:t:3478"], username: "u", credential: "c" },
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ iceServers: servers }) });
    vi.stubGlobal("fetch", fetchMock);

    const out = await fetchIceServers("424242");
    expect(out).toEqual(servers);
    expect(fetchMock).toHaveBeenCalledWith("/api/ice?code=424242", {
      credentials: "include",
    });
  });

  it("omits the query when no code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ iceServers: STUN }) });
    vi.stubGlobal("fetch", fetchMock);

    await fetchIceServers("");
    expect(fetchMock).toHaveBeenCalledWith("/api/ice", { credentials: "include" });
  });

  it("falls back to an empty list (never a third-party STUN) on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, headers: new Headers(), json: async () => { throw new SyntaxError("not JSON"); } }));
    const out = await fetchIceServers("424242");
    expect(out).toEqual(FALLBACK_STUN);
  });

  it("falls back to an empty list when a 200 body isn't JSON (e.g. nginx serves index.html)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      }),
    );
    const out = await fetchIceServers("424242");
    expect(out).toEqual(FALLBACK_STUN);
  });

  it("falls back to an empty list when the fetch itself rejects (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const out = await fetchIceServers("424242");
    expect(out).toEqual(FALLBACK_STUN);
  });
});

describe("fetchIceConfig relayDenied", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes through relayDenied when the server withholds TURN over the cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: STUN, relays: [], relayDenied: "quota" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBe("quota");
    expect(cfg.iceServers).toEqual(STUN);
  });

  it("leaves relayDenied undefined when the server does not send it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ iceServers: STUN, relays: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBeUndefined();
  });

  it("leaves relayDenied undefined on a fallback (non-ok / network error)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 502, headers: new Headers(), json: async () => { throw new SyntaxError("not JSON"); } });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = await fetchIceConfig("424242");
    expect(cfg.relayDenied).toBeUndefined();
    expect(cfg.iceServers).toEqual(FALLBACK_STUN);
  });
});

describe("hasTurnServer", () => {
  it("is false for a STUN-only list (LAN / no pairing code)", () => {
    expect(hasTurnServer(STUN)).toBe(false);
    expect(hasTurnServer([])).toBe(false);
  });

  it("is true when a turn: or turns: URL is present", () => {
    expect(hasTurnServer([{ urls: ["turn:t:3478"], username: "u", credential: "c" }])).toBe(true);
    expect(hasTurnServer([{ urls: "turns:t:5349", username: "u", credential: "c" }])).toBe(true);
    // Mixed STUN + TURN (the real /api/ice code-room response) still counts.
    expect(hasTurnServer([{ urls: "stun:s:3478" }, { urls: ["turn:t:3478"] }])).toBe(true);
  });

  it("does not mistake a stun: URL that merely contains 'turn' hostname parts", () => {
    expect(hasTurnServer([{ urls: "stun:saturn.example.com:3478" }])).toBe(false);
  });
});

describe("pickRelay", () => {
  it("minimises the worse of the two peers' RTTs", () => {
    // tok: max(30,200)=200; la: max(180,40)=180 → la wins (better worst-case leg).
    const mine = { tok: 30, la: 180 };
    const theirs = { tok: 200, la: 40 };
    expect(pickRelay(mine, theirs)).toBe("la");
  });

  it("only considers relays both peers measured", () => {
    // sg is fastest for me but the peer never measured it → ineligible.
    expect(pickRelay({ sg: 10, tok: 90 }, { tok: 95 })).toBe("tok");
    expect(pickRelay({ sg: 10 }, { tok: 95 })).toBeNull();
    expect(pickRelay({}, {})).toBeNull();
  });

  it("is symmetric — both peers derive the same id from swapped inputs", () => {
    const a = { tok: 30, la: 180, fra: 90 };
    const b = { tok: 200, la: 40, fra: 95 };
    expect(pickRelay(a, b)).toBe(pickRelay(b, a));
  });

  it("breaks ties on worst-case by sum, then by id (stable on both sides)", () => {
    // Both have max 100; tok sum=150 < la sum=200 → tok.
    expect(pickRelay({ tok: 100, la: 100 }, { tok: 50, la: 100 })).toBe("tok");
    // Identical worst-case AND sum → lowest id, same on both sides.
    expect(pickRelay({ b: 100, a: 100 }, { b: 100, a: 100 })).toBe("a");
  });
});

/**
 * **The shared dominance table.**
 *
 * Every row is a decision both clients must make identically, so the same table
 * is transcribed into `RelayChoiceTests.testMatchesTheBrowsersDominanceTable` in
 * RelayiumKit. A row added here without adding it there is a divergence, which
 * is a second relay, a second hop and roughly twice the metered bandwidth.
 *
 * `elapsed: null` is the honest "no sound lower bound available" — see
 * `relayChoiceDominates`. Both clients spend time in that state: the browser
 * before its first result, the native client before `RelayProbe`'s all-started
 * barrier fires. Both then supply a real bound, which is why the clock rows
 * below have to agree too and not only the timing-free ones.
 */
const DOMINANCE_TABLE: Array<{
  name: string;
  selected: string | null;
  mine: Record<string, number>;
  theirs: Record<string, number>;
  pool: string[];
  elapsed: number | null;
  expected: boolean;
}> = [
  {
    name: "no choice yet dominates nothing",
    selected: null, mine: {}, theirs: {}, pool: ["a", "b"], elapsed: 10_000, expected: false,
  },
  {
    name: "a pick both maps carry, with every probe answered, needs no clock",
    selected: "a", mine: { a: 20, b: 90 }, theirs: { a: 30, b: 40 },
    pool: ["a", "b"], elapsed: null, expected: true,
  },
  {
    name: "an unfinished probe with no elapsed bound and no peer leg keeps waiting",
    selected: "a", mine: { a: 20 }, theirs: { a: 30 },
    pool: ["a", "b"], elapsed: null, expected: false,
  },
  {
    name: "a peer leg already worse than the pick's worst retires it with no clock",
    selected: "a", mine: { a: 20 }, theirs: { a: 30, b: 31 },
    pool: ["a", "b"], elapsed: null, expected: true,
  },
  {
    name: "a peer leg EQUAL to the pick's worst does not: sum and id can still turn it",
    selected: "a", mine: { a: 20 }, theirs: { a: 30, b: 30 },
    pool: ["a", "b"], elapsed: null, expected: false,
  },
  {
    name: "elapsed strictly past the pick's worst leg retires every unfinished probe",
    selected: "a", mine: { a: 20 }, theirs: { a: 30 },
    pool: ["a", "b"], elapsed: 31, expected: true,
  },
  {
    name: "elapsed EQUAL to the pick's worst leg does not",
    selected: "a", mine: { a: 20 }, theirs: { a: 30 },
    pool: ["a", "b"], elapsed: 30, expected: false,
  },
  {
    name: "and neither does a fractional elapsed that rounds down onto it",
    selected: "a", mine: { a: 20 }, theirs: { a: 30 },
    pool: ["a", "b"], elapsed: 30.4, expected: false,
  },
  {
    name: "one retired by the clock and one by the peer's leg is still dominance",
    selected: "a", mine: { a: 20 }, theirs: { a: 30, c: 900 },
    pool: ["a", "b", "c"], elapsed: 31, expected: true,
  },
  {
    name: "one relay short of the bound holds the whole room",
    selected: "a", mine: { a: 20 }, theirs: { a: 30, c: 900 },
    pool: ["a", "b", "c"], elapsed: 30, expected: false,
  },
  {
    name: "a pick the peer has not measured is not a pick at all",
    selected: "b", mine: { a: 20, b: 5 }, theirs: { a: 30 },
    pool: ["a", "b"], elapsed: 10_000, expected: false,
  },
  {
    name: "relays outside the pool are not probes and cannot hold the gate",
    selected: "a", mine: { a: 20 }, theirs: { a: 30, z: 1 },
    pool: ["a"], elapsed: null, expected: true,
  },
];

describe("relayChoiceDominates", () => {
  for (const row of DOMINANCE_TABLE) {
    it(row.name, () => {
      expect(relayChoiceDominates(row.selected, row.mine, row.theirs, row.pool, row.elapsed))
        .toBe(row.expected);
    });
  }

  /**
   * **The rule may never retire a relay that could still win.**
   *
   * Stated as the property rather than as a case: for every pending relay, if
   * dominance holds then no round trip consistent with the bound can make
   * `pickRelay` choose that relay instead. `mine[pending] = lowerBound` is the
   * best case the bound allows, so if the pick survives that it survives
   * everything.
   */
  it("never retires a relay that some legal round trip would hand the room to", () => {
    const ids = ["a", "b", "c"];
    for (let seed = 0; seed < 4_000; seed++) {
      // A cheap deterministic spread; the point is coverage of the boundary,
      // not statistical quality.
      const n = (k: number) => ((seed * 2654435761 + k * 40503) >>> 8) % 60;
      const mine: Record<string, number> = {};
      const theirs: Record<string, number> = {};
      ids.forEach((id, i) => {
        if (n(i) % 5 !== 0) mine[id] = n(i + 10);
        if (n(i + 20) % 5 !== 0) theirs[id] = n(i + 30);
      });
      const elapsed = seed % 3 === 0 ? null : n(99);
      const selected = pickRelay(mine, theirs);
      if (!relayChoiceDominates(selected, mine, theirs, ids, elapsed)) continue;
      expect(selected).not.toBeNull();
      const bound = elapsed === null ? null : Math.round(elapsed);
      for (const pending of ids.filter((id) => !(id in mine))) {
        // Every round trip the bound still permits, at its most favourable.
        const candidates = bound === null ? [0, 1, 5, 60, 5_000] : [bound, bound + 1, 9_000];
        for (const rtt of candidates) {
          expect(pickRelay({ ...mine, [pending]: rtt }, theirs))
            .toBe(selected);
        }
      }
    }
  });
});

describe("relayDominanceElapsedMs", () => {
  it("names an elapsed time at which the strict rule is certain to hold", () => {
    for (const worst of [0, 1, 30, 199, 4_321]) {
      const at = relayDominanceElapsedMs(worst);
      expect(relayChoiceDominates("a", { a: worst }, { a: worst }, ["a", "b"], at)).toBe(true);
      // …and not one millisecond earlier, which is what stops a wake-up
      // scheduled on it from finding the condition still false.
      expect(relayChoiceDominates("a", { a: worst }, { a: worst }, ["a", "b"], at - 1)).toBe(false);
    }
  });
});

describe("measureRelays", () => {
  const relay = (id: string): RelayEntry => ({
    id,
    iceServers: [{ urls: [`turn:${id}.example:3478`] }],
  });

  /** A fake RTCPeerConnection that answers with one relay candidate after `ms`,
   *  or never. `measureRelay` times each one from setLocalDescription. */
  function stubPeerConnections(answers: Record<string, number | null>) {
    vi.stubGlobal("RTCPeerConnection", class {
      onicecandidate: ((e: { candidate: { candidate: string } | null }) => void) | null = null;
      private readonly id: string;
      constructor(cfg: { iceServers: { urls: string[] }[] }) {
        this.id = /turn:(.+)\.example/.exec(cfg.iceServers[0].urls[0])![1];
      }
      createDataChannel() {}
      async createOffer() { return { type: "offer", sdp: "v=0" }; }
      async setLocalDescription() {
        const at = answers[this.id];
        if (at === null || at === undefined) return;
        setTimeout(() => {
          this.onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 1 typ relay" } });
        }, at);
      }
      close() {}
    });
  }

  afterEach(() => vi.unstubAllGlobals());

  /**
   * **One dead relay must not hold every other result.**
   *
   * Awaiting the whole pool meant the caller saw nothing until the SLOWEST
   * probe finished — so a single unreachable node pinned the map at the full
   * 9 s timeout, on every transfer, with nothing published, nothing to select
   * from and nothing to tell the peer in the meantime.
   */
  it("reports each relay as it answers, without waiting for a dead one", async () => {
    vi.useFakeTimers();
    stubPeerConnections({ fast: 10, slow: 500, dead: null });
    const seen: string[] = [];
    const done = measureRelays(
      [relay("fast"), relay("slow"), relay("dead")],
      (id) => seen.push(id),
    );

    await vi.advanceTimersByTimeAsync(20);
    expect(seen).toEqual(["fast"]);

    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual(["fast", "slow"]);

    // The dead relay only settles at the probe timeout, and it is never
    // reported — which is what makes it ineligible rather than merely slow.
    await vi.advanceTimersByTimeAsync(9_000);
    const map = await done;
    expect(Object.keys(map).sort()).toEqual(["fast", "slow"]);
    expect(seen).toEqual(["fast", "slow"]);
    vi.useRealTimers();
  });

  /**
   * **The ordering the whole dominance rule rests on, under a stall long enough
   * to break any fixed slack.**
   *
   * `relayChoiceDominates` uses elapsed time as a LOWER bound on what a probe
   * that has not answered will report, and that is sound only against an anchor
   * at or after the instant that probe started timing. The gate anchors on the
   * FIRST published result, which is a claim about `measureRelays`: it starts
   * every probe in one synchronous job, and nothing it publishes can escape that
   * job. This runs on real timers with a genuine 150 ms main-thread stall
   * between the two probes and asserts both halves —
   *
   *  - that the anchor is sound: elapsed measured from the first result never
   *    exceeds what the still-pending probe eventually reports; and
   *  - that the anchor the first draft used was NOT: elapsed measured from the
   *    call — the closest stand-in for `createRelaySelection.reset` — overstates
   *    that probe's round trip by the whole length of the stall, which is more
   *    than the 100 ms discount that draft applied to it.
   *
   * The stall is in a CONSTRUCTOR, so it sits between the call and the second
   * probe's own clock start, which is exactly where a scheduling or main-thread
   * stall sits in the browser.
   */
  it("starts every probe before it publishes anything, however long a construction stalls", async () => {
    const STALL_MS = 150;
    const constructedAt: number[] = [];
    vi.stubGlobal("RTCPeerConnection", class {
      onicecandidate: ((e: { candidate: { candidate: string } | null }) => void) | null = null;
      private readonly id: string;
      constructor(cfg: { iceServers: { urls: string[] }[] }) {
        this.id = /turn:(.+)\.example/.exec(cfg.iceServers[0].urls[0])![1];
        // A busy main thread, not a sleep: this must be time that elapses
        // BETWEEN two probe constructions, which is the shape a discount from a
        // pre-probe anchor cannot bound.
        if (this.id === "stalled") {
          const until = performance.now() + STALL_MS;
          while (performance.now() < until) { /* deliberately blocking */ }
        }
        constructedAt.push(performance.now());
      }
      createDataChannel() {}
      async createOffer() { return { type: "offer", sdp: "v=0" }; }
      async setLocalDescription() {
        setTimeout(() => {
          this.onicecandidate?.({ candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 1 typ relay" } });
        }, this.id === "instant" ? 0 : 40);
      }
      close() {}
    });

    const results: Array<{ id: string; ms: number; at: number; startedByThen: number }> = [];
    const calledAt = performance.now();
    const map = await measureRelays(
      [relay("stalled"), relay("instant")],
      (id, ms) => results.push({ id, ms, at: performance.now(), startedByThen: constructedAt.length }),
    );

    expect(Object.keys(map).sort()).toEqual(["instant", "stalled"]);
    expect(results[0].id).toBe("instant");
    // Both probes had been constructed — and therefore had taken their own
    // clock start, which `measureRelay` does on the next line — before the
    // first result could be published.
    expect(results[0].startedByThen).toBe(2);

    const anchor = results[0].at;
    const stalled = results.find((r) => r.id === "stalled")!;
    // Sound: elapsed from the anchor is never more than the probe reports.
    expect(Math.round(stalled.at - anchor)).toBeLessThanOrEqual(stalled.ms);
    // Unsound: elapsed from before the probes started is, by the whole stall.
    expect(Math.round(stalled.at - calledAt)).toBeGreaterThan(stalled.ms + STALL_MS - 20);
  });
});
