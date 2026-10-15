import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pickRelay, relayChoiceDominates, type RelayEntry } from "./ice";
import {
  MAX_PERF_ENTRIES, RELAY_PERF_POLICY, RELAY_PERF_REF_BYTES, RELAY_PERF_VERSION,
  OVERRIDE_MIN_SAVING_MS, OVERRIDE_RATIO_DEN, OVERRIDE_RATIO_NUM, MAX_PERF_KBPS,
  attributeRelay, parseRelayPerf, perfDeclaration, pickRelayPerf, predictedMs,
  relayPerfChoiceDominates, relayPerfDominanceElapsedMs, type PerfKnowledge,
} from "./relay-performance";

interface PickVector {
  name: string;
  mine: Record<string, number>; theirs: Record<string, number>;
  minePerf: Record<string, number>; theirsPerf: Record<string, number>;
  expect: string | null; legacy: string | null;
  predictedMs?: number; legacyPredictedMs?: number;
}
interface ParseVector { name: string; data: unknown; valid: boolean; k?: Record<string, number> }
interface DominanceVector {
  name: string; selected: string;
  mine: Record<string, number>; theirs: Record<string, number>;
  minePerf: Record<string, number>; theirsPerf: Record<string, number>;
  mineUpper: Record<string, number>; theirsUpper: Record<string, number>; pool: string[];
  elapsed: number | null; expect: boolean; legacyExpect?: boolean; retiresAt?: number;
}
interface Contract {
  declaration: { v: number; policy: string; ref: number; maxEntries: number; kbpsMax: number };
  override: { ratioNum: number; ratioDen: number; minSavingMs: number };
  pick: PickVector[]; parse: ParseVector[]; dominance: DominanceVector[];
}

// Vitest runs with web/ as its working directory; the contract is shared, so it
// lives at the repository root next to the other cross-client contracts.
const contract = JSON.parse(readFileSync(
  resolve(process.cwd(), "../contracts/relay-performance-v1.json"), "utf8",
)) as Contract;

const knowledge = (v: Pick<DominanceVector, "mine" | "theirs" | "minePerf" | "theirsPerf" | "mineUpper" | "theirsUpper">): PerfKnowledge => ({
  mine: v.mine, theirs: v.theirs, minePerf: v.minePerf, theirsPerf: v.theirsPerf,
  mineUpper: v.mineUpper, theirsUpper: v.theirsUpper,
});

describe("relay-performance contract constants", () => {
  it("match the shared vectors", () => {
    expect(contract.declaration).toMatchObject({
      v: RELAY_PERF_VERSION, policy: RELAY_PERF_POLICY, ref: RELAY_PERF_REF_BYTES,
      maxEntries: MAX_PERF_ENTRIES, kbpsMax: MAX_PERF_KBPS,
    });
    expect(contract.override).toEqual({
      ratioNum: OVERRIDE_RATIO_NUM, ratioDen: OVERRIDE_RATIO_DEN, minSavingMs: OVERRIDE_MIN_SAVING_MS,
    });
  });
});

describe("pickRelayPerf golden vectors", () => {
  for (const v of contract.pick) {
    it(v.name, () => {
      const got = pickRelayPerf(v.mine, v.theirs, v.minePerf, v.theirsPerf);
      expect(got.id).toBe(v.expect);
      expect(got.legacy).toBe(v.legacy);
      expect(pickRelay(v.mine, v.theirs)).toBe(v.legacy);
      if (v.predictedMs !== undefined) expect(got.predictedMs).toBe(v.predictedMs);
      if (v.legacyPredictedMs !== undefined) expect(got.legacyPredictedMs).toBe(v.legacyPredictedMs);
    });
    it(`${v.name} — same id with the peers swapped`, () => {
      expect(pickRelayPerf(v.theirs, v.mine, v.theirsPerf, v.minePerf).id).toBe(v.expect);
    });
  }

  it("the owner's 64 MiB case: whole-file prediction agrees with the 32 MiB reference", () => {
    // 20 ms @ 2 Mbit/s vs 200 ms @ 100 Mbit/s: ~268 s vs ~5.6 s for 64 MiB.
    const bits = 64 * 1024 * 1024 * 8;
    expect(20 + bits / 2000).toBeGreaterThan(200 + bits / 100000);
    expect(predictedMs(20, 2000)).toBeGreaterThan(predictedMs(200, 100000));
  });

  it("goodput evidence never applies to a relay only one side measured", () => {
    expect(pickRelayPerf({ a: 20 }, { a: 25, b: 5 }, { a: 2000, b: 1e6 }, { b: 1e6 }).id).toBe("a");
  });

  it("prototype-named ids are plain keys", () => {
    const mine = { a: 20, toString: 200 } as unknown as Record<string, number>;
    const theirs = { a: 25, toString: 190 } as unknown as Record<string, number>;
    const perf = JSON.parse('{"a":2000,"toString":100000}') as Record<string, number>;
    expect(pickRelayPerf(mine, theirs, perf, perf).id).toBe("toString");
  });
});

