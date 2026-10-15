import { describe, expect, it } from "vitest";
import { createRelaySelection } from "./relay-selection";
import type { RelayEntry } from "./ice";
import {
  recordTransferSample, type FinishedBatch, type SampleRoom,
  CONFIDENT_SINGLE_BYTES, HISTORY_TTL_MS, MAX_DIAGNOSTICS, MAX_HISTORY_ENTRIES, MIN_SAMPLE_BYTES,
  createRelayHistory, hmacSha256, sha256, type HistoryStorage, type RelaySample,
} from "./relay-history";

const MiB = 1024 * 1024;

function memStorage(initial: string | null = null) {
  let value = initial;
  const writes: string[] = [];
  const storage: HistoryStorage = {
    get: () => value,
    set: (v) => { value = v; writes.push(v); },
  };
  return { storage, writes, read: () => value };
}

function setup(start = 1_800_000_000_000, initial: string | null = null) {
  let clock = start;
  const mem = memStorage(initial);
  let seed = 1;
  const history = createRelayHistory({
    storage: mem.storage,
    now: () => clock,
    randomBytes: (n) => Uint8Array.from({ length: n }, () => (seed = (seed * 31 + 7) & 0xff)),
  });
  return { history, mem, advance: (ms: number) => { clock += ms; } };
}

const sample = (over: Partial<RelaySample> = {}): RelaySample => ({
  relayId: "node-1", bytes: 16 * MiB, activeMs: 1000, transport: "udp", net: "wifi", rttMs: 40, ...over,
});

describe("sha256 / hmac", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  it("matches the FIPS 180 vectors", () => {
    expect(hex(sha256(enc("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha256(enc("")))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hex(sha256(enc("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))))
      .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  });
  it("matches WebCrypto HMAC for short and long keys", async () => {
    for (const keyLen of [16, 32, 64, 100]) {
      const key = Uint8Array.from({ length: keyLen }, (_, i) => (i * 7 + 3) & 0xff);
      const msg = enc(`relay-${keyLen}-${"x".repeat(keyLen)}`);
      const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const want = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
      expect(hex(hmacSha256(key, msg))).toBe(hex(want));
    }
  });
});

