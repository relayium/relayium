import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as tc from "./transfer-control";
import { ProgressRate, SliceController, TokenBucket, legacySliceMax, roomRemainingMs, worstWindowExcess, type SpeedPref } from "./transfer-control";

const vectors = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/transfer-control-v1.json"), "utf8"));

describe("transfer-control-v1 contract vectors", () => {
  it("pins every constant", () => {
    expect(Object.keys(vectors.constants).sort()).toEqual(expect.arrayContaining(["PACKING", "BACKGROUND_PROBE_EVERY"]));
    for (const [k, v] of Object.entries(vectors.constants)) {
      expect((tc as Record<string, unknown>)[k], k).toBe(v);
    }
  });

  it("legacySliceMax", () => {
    for (const c of vectors.legacySliceMax) expect(legacySliceMax(c.chunkSize), JSON.stringify(c)).toBe(c.expect);
  });

  for (const c of vectors.controller) {
    it(`controller: ${c.name}`, () => {
      const ctl = new SliceController(c.max);
      for (const s of c.steps) {
        const where = `${c.name} / ${JSON.stringify(s)}`;
        if (s.op === "next") expect(ctl.next(s.pref as SpeedPref), where).toBe(s.expect);
        else if (s.op === "pace") expect(ctl.paceRate(s.pref as SpeedPref) ?? null, where).toBe(s.expect);
        else if (s.op === "answered") ctl.onAnswered(s.bytes, s.ms);
        else if (s.op === "collapse") ctl.onCollapse(s.committed, s.tried, s.ms);
        else if (s.op === "watchdog") {
          const got = ctl.watchdogMs(s.slice, { pairRoom: s.pairRoom, roomRemainingMs: s.roomRemainingMs, stalls: s.stalls });
          if (s.expect === null) expect(got, where).toBeUndefined();
          else expect(got, where).toBeCloseTo(s.expect, 6);
        } else throw new Error(`unknown op ${s.op}`);
      }
    });
  }

  it("tokenBucket: Root's A/B/C/D trajectory, cancel of a middle ticket", () => {
    const tb = vectors.tokenBucket;
    let now = 0;
    const b = new TokenBucket(() => now);
    const tickets: Record<string, ReturnType<TokenBucket["enqueue"]>> = {};
    const dispatched: Array<{ t: number; bytes: number }> = [];
    for (const st of tb.steps) {
      now = st.now;
      if (st.op === "enqueue") tickets[st.t] = b.enqueue();
      else if (st.op === "leave") b.leave(tickets[st.t]);
      else {
        const w = b.tryTake(tickets[st.t], st.bytes, tb.rate, tb.capacity);
        expect(w, JSON.stringify(st)).toBeCloseTo(st.expect, 6);
        if (w === 0) dispatched.push({ t: now, bytes: st.bytes });
      }
    }
    expect(dispatched).toEqual(tb.dispatches);
    expect(worstWindowExcess(dispatched, tb.rate, tb.capacity)).toBeLessThanOrEqual(0);
  });

  it("roomRemaining", () => {
    for (const c of vectors.roomRemaining) {
      expect(roomRemainingMs(c, c.nowMono), JSON.stringify(c)).toBe(c.expect);
    }
  });

  it("progressRate", () => {
    for (const c of vectors.progressRate) {
      const r = new ProgressRate();
      for (const [t, at] of c.records) r.record(t, at);
      expect(r.rate(c.query) ?? null, JSON.stringify(c)).toBe(c.expectRate);
      expect(r.etaMs(c.query, c.total) ?? null, JSON.stringify(c)).toBe(c.expectEta);
    }
  });
});