describe("parseRelayPerf", () => {
  for (const v of contract.parse) {
    it(v.name, () => {
      const got = parseRelayPerf(v.data);
      if (!v.valid) { expect(got).toBeNull(); return; }
      expect(got).not.toBeNull();
      expect({ ...got!.k }).toEqual(v.k);
    });
  }

  it("rejects the whole declaration over the entry cap", () => {
    const k: Record<string, number> = {};
    for (let i = 0; i <= MAX_PERF_ENTRIES; i++) k[`r${i}`] = 1000;
    expect(parseRelayPerf({ relayPerf: { v: 1, policy: "bulk", ref: RELAY_PERF_REF_BYTES, k, u: {} } })).toBeNull();
    delete k.r0;
    expect(parseRelayPerf({ relayPerf: { v: 1, policy: "bulk", ref: RELAY_PERF_REF_BYTES, k, u: {} } })).not.toBeNull();
  });

  it("a __proto__ key cannot reach the prototype", () => {
    const data = JSON.parse('{"relayPerf":{"v":1,"policy":"bulk","ref":33554432,"k":{"__proto__":5000,"a":7},"u":{"__proto__":9000,"a":9}}}');
    const got = parseRelayPerf(data)!;
    expect(Object.getPrototypeOf(got.k)).toBeNull();
    expect(got.k.a).toBe(7);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("round-trips this side's own declaration", () => {
    const decl = perfDeclaration({ a: 2000 }, { a: 3000, b: 9000 });
    expect(parseRelayPerf(JSON.parse(JSON.stringify({ relayRtt: {}, relayPerf: decl })))).toMatchObject({ v: 1, k: { a: 2000 }, u: { a: 3000, b: 9000 } });
  });
});

describe("relayPerfChoiceDominates golden vectors", () => {
  for (const v of contract.dominance) {
    it(v.name, () => {
      expect(relayPerfChoiceDominates(v.selected, knowledge(v), v.pool, v.elapsed)).toBe(v.expect);
      if (v.legacyExpect !== undefined) {
        expect(relayChoiceDominates(v.selected, v.mine, v.theirs, v.pool, v.elapsed)).toBe(v.legacyExpect);
      }
      if (v.retiresAt !== undefined) {
        expect(relayPerfDominanceElapsedMs(knowledge(v), v.pool)).toBe(v.retiresAt);
      }
    });
  }

  /**
   * Soundness against COMPLETE final worlds, not against bounds assumed by
   * construction. A world fixes, per relay and per side: the final round trip
   * (or a dead probe), the declared upper bound, and the value actually
   * published (any value <= the bound, or none — the round-trip filter may
   * drop it). A partial view is a random subset of what has been reported,
   * with our unreported round trips no shorter than the elapsed bound. Every
   * time the rule says "dominant", the pick on the FINAL maps must be the
   * partial pick. Mutating the rule back to the old own-probes-only shape, or
   * to a quartile "upper bound", makes this fail.
   */
  it("never releases while any completion of the unknowns could change the pick (randomised worlds)", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const pickOf = <T>(xs: readonly T[]) => xs[rnd(xs.length)];
    const RTTS = [10, 40, 200, 600, -1]; // -1: probe never answers
    const UPPERS = [0, 1500, 20000, 200000];
    const ids = ["a", "b", "c"];
    let released = 0;
    for (let world = 0; world < 40000; world++) {
      const elapsed = pickOf([0, 30, 250, 1000]);
      const fm: Record<string, number> = {}; const ft: Record<string, number> = {};
      const fmp: Record<string, number> = {}; const ftp: Record<string, number> = {};
      const mu: Record<string, number> = {}; const tu: Record<string, number> = {};
      const k: PerfKnowledge = { mine: {}, theirs: {}, minePerf: {}, theirsPerf: {}, mineUpper: mu, theirsUpper: tu };
      for (const id of ids) {
        const m = pickOf(RTTS); const t = pickOf(RTTS);
        const um = pickOf(UPPERS); const ut = pickOf(UPPERS);
        if (um) mu[id] = um;
        if (ut) tu[id] = ut;
        const pm = um && rnd(3) ? Math.max(1, Math.floor(um / (1 + rnd(4)))) : 0;
        const pt = ut && rnd(3) ? Math.max(1, Math.floor(ut / (1 + rnd(4)))) : 0;
        const mineKnown = m >= 0 && (m < elapsed || rnd(2) === 0);
        if (m >= 0) { fm[id] = m; if (pm) fmp[id] = pm; }
        if (t >= 0) { ft[id] = t; if (pt) ftp[id] = pt; }
        if (mineKnown) { k.mine[id] = m; if (pm) k.minePerf[id] = pm; }
        if (t >= 0 && rnd(2) === 0) { k.theirs[id] = t; if (pt) k.theirsPerf[id] = pt; }
      }
      const partial = pickRelayPerf(k.mine, k.theirs, k.minePerf, k.theirsPerf).id;
      if (partial === null) continue;
      if (!relayPerfChoiceDominates(partial, k, ids, elapsed)) continue;
      released++;
      expect(pickRelayPerf(fm, ft, fmp, ftp).id, JSON.stringify({ k, fm, ft, fmp, ftp, elapsed })).toBe(partial);
    }
    expect(released).toBeGreaterThan(1000);
  });
});

describe("attributeRelay", () => {
  const pool: RelayEntry[] = [
    { id: "n1", iceServers: [{ urls: ["turn:n1.example:3478?transport=udp", "turns:n1.example:443"], username: "u", credential: "c" }] },
    { id: "n2", iceServers: [{ urls: "turn:n2.example:3478", username: "u", credential: "c" }] },
  ];
  function report(local: Record<string, unknown> | null, transport = true): RTCStatsReport {
    const rows = new Map<string, Record<string, unknown>>();
    if (transport) rows.set("T", { type: "transport", selectedCandidatePairId: "P" });
    rows.set("P", { type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R", nominated: true, state: "succeeded" });
    if (local) rows.set("L", { type: "local-candidate", ...local });
    rows.set("R", { type: "remote-candidate", candidateType: "relay" });
    return rows as unknown as RTCStatsReport;
  }

  it("attributes the selected local relay candidate to its one pool entry", () => {
    const r = report({ candidateType: "relay", url: "TURN:n1.example:3478?transport=udp", relayProtocol: "udp" });
    expect(attributeRelay(r, pool, new Set(["n1"]))).toEqual({ relayId: "n1", transport: "udp" });
  });
  it("refuses a relay this room did not build on by agreement (pool fallback)", () => {
    const r = report({ candidateType: "relay", url: "turn:n2.example:3478", relayProtocol: "tcp" });
    expect(attributeRelay(r, pool, new Set(["n1"]))).toBeNull();
  });
  it("refuses a direct path, an unknown URL, a missing URL or no selected pair", () => {
    expect(attributeRelay(report({ candidateType: "srflx", url: "turn:n1.example:3478?transport=udp" }), pool, new Set(["n1"]))).toBeNull();
    expect(attributeRelay(report({ candidateType: "relay", url: "turn:other:3478" }), pool, new Set(["n1"]))).toBeNull();
    expect(attributeRelay(report({ candidateType: "relay" }), pool, new Set(["n1"]))).toBeNull();
    expect(attributeRelay(new Map() as unknown as RTCStatsReport, pool, new Set(["n1"]))).toBeNull();
  });
  it("refuses a URL two entries share", () => {
    const dup: RelayEntry[] = [...pool, { id: "n3", iceServers: [{ urls: "turn:n2.example:3478" }] }];
    const r = report({ candidateType: "relay", url: "turn:n2.example:3478" });
    expect(attributeRelay(r, dup, new Set(["n2", "n3"]))).toBeNull();
  });
  it("unknown relay protocol is recorded as unknown, not guessed", () => {
    const r = report({ candidateType: "relay", url: "turns:n1.example:443", relayProtocol: "quic" });
    expect(attributeRelay(r, pool, new Set(["n1"]))).toEqual({ relayId: "n1", transport: "unknown" });
  });
});