describe("relay history: what qualifies", () => {
  it("rejects small, instant, non-finite or malformed samples", () => {
    const { history } = setup();
    expect(history.add(sample({ bytes: MIN_SAMPLE_BYTES - 1 }))).toBe(false);
    expect(history.add(sample({ activeMs: 199 }))).toBe(false);
    expect(history.add(sample({ activeMs: Number.NaN }))).toBe(false);
    expect(history.add(sample({ bytes: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(history.add(sample({ rttMs: -1 }))).toBe(false);
    expect(history.add(sample({ relayId: "" }))).toBe(false);
    expect(history.add(sample({ relayId: "x".repeat(65) }))).toBe(false);
    expect(history.entries()).toHaveLength(0);
  });

  it("accepts a fast large sample well under two seconds", () => {
    const { history } = setup();
    expect(history.add(sample({ bytes: 32 * MiB, activeMs: 300 }))).toBe(true);
    // ~895 Mbit/s, one confident sample on its own.
    expect(history.estimate("node-1", "wifi", 40)).toBeGreaterThan(800_000);
  });
});

describe("relay history: confidence and estimate", () => {
  it("one small sample is not confident; two are; one 32 MiB sample is", () => {
    const { history } = setup();
    history.add(sample({ bytes: 8 * MiB, activeMs: 1000 }));
    expect(history.estimate("node-1", "wifi", 40)).toBeNull();
    history.add(sample({ bytes: 8 * MiB, activeMs: 1000 }));
    expect(history.estimate("node-1", "wifi", 40)).not.toBeNull();
    history.add(sample({ relayId: "node-2", bytes: CONFIDENT_SINGLE_BYTES, activeMs: 1000 }));
    expect(history.estimate("node-2", "wifi", 40)).not.toBeNull();
  });

  it("estimate is the conservative lower quartile, quantized", () => {
    const { history } = setup();
    for (const ms of [1000, 1000, 1000, 4000]) history.add(sample({ bytes: 16 * MiB, activeMs: ms }));
    // 16 MiB in 1 s ≈ 134 Mbit/s; in 4 s ≈ 33.5 Mbit/s. Lower quartile of 4 is the minimum.
    const est = history.estimate("node-1", "wifi", 40)!;
    expect(est).toBeGreaterThan(33_554 * 0.9);
    expect(est).toBeLessThan(33_554 * 1.1);
  });

  it("other network class, or an inconsistent round trip, is not evidence", () => {
    const { history } = setup();
    history.add(sample());
    history.add(sample());
    expect(history.estimate("node-1", "cellular", 40)).toBeNull();
    expect(history.estimate("node-1", "wifi", 400)).toBeNull();
    expect(history.estimate("node-1", "wifi", 130)).not.toBeNull(); // within max(100 ms, recorded)
    expect(history.estimate("node-1", "wifi", null)).not.toBeNull(); // upper bound: no filter
  });

  it("a network change makes earlier evidence non-confident for this page", () => {
    const { history, advance } = setup();
    history.add(sample());
    history.add(sample());
    history.noteNetworkChange();
    expect(history.estimate("node-1", "wifi", 40)).toBeNull();
    advance(2 * 60_000);
    history.add(sample());
    history.add(sample());
    expect(history.estimate("node-1", "wifi", 40)).not.toBeNull();
  });
});

describe("relay history: bounds and persistence", () => {
  it("keeps at most 30 entries, dropping the oldest", () => {
    const { history } = setup();
    for (let i = 0; i < MAX_HISTORY_ENTRIES + 5; i++) history.add(sample({ relayId: `n${i}` }));
    const entries = history.entries();
    expect(entries).toHaveLength(MAX_HISTORY_ENTRIES);
  });

  it("expires entries after the TTL, and drops entries from the future", () => {
    const { history, advance } = setup();
    history.add(sample());
    history.add(sample());
    advance(HISTORY_TTL_MS + 60_000);
    expect(history.estimate("node-1", "wifi", 40)).toBeNull();
    expect(history.entries()).toHaveLength(0);
  });

  it("removes expired records from persistent storage on use and on reload", () => {
    const first = setup();
    first.history.add(sample());
    const oldStored = first.mem.read();
    first.advance(HISTORY_TTL_MS + 60_000);
    expect(first.history.estimate("node-1", "wifi", 40)).toBeNull();
    expect(JSON.parse(first.mem.read()!).e).toEqual([]);
    const reloaded = setup(1_800_000_000_000 + HISTORY_TTL_MS + 60_000, oldStored);
    // Loading prunes storage even before a room asks for an estimate.
    expect(JSON.parse(reloaded.mem.read()!).e).toEqual([]);
  });

  it("persists only hashed ids and coarse fields — no raw id, peer, size or name", () => {
    const { history, mem } = setup();
    history.add(sample({ relayId: "relay-secret-id.example", bytes: 12_345_678 }));
    const stored = mem.read()!;
    expect(stored).not.toContain("relay-secret-id");
    expect(stored).not.toContain("12345678");
    const parsed = JSON.parse(stored) as { v: number; s: string; e: unknown[][] };
    expect(parsed.v).toBe(1);
    expect(parsed.s).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.e[0]).toHaveLength(7);
    expect(parsed.e[0][0]).toMatch(/^[0-9a-f]{16}$/);
    expect(Object.keys(parsed).sort()).toEqual(["e", "s", "v"]);
  });

  it("the same salt survives a reload, so evidence is found again", () => {
    const first = setup();
    first.history.add(sample());
    first.history.add(sample());
    const again = setup(1_800_000_000_000 + 60_000, first.mem.read());
    expect(again.history.estimate("node-1", "wifi", 40)).not.toBeNull();
  });

  it("a different salt hashes the same relay differently", () => {
    const a = setup();
    a.history.add(sample());
    const stored = JSON.parse(a.mem.read()!) as { s: string; e: unknown[][] };
    stored.s = "ff".repeat(32);
    const b = setup(1_800_000_000_000, JSON.stringify(stored));
    b.history.add(sample());
    const hashes = b.history.entries().map((e) => e[0]);
    expect(new Set(hashes).size).toBe(2);
  });

  it("malformed storage starts fresh; throwing storage degrades to memory", () => {
    for (const bad of ["{", "[]", '{"v":2}', '{"v":1,"s":"zz","e":[]}', '{"v":1,"s":"' + "a".repeat(64) + '","e":[["x"]]}']) {
      const { history } = setup(1_800_000_000_000, bad);
      expect(history.entries()).toHaveLength(0);
      expect(history.add(sample())).toBe(true);
    }
    const throwing = createRelayHistory({
      storage: { get: () => { throw new Error("denied"); }, set: () => { throw new Error("quota"); } },
      now: () => 1_800_000_000_000,
      randomBytes: (n) => new Uint8Array(n).fill(9),
    });
    expect(throwing.add(sample())).toBe(true);
    expect(throwing.add(sample())).toBe(true);
    expect(throwing.estimate("node-1", "wifi", 40)).not.toBeNull();
  });

  it("works with no storage at all", () => {
    const h = createRelayHistory({ now: () => 1_800_000_000_000, randomBytes: (n) => new Uint8Array(n) });
    h.add(sample());
    h.add(sample());
    expect(h.estimate("node-1", "wifi", 40)).not.toBeNull();
  });

  it("sanitizes the network class instead of storing arbitrary text", () => {
    const { history } = setup();
    history.add(sample({ net: "Home WiFi \"Lily\"" }));
    expect(history.entries()[0][2]).toBe("unknown");
  });

  it("keeps a bounded in-memory diagnostics ring that is never persisted", () => {
    const { history, mem } = setup();
    for (let i = 0; i < MAX_DIAGNOSTICS + 3; i++) {
      history.observe({ dir: "send", volumeBucket: 24, activeMs: i, creditWaitMs: 1, bufferWaitMs: 2, finalizeMs: 3, attributed: false });
    }
    expect(history.recent()).toHaveLength(MAX_DIAGNOSTICS);
    expect(history.recent()[0].activeMs).toBe(3);
    expect(mem.read()).toBeNull();
  });
});

describe("recordTransferSample: a finished batch becomes evidence the next room uses", () => {
  const pool: RelayEntry[] = [
    { id: "near", iceServers: [{ urls: "turn:near.example:3478?transport=udp" }] },
    { id: "far", iceServers: [{ urls: "turn:far.example:3478?transport=udp" }] },
  ];
  const statsVia = (url: string | null, type = "relay") => async () => new Map<string, Record<string, unknown>>([
    ["T", { type: "transport", selectedCandidatePairId: "P" }],
    ["P", { type: "candidate-pair", localCandidateId: "L", remoteCandidateId: "R" }],
    ["L", { type: "local-candidate", candidateType: type, relayProtocol: "udp", ...(url ? { url } : {}) }],
  ]) as unknown as RTCStatsReport;
  const batch = (over: Partial<FinishedBatch>): FinishedBatch => ({
    dir: "send", bytes: 32 * MiB, activeMs: 1000, creditWaitMs: 1, bufferWaitMs: 2, finalizeMs: 3,
    stats: statsVia("turn:near.example:3478?transport=udp"), ...over,
  });
  const room = (over: Partial<SampleRoom> = {}): SampleRoom => ({
    epoch: 1, pool, builtIds: new Set(["near", "far"]), ownRtt: { near: 20, far: 200 }, net: "unknown", ...over,
  });

  it("records an attributed batch and explains every refusal", async () => {
    const { history } = setup();
    expect(await recordTransferSample(history, batch({ bytes: MIN_SAMPLE_BYTES - 1 }), room(), () => 1)).toBe("too-small");
    expect(await recordTransferSample(history, batch({}), room({ pool: [] }), () => 1)).toBe("no-pool");
    expect(await recordTransferSample(history, batch({ stats: async () => { throw new Error("closed"); } }), room(), () => 1)).toBe("no-stats");
    expect(await recordTransferSample(history, batch({}), room(), () => 2)).toBe("stale");
    expect(await recordTransferSample(history, batch({ stats: statsVia(null) }), room(), () => 1)).toBe("unattributed");
    expect(await recordTransferSample(history, batch({ stats: statsVia("turn:near.example:3478?transport=udp", "srflx") }), room(), () => 1)).toBe("unattributed");
    expect(await recordTransferSample(history, batch({}), room({ builtIds: new Set(["far"]) }), () => 1)).toBe("unattributed");
    expect(history.entries()).toHaveLength(0);
    expect(await recordTransferSample(history, batch({}), room(), () => 1)).toBe("recorded");
    expect(history.entries()).toHaveLength(1);
    expect(history.recent().map((d) => d.attributed)).toEqual([false, false, false, false, false, false, false, true]);
  });

  it("two peers that each recorded real completions pick the far, fast relay in the NEXT room", async () => {
    const left = setup();
    const right = setup();
    for (const h of [left.history, right.history]) {
      // 32 MiB through near at 2 Mbit/s (~134 s) and through far at 100 Mbit/s (~2.7 s).
      await recordTransferSample(h, batch({ activeMs: 134_218, stats: statsVia("turn:near.example:3478?transport=udp") }), room(), () => 1);
      await recordTransferSample(h, batch({ activeMs: 2_685, stats: statsVia("turn:far.example:3478?transport=udp") }), room(), () => 1);
    }
    const sent: Record<string, unknown[]> = { L: [], R: [] };
    const mk = (h: typeof left.history, me: "L" | "R") => createRelaySelection({
      publish: (map, perf) => sent[me].push(JSON.parse(JSON.stringify({ relayRtt: map, relayPerf: perf }))),
      performance: { estimate: (id, rtt) => h.estimate(id, "unknown", rtt) },
    });
    const L = mk(left.history, "L");
    const R = mk(right.history, "R");
    L.reset(pool); R.reset(pool);
    L.record("near", 20); L.record("far", 200); L.finishMeasurement();
    R.record("near", 25); R.record("far", 190); R.finishMeasurement();
    L.receive("R", sent.R[sent.R.length - 1]);
    R.receive("L", sent.L[sent.L.length - 1]);
    expect(L.selectedRelayId).toBe("far");
    expect(R.selectedRelayId).toBe("far");
    // Control: a client that does not take part (no performance source — the
    // Windows/legacy shape) gets the legacy nearest relay from the same maps.
    const legacy = createRelaySelection({ publish: () => {} });
    legacy.reset(pool);
    legacy.record("near", 20); legacy.record("far", 200); legacy.finishMeasurement();
    legacy.receive("R", sent.R[sent.R.length - 1]);
    expect(legacy.selectedRelayId).toBe("near");
    // And a participating peer with an EMPTY history still declares, so the
    // other side's evidence alone decides — by design (one side's evidence is
    // used when the other has none).
    const empty = createRelaySelection({ publish: () => {}, performance: { estimate: () => null } });
    empty.reset(pool);
    empty.record("near", 20); empty.record("far", 200); empty.finishMeasurement();
    empty.receive("R", sent.R[sent.R.length - 1]);
    expect(empty.selectedRelayId).toBe("far");
  });
});

describe("estimate(null) is a true upper bound (R2)", () => {
  it("mixed-vantage history: home near/slow and office far/fast rows", () => {
    const { history } = setup();
    // 16 MiB each: 2 x 67.0 s at rtt 10 ms, 2 x 1.342 s at rtt 300 ms.
    for (let i = 0; i < 2; i++) history.add(sample({ relayId: "X", bytes: 16 * MiB, activeMs: 67_000, rttMs: 10 }));
    for (let i = 0; i < 2; i++) history.add(sample({ relayId: "X", bytes: 16 * MiB, activeMs: 1_342, rttMs: 300 }));
    const atFar = history.estimate("X", "wifi", 300)!;
    const atNear = history.estimate("X", "wifi", 10)!;
    const upper = history.estimate("X", "wifi", null)!;
    expect(atFar).toBeGreaterThan(90_000);
    expect(atNear).toBeLessThan(3_000);
    expect(upper).toBeGreaterThanOrEqual(atFar);
    expect(upper).toBeGreaterThanOrEqual(atNear);
  });

  it("randomised row sets: no round trip yields more than the upper bound", () => {
    let seed = 5;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
    const RTTS = [10, 40, 150, 400, 900];
    const MS = [300, 1000, 4000, 30_000, 90_000];
    let checked = 0;
    for (let world = 0; world < 400; world++) {
      const { history } = setup(1_800_000_000_000 + world * 1000);
      const rows = 1 + rnd(6);
      for (let i = 0; i < rows; i++) {
        history.add(sample({ relayId: "X", bytes: (8 + rnd(40)) * MiB, activeMs: MS[rnd(MS.length)], rttMs: RTTS[rnd(RTTS.length)] }));
      }
      const upper = history.estimate("X", "wifi", null);
      for (let rtt = 0; rtt <= 1000; rtt += 5) {
        const v = history.estimate("X", "wifi", rtt);
        if (v === null) continue;
        expect(upper, JSON.stringify({ world, rtt, v, entries: history.entries() })).not.toBeNull();
        expect(upper!).toBeGreaterThanOrEqual(v);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });
});