describe("token bucket properties (randomised schedules with cancels and rate changes)", () => {
  // Discrete simulation: N uploads poll as paceAttempt does (wait = min(250, returned)),
  // some cancel mid-wait, the rate changes mid-run. Every pair of dispatch instants
  // must satisfy the window bound at the rate in force; one rate per run segment.
  function run(seed: number) {
    let rnd = seed;
    const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    let now = 0;
    const b = new TokenBucket(() => now);
    const rate = 32 * 1024;
    const cap = tc.pacedBurst(rate);
    type W = { ticket: ReturnType<TokenBucket["enqueue"]>; next: number; bytes: number; cancelAt: number; left: number };
    const ws: W[] = [];
    for (let i = 0; i < 5; i++) ws.push({ ticket: b.enqueue(), next: Math.floor(r() * 300), bytes: Math.min(cap, 8192 + Math.floor(r() * cap)), cancelAt: r() < 0.4 ? Math.floor(r() * 4000) : Infinity, left: 6 });
    const events: Array<{ t: number; bytes: number }> = [];
    while (ws.length && now < 60_000) {
      ws.sort((a, b2) => a.next - b2.next);
      const w = ws[0];
      now = w.next;
      if (now >= w.cancelAt) { b.leave(w.ticket); ws.shift(); continue; }
      const wait = b.tryTake(w.ticket, w.bytes, rate, cap);
      if (wait === 0) {
        events.push({ t: now, bytes: w.bytes });
        if (--w.left === 0) { ws.shift(); continue; }
        w.ticket = b.enqueue();
        w.next = now + 1 + Math.floor(r() * 50);
      } else w.next = now + Math.min(250, Math.max(1, wait));
    }
    return { events, rate, cap };
  }
  for (const seed of [1, 7, 42, 99, 2026]) {
    it(`seed ${seed}: every window <= rate x span + one burst`, () => {
      const { events, rate, cap } = run(seed);
      expect(events.length).toBeGreaterThan(5);
      expect(worstWindowExcess(events, rate, cap)).toBeLessThanOrEqual(1e-6);
    });
  }

  it("serves waiters in order: a later ticket cannot take tokens ahead of the head", () => {
    let now = 0;
    const b = new TokenBucket(() => now);
    const first = b.enqueue();
    expect(b.tryTake(first, 100, 100, 100)).toBe(0); // empties the bucket
    const a = b.enqueue();
    const later = b.enqueue();
    now = 1000; // a full refill
    expect(b.tryTake(later, 100, 100, 100)).toBe(250); // not the head: must wait
    expect(b.tryTake(a, 100, 100, 100)).toBe(0);
    expect(b.tryTake(later, 100, 100, 100)).toBeCloseTo(1000, 6);
  });

  it("no catch-up credit after idle; a cancel refunds nothing", () => {
    let now = 0;
    const b = new TokenBucket(() => now);
    const t1 = b.enqueue();
    expect(b.tryTake(t1, 100, 100, 100)).toBe(0);
    now = 60_000; // a long idle: still only one burst available
    const t2 = b.enqueue();
    expect(b.tryTake(t2, 100, 100, 100)).toBe(0);
    const t3 = b.enqueue();
    expect(b.tryTake(t3, 100, 100, 100)).toBeGreaterThan(0);
    b.leave(t3); // cancelled while waiting
    const t4 = b.enqueue();
    expect(b.tryTake(t4, 100, 100, 100)).toBeCloseTo(1000, 6); // nothing was given back
  });
});

describe("controller properties", () => {
  const fast: SpeedPref = { mode: "fast", capBytesPerSec: 1 << 20 };

  it("never proposes a TARGET above the server's chunkSize, whatever it measures", () => {
    const ctl = new SliceController(1 << 20);
    for (let i = 0; i < 50; i++) {
      ctl.onAnswered(1 << 20, 1);
      expect(ctl.next(fast)).toBeLessThanOrEqual(1 << 20);
      expect(ctl.next({ mode: "cap", capBytesPerSec: tc.MAX_CAP_BPS })).toBeLessThanOrEqual(1 << 20);
    }
  });

  it("a collapse always at least halves what was tried, down to the floor", () => {
    const ctl = new SliceController(8 << 20);
    ctl.onAnswered(8 << 20, 100);
    let tried = 8 << 20;
    for (let i = 0; i < 10; i++) {
      ctl.onCollapse(tried, tried, 1); // even a FAST observed rate cannot keep the size
      const next = ctl.next(fast);
      expect(next).toBeLessThanOrEqual(Math.max(tc.MIN_FAST_SLICE, Math.floor(tried / 2)));
      tried = next;
    }
    expect(tried).toBe(tc.MIN_FAST_SLICE);
  });

  it("a steady slow link is never budgeted below its own measured pace", () => {
    // 3 KB/s, measured; every budget must exceed the time the slice needs.
    const ctl = new SliceController(1 << 20);
    for (let i = 0; i < 20; i++) {
      const slice = ctl.next(fast);
      const needs = (slice * 1000) / 3000;
      const budget = ctl.watchdogMs(slice, { pairRoom: false, stalls: 0 });
      if (budget !== undefined) expect(budget).toBeGreaterThan(needs);
      ctl.onAnswered(slice, needs);
    }
  });

  it("background mode does not decay under its own throttling (high RTT)", () => {
    // Line 2 MB/s, RTT 400 ms: small paced requests measure far below line rate.
    const ctl = new SliceController(8 << 20);
    const bg: SpeedPref = { mode: "background", capBytesPerSec: 0 };
    const line = 2_000_000;
    const reqMs = (n: number) => 400 + (n * 1000) / line;
    let first: number | undefined;
    for (let i = 0; i < 200; i++) {
      const n = ctl.next(bg);
      ctl.onAnswered(n, reqMs(n));
      const rate = ctl.paceRate(bg)!;
      first ??= rate;
      expect(rate).toBeGreaterThanOrEqual(first);
    }
    expect(ctl.paceRate(bg)!).toBeGreaterThan(tc.BACKGROUND_FLOOR_BPS);
  });

  it("background follows a slower network through its fixed-size probes", () => {
    const ctl = new SliceController(8 << 20);
    const bg: SpeedPref = { mode: "background", capBytesPerSec: 0 };
    let line = 2_000_000;
    const run = (n: number) => { for (let i = 0; i < n; i++) { const b = ctl.next(bg); ctl.onAnswered(b, 50 + (b * 1000) / line); } };
    run(40);
    const before = ctl.paceRate(bg)!;
    line = 200_000; // the network got 10x slower
    run(80);
    const after = ctl.paceRate(bg)!;
    expect(after).toBeLessThan(before / 4);
    expect(after).toBeGreaterThanOrEqual(tc.BACKGROUND_FLOOR_BPS);
  });

  it("budget doubles with consecutive no-progress cuts but stays finite", () => {
    const ctl = new SliceController(1 << 20);
    ctl.onAnswered(1 << 20, 1000);
    const b0 = ctl.watchdogMs(1 << 20, { pairRoom: false, stalls: 0 })!;
    const b1 = ctl.watchdogMs(1 << 20, { pairRoom: false, stalls: 1 })!;
    const b99 = ctl.watchdogMs(1 << 20, { pairRoom: false, stalls: 99 })!;
    expect(b1).toBe(2 * b0);
    expect(b99).toBe(64 * b0);
  });

  it("a pair room's deadline caps the budget and an expired or skewed deadline never yields a negative or extended one", () => {
    const ctl = new SliceController(1 << 20);
    ctl.onAnswered(1 << 20, 100_000); // very slow: estimate-based budget is huge
    expect(ctl.watchdogMs(1 << 20, { pairRoom: true, roomRemainingMs: 300_000, stalls: 0 })).toBe(270_000);
    expect(ctl.watchdogMs(1 << 20, { pairRoom: true, roomRemainingMs: 0, stalls: 0 })).toBeUndefined();
    expect(roomRemainingMs({ expiresAtSec: 1e12, serverNowMs: 0, receivedAtMono: 0 }, 0)).toBe(tc.PAIR_WINDOW_CEILING_MS);
    expect(roomRemainingMs({ expiresAtSec: Number.NaN, serverNowMs: 0, receivedAtMono: 0 }, 0)).toBe(0);
  });

  it("clampCap bounds user-supplied limits", () => {
    expect(tc.clampCap(1)).toBe(tc.MIN_CAP_BPS);
    expect(tc.clampCap(Number.POSITIVE_INFINITY)).toBe(tc.DEFAULT_SPEED_PREF.capBytesPerSec);
    expect(tc.clampCap(1e15)).toBe(tc.MAX_CAP_BPS);
  });

  it("wire accounting counts every attempt and only re-covered offsets as replay", () => {
    const s = tc.emptyStats();
    let hi = 0;
    hi = tc.noteAttempt(s, hi, 0, 100);
    hi = tc.noteAttempt(s, hi, 40, 100); // retry from a committed prefix of 40
    hi = tc.noteAttempt(s, hi, 100, 150);
    expect(s).toMatchObject({ requests: 3, attemptedPayloadBytes: 210, replayedRequestedBytes: 60 });
    expect(hi).toBe(150);
  });
});
