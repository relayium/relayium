// L1 adaptive stored-upload behaviour against a SIMULATED link and server.
//
// Fake clock (setTimeout/Date/performance) + a fake fetch whose PATCHes take the
// time a piecewise-constant bandwidth schedule says they take. The simulated
// server commits a cut request's delivered prefix ONLY when `prefixOnAbort` is
// set — that is the behaviour observed on the actual 460 backend behind nginx
// with real Chrome over HTTP/1.1 (l1/proof), and NOT assumed for other paths:
// several cases run with it off. These are logic proofs, not network proofs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleWithFakeTimers } from "./settle-fake-timers";
import {
  keyFromFragment,
  lastChunkedUploadStats,
  resetUploadPacingForTests,
  uploadFileResumable,
  UploadError,
  UploadIncompleteError,
  type UploadProgress,
} from "./stored-file";
import { StoreDecryptor, STORE_CHUNK_SIZE, FRAME_OVERHEAD, cipherSizeFor } from "./store-crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SliceController, TokenBucket, pacedBurst, worstWindowExcess } from "./transfer-control";
import { setSpeedPref } from "./transfer-speed-pref.svelte";

type Phase = { at: number; bps: number };

interface SimOpts {
  chunkSize: number;
  pairRoom?: boolean;
  schedule: Phase[]; // client->server bandwidth from `at` (fake ms since start)
  rttMs?: number;
  prefixOnAbort?: boolean;
  windowSec?: number; // pair room join window
  /** Commit the Nth PATCH (1-based) fully, then lose its answer. */
  loseAnswerOf?: number[];
  /** Answer the Nth PATCH (1-based) with 500 after committing all, half or none
   *  of its body ("always" applies to every PATCH). */
  fail5xx?: Partial<Record<number | "always", "full" | "partial" | "none">>;
  getDelayMs?: number; // delay every offset read
  /** How the simulated server names a new upload session. Default: by arrival
   *  order (u1, u2, …), which depends on how fast each client finished its init
   *  — never assume it matches the order uploads were STARTED in. */
  sessionId?: (declaredSize: number, arrival: number) => string;
  /** The first N offset reads after a lost answer report this stale value. */
  staleProbes?: { count: number; value: number };
  date?: boolean; // send a Date header (default true)
  keepSentBytes?: boolean; // keep a copy of every request body (default true)
}

interface SentSlice { id: string; start: number; bytes: Uint8Array; len: number; t: number; outcome: string }

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function installSim(o: SimOpts) {
  const t0 = Date.now();
  const rtt = o.rttMs ?? 40;
  const windowMs = (o.windowSec ?? 300) * 1000;
  const sessions = new Map<string, { received: number; blob: Uint8Array[] }>();
  let inits = 0;
  const st = {
    declaredById: new Map<string, number>(),
    get received() { return sessions.get("u1")?.received ?? 0; },
    deadlineMs: t0 + windowMs, // room opened at t0
    roomExpired: false,
    sent: [] as SentSlice[],
    gets: 0,
    finalizes: 0,
    afterAbort: [] as string[],
    patchNo: 0,
    maxSlice: 0,
    expiredAt: undefined as number | undefined,
  };
  let stale = o.staleProbes ? { ...o.staleProbes } : undefined;
  let staleArmed = false;
  const bpsAt = (t: number) => {
    let b = o.schedule[0].bps;
    for (const p of o.schedule) if (t - t0 >= p.at) b = p.bps;
    return b;
  };
  // bytes deliverable in [a, b) of absolute fake time
  const deliver = (a: number, b: number) => {
    let n = 0;
    const edges = o.schedule.map((p) => t0 + p.at).filter((e) => e > a && e < b);
    let s = a;
    for (const e of [...edges, b]) { n += (bpsAt(s) / 8) * ((e - s) / 1000); s = e; }
    return n;
  };
  const timeFor = (from: number, len: number) => {
    // smallest t with deliver(from, t) >= len (piecewise linear)
    let s = from;
    let left = len;
    for (;;) {
      const next = o.schedule.map((p) => t0 + p.at).filter((e) => e > s).sort((x, y) => x - y)[0];
      const rate = bpsAt(s) / 8;
      if (rate > 0) {
        const need = (left / rate) * 1000;
        if (next === undefined || s + need <= next) return s + need;
        left -= rate * ((next - s) / 1000);
      } else if (next === undefined) return Infinity;
      s = next;
    }
  };
  const respond = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (h: string) => (h.toLowerCase() === "date" && o.date !== false ? new Date(Date.now()).toUTCString() : null) },
  });
  const roomBody = (b: Record<string, unknown>) =>
    o.pairRoom ? { ...b, expiresAt: Math.floor(st.deadlineMs / 1000) } : b;
  const commit = (id: string, start: number, bytes: Uint8Array, at: number) => {
    const ss = sessions.get(id)!;
    if (o.pairRoom && at > st.deadlineMs) { st.roomExpired = true; st.expiredAt ??= at; return false; }
    if (start !== ss.received || bytes.length === 0) return true;
    ss.blob.push(bytes.slice());
    ss.received += bytes.length;
    if (o.pairRoom) st.deadlineMs = at + windowMs;
    return true;
  };
  let userAborted = false;
  const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<unknown> => {
    const method = init?.method ?? "GET";
    if (process.env.SIMDEBUG) console.log("SIM", Date.now() - t0, method, url, (init?.headers as Record<string, string> | undefined)?.["Content-Range"] ?? "");
    // A fetch handed an already-aborted signal never reaches the network (it
    // rejects at once in browsers), so only live requests count as violations.
    if (userAborted && !(init?.signal as AbortSignal | undefined)?.aborted) st.afterAbort.push(`${method} ${url}`);
    if (method === "POST" && url.startsWith("/api/uploads?")) {
      const declared = Number(new URL(url, "http://sim").searchParams.get("size"));
      const arrival = ++inits;
      const id = o.sessionId ? o.sessionId(declared, arrival) : `u${arrival}`;
      sessions.set(id, { received: 0, blob: [] });
      (st as unknown as { declaredById: Map<string, number> }).declaredById.set(id, declared);
      return Promise.resolve(respond(200, { uploadId: id, chunkSize: o.chunkSize }));
    }
    if (method === "POST" && url.endsWith("/finalize")) {
      st.finalizes++;
      if (o.pairRoom && (st.roomExpired || Date.now() > st.deadlineMs)) return Promise.resolve(respond(410, {}));
      return Promise.resolve(respond(200, { id: "obj1", expiresAt: 999 }));
    }
    const id = /^\/api\/uploads\/(u\d+)/.exec(url)![1];
    const ss = sessions.get(id)!;
    if (method === "GET") {
      st.gets++;
      if (o.pairRoom && (st.roomExpired || Date.now() > st.deadlineMs)) return Promise.resolve(respond(410, {}));
      const answerGet = (body: unknown) => {
        if (!o.getDelayMs) return Promise.resolve(respond(200, body));
        const sig = init?.signal as AbortSignal | undefined;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => { sig?.removeEventListener("abort", ab); resolve(respond(200, body)); }, o.getDelayMs);
          const ab = () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); };
          sig?.addEventListener("abort", ab, { once: true });
        });
      };
      if (stale && staleArmed && stale.count > 0) { stale.count--; return answerGet(roomBody({ received: stale.value })); }
      return answerGet(roomBody({ received: ss.received }));
    }
    // PATCH
    const no = ++st.patchNo;
    const cr = (init!.headers as Record<string, string>)["Content-Range"];
    const start = Number(/bytes (\d+)-/.exec(cr)![1]);
    const bytes = new Uint8Array(init!.body as Uint8Array);
    st.maxSlice = Math.max(st.maxSlice, bytes.length);
    const rec: SentSlice = { id, start, bytes: o.keepSentBytes === false ? new Uint8Array(0) : bytes.slice(), len: bytes.length, t: Date.now(), outcome: "pending" };
    st.sent.push(rec);
    const signal = init!.signal as AbortSignal;
    const tStart = Date.now();
    if (o.pairRoom && (st.roomExpired || tStart > st.deadlineMs)) { st.roomExpired = true; st.expiredAt ??= tStart; rec.outcome = "410"; return Promise.resolve(respond(410, {})); }
    if (start < ss.received) { rec.outcome = "stale-ack"; return Promise.resolve(respond(200, roomBody({ received: ss.received }))); }
    if (start > ss.received) { rec.outcome = "409"; return Promise.resolve(respond(409, roomBody({ received: ss.received }))); }
    const arrive = tStart + rtt / 2;
    const done = timeFor(arrive, bytes.length);
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        if (timer !== undefined) clearTimeout(timer);
        const now = Date.now();
        const got = Math.max(0, Math.min(bytes.length, Math.floor(now > arrive ? deliver(arrive, now) : 0)));
        rec.outcome = `cut@${got}`;
        staleArmed = true; // an offset read right after the cut may predate its settlement
        if (o.prefixOnAbort && got > 0) commit(id, start, bytes.subarray(0, got), now);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!Number.isFinite(done)) return; // never completes; only a cut ends it
      timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        const ok = commit(id, start, bytes, done);
        if (!ok) { rec.outcome = "410"; return resolve(respond(410, {})); }
        if (o.loseAnswerOf?.includes(no)) { rec.outcome = "lost-answer"; staleArmed = true; return reject(new TypeError("network")); }
        const f = o.fail5xx?.[no] ?? o.fail5xx?.always;
        if (f) {
          // undo the full commit above to model "partial" / "none", then answer 500
          const ss2 = sessions.get(id)!;
          if (f !== "full") {
            ss2.blob.pop();
            ss2.received -= bytes.length;
            if (f === "partial") commit(id, start, bytes.subarray(0, Math.ceil(bytes.length / 2)), done);
          }
          rec.outcome = `500-${f}`;
          staleArmed = true;
          return setTimeout(() => resolve(respond(500, {})), rtt / 2);
        }
        rec.outcome = "200";
        setTimeout(() => resolve(respond(200, roomBody({ received: ss.received }))), rtt / 2);
      }, Math.max(0, done - Date.now()));
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const xhrOpened: string[] = [];
  class NoXHR {
    upload = {};
    onerror: (() => void) | null = null;
    open(_m: string, url: string) { xhrOpened.push(url); }
    setRequestHeader() {}
    send() { setTimeout(() => this.onerror?.(), 0); }
    abort() {}
  }
  vi.stubGlobal("XMLHttpRequest", NoXHR);
  (st as unknown as { xhrOpened: string[] }).xhrOpened = xhrOpened;
  return { st, blob: (id = "u1") => concat(sessions.get(id)?.blob ?? []), markUserAbort: () => { userAborted = true; } };
}

async function decrypt(cipher: Uint8Array, key: string): Promise<Uint8Array> {
  const dec = new StoreDecryptor(await keyFromFragment(key));
  const out: Uint8Array[] = [];
  for await (const pt of dec.push(cipher)) out.push(pt);
  for await (const pt of dec.end()) out.push(pt);
  return concat(out);
}

function fixture(bytes: number): { file: File; plain: Uint8Array } {
  const plain = new Uint8Array(bytes);
  for (let i = 0; i < plain.length; i++) plain[i] = (i * 131 + 7) & 0xff;
  return { file: new File([plain], "f.bin"), plain };
}

/** Every absolute offset was always sent with the same byte (no re-encryption). */
function inconsistentOffset(sent: SentSlice[]): number {
  const seen = new Map<number, number>();
  for (const s of sent) for (let i = 0; i < s.bytes.length; i++) {
    const prev = seen.get(s.start + i);
    if (prev === undefined) seen.set(s.start + i, s.bytes[i]);
    else if (prev !== s.bytes[i]) return s.start + i;
  }
  return -1;
}

/** Every pair of request starts: bytes started in [t1, t2] <= rate x span + one
 *  paced burst (the token-bucket guarantee). Returns the worst excess. */
function worstPacingExcess(sent: SentSlice[], _t0: number, rate: number): number {
  return worstWindowExcess(sent.map((x) => ({ t: x.t, bytes: x.len })), rate, pacedBurst(rate));
}

const MiB = 1 << 20;
const FRAME = STORE_CHUNK_SIZE + FRAME_OVERHEAD;
const PAIR = { purpose: "pair_room" as const, code: "123456" };
const SHARE = { burnAfterRead: false, ttl: 0 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  setSpeedPref({ mode: "fast", capBytesPerSec: MiB });
  resetUploadPacingForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSpeedPref({ mode: "fast", capBytesPerSec: MiB });
});

describe("collapse inside a pair room (legacy 1 MiB slices)", () => {
  // 50 Mbit/s for 300 ms, then 20 kbit/s: a 1 MiB slice would need ~7 min,
  // longer than the room's 300 s window measured from the last committed byte.
  const collapse: Phase[] = [{ at: 0, bps: 50_000_000 }, { at: 300, bps: 20_000 }];

  it("cuts, keeps the room alive with the committed prefix, and retries the CURRENT slice smaller", async () => {
    const { file, plain } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, pairRoom: true, schedule: collapse, prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], PAIR));
    expect(out).not.toBeInstanceOf(Error);
    const res = out as Awaited<ReturnType<typeof uploadFileResumable>>;
    expect(sim.st.roomExpired, "the room must never expire under the upload").toBe(false);
    expect(sim.st.maxSlice, "never above the packing target plus one frame").toBeLessThanOrEqual(MiB + FRAME);
    const cuts = sim.st.sent.filter((s) => s.outcome.startsWith("cut@"));
    expect(cuts.length).toBeGreaterThan(0);
    // The slice right after the first cut starts at the committed offset and is
    // smaller than the slice that was cut (shrinking the retry, not just the next chunk).
    const i = sim.st.sent.indexOf(cuts[0]);
    const after = sim.st.sent[i + 1];
    expect(after.bytes.length).toBeLessThan(cuts[0].bytes.length);
    // …and it is the DEMOTED size, not merely the remainder of the cut slice.
    expect(after.bytes.length).toBeLessThanOrEqual(Math.max(64 * 1024, cuts[0].bytes.length / 2));
    expect(after.start).toBe(cuts[0].start + Number(cuts[0].outcome.slice(4)));
    expect(inconsistentOffset(sim.st.sent)).toBe(-1);
    expect(sim.blob().length).toBe(cipherSizeFor([file]));
    expect(await decrypt(sim.blob(), res.key)).toEqual(plain);
    const stats = lastChunkedUploadStats()!;
    expect(stats.watchdogCuts).toBe(cuts.length);
    expect(stats.committedBytes).toBe(cipherSizeFor([file]));
    expect(stats.attemptedPayloadBytes).toBe(sim.st.sent.reduce((n, s) => n + s.bytes.length, 0));
  }, 60_000);

  it("NEGATIVE CONTROL: without the watchdog the same collapse loses the room", async () => {
    vi.spyOn(SliceController.prototype, "watchdogMs").mockReturnValue(undefined);
    const { file } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, pairRoom: true, schedule: collapse, prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], PAIR));
    expect(out).toBeInstanceOf(UploadError);
    expect((out as UploadError).status).toBe(410);
    expect(sim.st.roomExpired).toBe(true);
  }, 60_000);

  it("with a path that commits NOTHING on a cut, a slow-but-moving link still finishes", async () => {
    // 200 kbit/s after the drop: a 1 MiB slice needs ~42 s (> the 8 s pair floor
    // budget derived from the fast start), 64 KiB needs ~2.6 s.
    const { file, plain } = fixture(2 * MiB);
    const sim = installSim({ chunkSize: MiB, pairRoom: true, schedule: [{ at: 0, bps: 50_000_000 }, { at: 300, bps: 200_000 }], prefixOnAbort: false });
    const out = await settleWithFakeTimers(uploadFileResumable([file], PAIR));
    expect(out).not.toBeInstanceOf(Error);
    expect(sim.st.roomExpired).toBe(false);
    expect(await decrypt(sim.blob(), (out as { key: string }).key)).toEqual(plain);
    const stats = lastChunkedUploadStats()!;
    expect(stats.watchdogCuts).toBeGreaterThan(0);
    expect(stats.replayedRequestedBytes).toBeGreaterThan(0); // cut bytes were resent: wasted, and counted
  }, 60_000);
});

describe("ordinary uploads are not timed out for being slow", () => {
  it("a steady slow link from the start is never cut", async () => {
    const { file, plain } = fixture(3 * MiB);
    // 64 kbit/s: one 1 MiB slice takes ~131 s; there is no estimate for the first.
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 64_000 }], prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).not.toBeInstanceOf(Error);
    expect(sim.st.sent.every((s) => s.outcome === "200")).toBe(true);
    expect(await decrypt(sim.blob(), (out as { key: string }).key)).toEqual(plain);
  }, 60_000);

  it("permanent zero throughput fails boundedly, without finalizing", async () => {
    const { file } = fixture(MiB);
    const sim = installSim({ chunkSize: 256 * 1024, schedule: [{ at: 0, bps: 50_000_000 }, { at: 100, bps: 0 }], prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).toBeInstanceOf(Error);
    expect(sim.st.finalizes).toBe(0);
    // Bounded: a handful of cut attempts, each budget at most 64× the first.
    expect(sim.st.sent.filter((s) => s.outcome.startsWith("cut@")).length).toBeLessThanOrEqual(5);
  }, 60_000);
});

describe("lost answers and settling offsets", () => {
  it("a lost answer is recovered from the committed offset with nothing billed twice", async () => {
    const { file, plain } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], loseAnswerOf: [2], prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).not.toBeInstanceOf(Error);
    expect(sim.blob().length).toBe(cipherSizeFor([file]));
    expect(await decrypt(sim.blob(), (out as { key: string }).key)).toEqual(plain);
    expect(lastChunkedUploadStats()!.replayedRequestedBytes).toBe(0);
  }, 60_000);

  it("an offset read that lags a settling append is re-read, not fatal", async () => {
    const { file, plain } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], loseAnswerOf: [2], staleProbes: { count: 1, value: 0 }, prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).not.toBeInstanceOf(Error);
    expect(await decrypt(sim.blob(), (out as { key: string }).key)).toEqual(plain);
    expect(sim.st.gets).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it("an offset that stays behind confirmed bytes fails instead of misaligning", async () => {
    const { file } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], loseAnswerOf: [2], staleProbes: { count: 99, value: 0 }, prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).toBeInstanceOf(UploadError);
    expect(sim.st.finalizes).toBe(0);
  }, 60_000);
});

describe("user cancel wins", () => {
  for (const when of ["during a watchdog-length request", "during a pacing wait"] as const) {
    it(`no offset read, PATCH or finalize after cancel ${when}`, async () => {
      if (when === "during a pacing wait") setSpeedPref({ mode: "cap", capBytesPerSec: 64 * 1024 });
      const { file } = fixture(2 * MiB);
      const sim = installSim({ chunkSize: MiB, pairRoom: true, schedule: [{ at: 0, bps: 50_000_000 }, { at: 300, bps: 20_000 }], prefixOnAbort: true });
      const ac = new AbortController();
      let armed = false;
      const p = uploadFileResumable([file], PAIR, (pr) => {
        if (pr.onWire && !armed) { armed = true; setTimeout(() => { sim.markUserAbort(); ac.abort(); }, 4_000); }
      }, ac.signal);
      const out = await settleWithFakeTimers(p);
      expect(out).toBeInstanceOf(DOMException);
      expect((out as DOMException).name).toBe("AbortError");
      expect(sim.st.afterAbort, JSON.stringify(sim.st.sent.map((x) => [x.start, x.bytes.length, x.t, x.outcome]))).toEqual([]);
      expect(vi.getTimerCount(), "no timer left behind").toBe(0);
    }, 60_000);
  }
});

describe("speed limits pace the actual sending", () => {
  it("cap: average wire rate stays at or below the limit (+ one slice), retries counted", async () => {
    const cap = 256 * 1024; // 2 Mbit/s
    setSpeedPref({ mode: "cap", capBytesPerSec: cap });
    const { file, plain } = fixture(4 * MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 100_000_000 }], loseAnswerOf: [3], prefixOnAbort: true });
    const t0 = Date.now();
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).not.toBeInstanceOf(Error);
    expect(await decrypt(sim.blob(), (out as { key: string }).key)).toEqual(plain);
    expect(worstPacingExcess(sim.st.sent, t0, cap)).toBeLessThanOrEqual(1);
    expect(sim.st.sent.some((s) => s.outcome === "lost-answer")).toBe(true); // a retry was paced too
    expect(sim.st.maxSlice).toBeLessThanOrEqual(cap / 4);
    expect(lastChunkedUploadStats()!.pacingMs).toBeGreaterThan(0);
  }, 60_000);

  it("NEGATIVE CONTROL: a bucket charged for only half of each body overshoots the window bound", async () => {
    const cap = 256 * 1024;
    setSpeedPref({ mode: "cap", capBytesPerSec: cap });
    const real = TokenBucket.prototype.tryTake;
    vi.spyOn(TokenBucket.prototype, "tryTake").mockImplementation(function (this: TokenBucket, t, bytes: number, rate: number, capacity: number) {
      return real.call(this, t, bytes / 2, rate, capacity);
    });
    const { file } = fixture(4 * MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 100_000_000 }], prefixOnAbort: true });
    const t0 = Date.now();
    await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(worstPacingExcess(sim.st.sent, t0, cap)).toBeGreaterThan(1);
  }, 60_000);

  for (const scrambled of [false, true]) {
    it("two concurrent capped uploads share one limit" + (scrambled ? " with fixed scrambled session ids" : ""), async () => {
      const cap = 256 * 1024;
      setSpeedPref({ mode: "cap", capBytesPerSec: cap });
      const files = [fixture(MiB / 2), fixture(MiB / 2 + 37)];
      const sim = installSim({
        chunkSize: MiB, schedule: [{ at: 0, bps: 100_000_000 }], prefixOnAbort: true,
        sessionId: scrambled ? (size) => size === cipherSizeFor([files[0].file]) ? "u2" : "u1" : undefined,
      });
      const t0 = Date.now();
      const both = Promise.all(files.map((f) => uploadFileResumable([f.file], SHARE)));
      const res = await settleWithFakeTimers(both);
      expect(res).not.toBeInstanceOf(Error);
      const out = res as Array<{ key: string }>;
      // Real WebCrypto decides init arrival order. The response key belongs to
      // its task, not whichever opaque id happened to reach the server first.
      for (let i = 0; i < files.length; i++) {
        const size = cipherSizeFor([files[i].file]);
        const ids = [...sim.st.declaredById].filter(([, n]) => n === size).map(([id]) => id);
        expect(ids, "exactly one session per upload's declared ciphertext size").toHaveLength(1);
        const got = await decrypt(sim.blob(ids[0]), out[i].key);
        expect(got.length).toBe(files[i].plain.length);
        expect(Buffer.compare(Buffer.from(got), Buffer.from(files[i].plain))).toBe(0);
      }
      expect(worstPacingExcess(sim.st.sent, t0, cap)).toBeLessThanOrEqual(1);
    }, 60_000);
  }

  it("switching to Fastest ends a pacing wait at once", async () => {
    setSpeedPref({ mode: "cap", capBytesPerSec: 32 * 1024 });
    const { file } = fixture(MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 100_000_000 }], prefixOnAbort: true });
    const p = uploadFileResumable([file], SHARE);
    setTimeout(() => setSpeedPref({ mode: "fast", capBytesPerSec: 32 * 1024 }), 3_000);
    const t0 = Date.now();
    const out = await settleWithFakeTimers(p);
    expect(out).not.toBeInstanceOf(Error);
    // ~1 MiB at 32 KiB/s would take ~32 s; after the switch at 3 s it is unlimited.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(sim.st.maxSlice).toBeLessThanOrEqual(MiB + FRAME);
  }, 60_000);

  it("switching to Fastest re-plans every waiting upload within one wait step, even with a shared backlog", async () => {
    setSpeedPref({ mode: "cap", capBytesPerSec: 32 * 1024 });
    const files = [fixture(MiB / 2), fixture(MiB / 2), fixture(MiB / 2)];
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 100_000_000 }], prefixOnAbort: true, keepSentBytes: false });
    const t0 = Date.now();
    const all = Promise.all(files.map((f) => uploadFileResumable([f.file], SHARE)));
    const switchAt = 4_000;
    setTimeout(() => setSpeedPref({ mode: "fast", capBytesPerSec: 32 * 1024 }), switchAt);
    const out = await settleWithFakeTimers(all);
    expect(out).not.toBeInstanceOf(Error);
    for (const id of ["u1", "u2", "u3"]) {
      const next = sim.st.sent.find((x) => x.id === id && x.t - t0 >= switchAt);
      if (next) expect(next.t - t0 - switchAt, id).toBeLessThanOrEqual(300);
    }
  }, 60_000);

  it("Fastest adds no artificial delay", async () => {
    const { file } = fixture(4 * MiB);
    installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 100_000_000 }], prefixOnAbort: true });
    await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(lastChunkedUploadStats()!.pacingMs).toBe(0);
  }, 60_000);
});

describe("progress, rate and ETA are confirmed-bytes only", () => {
  it("no rate/ETA before enough confirmed history; when shown, ETA matches the confirmed remainder", async () => {
    const { file } = fixture(4 * MiB);
    installSim({ chunkSize: 256 * 1024, schedule: [{ at: 0, bps: 2_000_000 }], prefixOnAbort: true });
    const ticks: Array<UploadProgress & { at: number }> = [];
    const t0 = Date.now();
    await settleWithFakeTimers(uploadFileResumable([file], SHARE, (p) => ticks.push({ ...p, at: Date.now() - t0 })));
    const withRate = ticks.filter((t) => t.rate !== undefined);
    expect(withRate.length).toBeGreaterThan(0);
    expect(ticks.filter((t) => t.at < 3_000).every((t) => t.rate === undefined)).toBe(true);
    for (const t of withRate) {
      expect(t.rate!).toBeGreaterThan(200_000); // ~250 KB/s link, minus RTT
      expect(t.rate!).toBeLessThanOrEqual(250_000 * 1.01);
      if (t.etaMs !== undefined) expect(Math.abs(t.etaMs - ((t.total - t.sent) * 1000) / t.rate!)).toBeLessThan(1);
    }
    // sent never decreases
    for (let i = 1; i < ticks.length; i++) expect(ticks[i].sent).toBeGreaterThanOrEqual(ticks[i - 1].sent);
  }, 60_000);
});

describe("memory bound", () => {
  it("a hostile chunkSize is clamped to 64 MiB instead of allocated", async () => {
    const { file } = fixture(STORE_CHUNK_SIZE * 2);
    const sim = installSim({ chunkSize: 2 ** 40, schedule: [{ at: 0, bps: 100_000_000 }], prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).not.toBeInstanceOf(Error);
    expect(sim.st.sent.length).toBe(1);
  }, 60_000);
});

describe("answers that never move the offset", () => {
  it("fail boundedly instead of re-sending the same slice forever", async () => {
    const { file } = fixture(MiB);
    let patches = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
      if ((init?.method ?? "GET") === "POST" && url.startsWith("/api/uploads?")) return ok({ uploadId: "u1", chunkSize: 256 * 1024 });
      if (init?.method === "PATCH") { patches++; return ok({ received: 0 }); }
      return ok({ received: 0 });
    }));
    const out = await settleWithFakeTimers(uploadFileResumable([file], PAIR));
    expect(out).toBeInstanceOf(UploadError);
    expect(patches).toBe(5);
  }, 60_000);
});

describe("default fast packing is the pre-L1 request shape", () => {
  const vectors = JSON.parse(readFileSync(resolve(__dirname, "../../../contracts/transfer-control-v1.json"), "utf8"));
  for (const c of vectors.requestCount.cases as Array<{ plainBytes: number; chunkSize: number; expectRequests: number }>) {
    it(`${c.plainBytes} B with chunkSize ${c.chunkSize}: ${c.expectRequests} request(s), each one whole greedy pack`, async () => {
      const { file, plain } = fixture(c.plainBytes);
      const sim = installSim({ chunkSize: c.chunkSize, schedule: [{ at: 0, bps: 10e9 }], rttMs: 0, prefixOnAbort: true, keepSentBytes: false });
      const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
      expect(out).not.toBeInstanceOf(Error);
      expect(sim.st.sent.length).toBe(c.expectRequests);
      // every request but the last is >= chunkSize and < chunkSize + one frame
      for (const x of sim.st.sent.slice(0, -1)) {
        expect(x.len).toBeGreaterThanOrEqual(c.chunkSize);
        expect(x.len).toBeLessThan(c.chunkSize + FRAME);
      }
      const got = await decrypt(sim.blob(), (out as { key: string }).key);
      expect(got.length).toBe(plain.length);
      expect(Buffer.compare(Buffer.from(got), Buffer.from(plain))).toBe(0);
      expect(lastChunkedUploadStats()!.pacingMs).toBe(0);
    }, 120_000);
  }
});

describe("pacing with a cancel in the middle of a queue (Root A/B/C/D, end to end)", () => {
  // Three uploads of DISTINCT sizes, so each one's session is found by the
  // ciphertext size its init declared — not by the order inits happened to
  // reach the server, which depends on real WebCrypto timing (that assumption
  // made this case fail about once in nine runs).
  const runMiddleCancel = async (sessionId?: SimOpts["sessionId"]) => {
    const rate = 64 * 1024;
    setSpeedPref({ mode: "cap", capBytesPerSec: rate });
    const files = [fixture(MiB / 4), fixture(MiB / 4 + 4096), fixture(MiB / 4 + 8192)];
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 100_000_000 }], prefixOnAbort: true, keepSentBytes: false, sessionId });
    const t0 = Date.now();
    const acs = files.map(() => new AbortController());
    const ps = files.map((f, i) => uploadFileResumable([f.file], SHARE, undefined, acs[i].signal).then((v) => v, (e) => e));
    let cancelledAt = 0;
    setTimeout(() => { cancelledAt = Date.now(); acs[1].abort(); }, 1_100);
    const out = (await settleWithFakeTimers(Promise.all(ps))) as unknown[];
    const declared = (sim.st as unknown as { declaredById: Map<string, number> }).declaredById;
    const sessionOf = (i: number) => {
      const want = cipherSizeFor([files[i].file]);
      const ids = [...declared].filter(([, size]) => size === want).map(([id]) => id);
      expect(ids, `exactly one session declared upload ${i}'s ciphertext size`).toHaveLength(1);
      return ids[0];
    };
    return { sim, out, files, t0, rate, cancelledAt, sessionOf };
  };

  /** The case's assertions, written against the task -> session mapping. */
  const assertMiddleCancel = async (r: Awaited<ReturnType<typeof runMiddleCancel>>) => {
    const { sim, out, files, t0, rate, cancelledAt, sessionOf } = r;
    expect(worstPacingExcess(sim.st.sent, t0, rate), "window bound").toBeLessThanOrEqual(1);
    expect((out[1] as DOMException).name).toBe("AbortError");
    expect(out[0]).not.toBeInstanceOf(Error);
    expect(out[2]).not.toBeInstanceOf(Error);
    expect(cancelledAt).toBeGreaterThan(0);
    expect(sim.st.sent.filter((x) => x.id === sessionOf(1) && x.t > cancelledAt), "nothing from the cancelled upload after its cancel").toEqual([]);
    expect((sim.st as unknown as { xhrOpened: string[] }).xhrOpened).toEqual([]);
    for (const i of [0, 2]) {
      const got = await decrypt(sim.blob(sessionOf(i)), (out[i] as { key: string }).key);
      expect(got.length).toBe(files[i].plain.length);
      expect(Buffer.compare(Buffer.from(got), Buffer.from(files[i].plain))).toBe(0);
    }
  };

  /** What the case asserted before: session ids assumed to follow start order. */
  const oldHardcodedIdsHold = async (r: Awaited<ReturnType<typeof runMiddleCancel>>) => {
    const { sim, out, files, cancelledAt } = r;
    if (sim.st.sent.some((x) => x.id === "u2" && x.t > cancelledAt)) return false;
    for (const [i, id] of ["u1", "u3"].entries()) {
      try {
        const got = await decrypt(sim.blob(id), (out[i * 2] as { key: string }).key);
        if (Buffer.compare(Buffer.from(got), Buffer.from(files[i * 2].plain)) !== 0) return false;
      } catch {
        return false;
      }
    }
    return true;
  };

  it("three capped uploads, the middle one cancelled while waiting: window bound holds, nothing more from it", async () => {
    await assertMiddleCancel(await runMiddleCancel());
  }, 60_000);

  it("CONTROL: with session ids deliberately NOT in start order, the size-correlated assertions still hold and the old hard-coded ids do not", async () => {
    // Deterministic permutation, independent of arrival order: the server names
    // each session after the NEXT upload's size rank (rank 0 -> u2, 1 -> u3, 2 -> u1).
    const sizes = [MiB / 4, MiB / 4 + 4096, MiB / 4 + 8192].map((n) => cipherSizeFor([new File([new Uint8Array(n)], "x")]));
    const permuted = (declared: number) => ["u2", "u3", "u1"][sizes.indexOf(declared)];
    const r = await runMiddleCancel(permuted);
    expect(r.sessionOf(1), "the cancelled upload is NOT u2 here").toBe("u3");
    await assertMiddleCancel(r);
    expect(await oldHardcodedIdsHold(r), "the old start-order assumption must be refuted by this control").toBe(false);
  }, 60_000);
});

describe("5xx and lost answers are retried on the SAME session, never by re-uploading (B1)", () => {
  const xhr = (sim: ReturnType<typeof installSim>) => (sim.st as unknown as { xhrOpened: string[] }).xhrOpened;
  const cases: Array<[string, SimOpts["fail5xx"], number[] | undefined, { count: number; value: number } | undefined]> = [
    ["500 after a FULL commit of the second request", { 2: "full" }, undefined, undefined],
    ["500 after a PARTIAL commit", { 2: "partial" }, undefined, undefined],
    ["500 with nothing committed", { 2: "none" }, undefined, undefined],
    ["FIRST request's answer lost, offset read stale at 0", undefined, [1], { count: 1, value: 0 }],
    ["FIRST request 500 after full commit, offset read stale at 0", { 1: "full" }, undefined, { count: 1, value: 0 }],
  ];
  for (const [label, fail5xx, lose, stale] of cases) {
    it(label, async () => {
      const { file, plain } = fixture(3 * MiB);
      const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], fail5xx, loseAnswerOf: lose, staleProbes: stale, prefixOnAbort: true });
      const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
      expect(out).not.toBeInstanceOf(Error);
      const blob = sim.blob();
      expect(blob.length).toBe(cipherSizeFor([file])); // each ciphertext byte committed exactly once
      const got = await decrypt(blob, (out as { key: string }).key);
      expect(got.length).toBe(plain.length);
      expect(Buffer.compare(Buffer.from(got), Buffer.from(plain))).toBe(0);
      expect(inconsistentOffset(sim.st.sent)).toBe(-1); // same retained ciphertext
      expect(xhr(sim)).toEqual([]); // no single-shot re-upload
      expect(sim.st.finalizes).toBe(1);
    }, 60_000);
  }

  it("a persistent 5xx with no progress fails boundedly as UploadIncompleteError, no fallback, no finalize", async () => {
    const { file } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], fail5xx: { always: "none" }, prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(xhr(sim), "no single-shot re-upload after a PATCH went out").toEqual([]);
    expect(out).toBeInstanceOf(UploadIncompleteError);
    expect((out as UploadIncompleteError).status).toBe(500);
    expect((out as UploadIncompleteError).committedBytes).toBe(0);
    expect(sim.st.sent.length).toBe(5);
    expect(sim.st.finalizes).toBe(0);
  }, 60_000);

  it("4 failures without progress then 1 with progress, repeatedly: progress resets the budget", async () => {
    const { file, plain } = fixture(MiB / 2);
    const pattern: Record<number, "partial" | "none"> = {};
    for (let n = 1; n <= 400; n++) pattern[n] = n % 5 === 0 ? "partial" : "none";
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], fail5xx: pattern, prefixOnAbort: true, keepSentBytes: false });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).not.toBeInstanceOf(Error);
    expect(sim.st.sent.length).toBeGreaterThan(10);
    const got = await decrypt(sim.blob(), (out as { key: string }).key);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(plain))).toBe(0);
    expect(xhr(sim)).toEqual([]);
  }, 120_000);

  it("5xx that keeps committing a little is never failed for being slow", async () => {
    const { file, plain } = fixture(2 * MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], fail5xx: { always: "partial" }, prefixOnAbort: true });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).not.toBeInstanceOf(Error);
    expect(sim.st.sent.length).toBeGreaterThan(5); // more than the no-progress budget
    const got = await decrypt(sim.blob(), (out as { key: string }).key);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(plain))).toBe(0);
    expect(xhr(sim)).toEqual([]);
  }, 60_000);

  for (const when of ["in the 5xx backoff", "in the offset read", "in a pacing wait"] as const) {
    it(`a cancel ${when} ends it: no later GET, PATCH or finalize`, async () => {
      if (when === "in a pacing wait") setSpeedPref({ mode: "cap", capBytesPerSec: 32 * 1024 });
      const { file } = fixture(MiB);
      const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], fail5xx: { always: "none" }, prefixOnAbort: true, getDelayMs: when === "in the offset read" ? 2_000 : 0 });
      const ac = new AbortController();
      let armed = false;
      const p = uploadFileResumable([file], SHARE, (pr) => {
        if (pr.onWire && !armed) {
          armed = true;
          const at = when === "in the 5xx backoff" ? 1_100 : when === "in the offset read" ? 1_000 : 600;
          setTimeout(() => { sim.markUserAbort(); ac.abort(); }, at);
        }
      }, ac.signal);
      const out = await settleWithFakeTimers(p);
      expect((out as DOMException).name).toBe("AbortError");
      expect(sim.st.afterAbort).toEqual([]);
      expect(xhr(sim)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    }, 60_000);
  }
});

describe("an answer can never confirm bytes that were not sent (ACK ceiling = highest byte dispatched)", () => {
  it("Root R4 case: cap 32 KiB/s, first body 32 KiB, server claims 65536 — rejected before any progress or second PATCH", async () => {
    setSpeedPref({ mode: "cap", capBytesPerSec: 32 * 1024 });
    const patches: string[] = [];
    const progress: number[] = [];
    let xhrOpened = 0;
    vi.stubGlobal("XMLHttpRequest", class { open() { xhrOpened++; } setRequestHeader() {} send() {} abort() {} upload = {}; });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } });
      if (method === "POST" && url.startsWith("/api/uploads?")) return ok({ uploadId: "u1", chunkSize: MiB });
      if (method === "PATCH") {
        patches.push((init!.headers as Record<string, string>)["Content-Range"]);
        return patches.length === 1 ? ok({ received: 65536 }) : ok({}, 400);
      }
      if (method === "GET") return ok({ received: 65536 });
      return ok({}, 500);
    }));
    const { file } = fixture(MiB);
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE, (p) => progress.push(p.sent)));
    expect(patches).toEqual([`bytes 0-32767/${cipherSizeFor([file])}`]);
    expect(Math.max(...progress)).toBeLessThanOrEqual(32768);
    expect(out).toBeInstanceOf(UploadError);
    expect(xhrOpened).toBe(0);
  }, 60_000);

  it("legitimate: an earlier LARGER request settles after a smaller retry was sent, and is accepted", async () => {
    // Pair room collapse: the second 1 MiB+ request (starting at 6 frames) is cut,
    // the offset read right after still shows the pre-cut offset (its settlement is
    // not visible yet), the demoted retry from there is answered with the earlier request's
    // settled offset — beyond the retry's end but within what was dispatched.
    const { file, plain } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, pairRoom: true, schedule: [{ at: 0, bps: 50_000_000 }, { at: 300, bps: 200_000 }], prefixOnAbort: true, staleProbes: { count: 1, value: 6 * FRAME } });
    const out = await settleWithFakeTimers(uploadFileResumable([file], PAIR));
    expect(out).not.toBeInstanceOf(Error);
    const cutIdx = sim.st.sent.findIndex((x) => x.outcome.startsWith("cut@"));
    expect(cutIdx).toBeGreaterThanOrEqual(0);
    const cut = sim.st.sent[cutIdx];
    const retry = sim.st.sent[cutIdx + 1];
    expect(retry.start).toBe(cut.start); // the stale read sent it back to the cut slice's start
    expect(retry.outcome).toBe("stale-ack"); // answered with the larger, earlier-settled offset
    const next = sim.st.sent[cutIdx + 2];
    expect(next.start, "accepted offset lies beyond the smaller retry's end").toBeGreaterThan(retry.start + retry.len);
    expect(next.start).toBeLessThanOrEqual(cut.start + cut.len); // and within what was dispatched
    expect(inconsistentOffset(sim.st.sent)).toBe(-1);
    const got = await decrypt(sim.blob(), (out as { key: string }).key);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(plain))).toBe(0);
    expect(sim.blob().length).toBe(cipherSizeFor([file]));
  }, 60_000);
});

describe("no deliberate backoff once the WHOLE failed flight is known committed (R5 / Fable N3)", () => {
  // Gap between the start of request k and of request k+1, minus the time the
  // simulated link needs for k's body and its round trip. A deliberate backoff
  // shows up as >= 300 ms of extra idle; none as ~0.
  const bodyMs = (len: number, bps: number, rtt = 40) => (len * 8 * 1000) / bps + rtt;
  const idleAfter = (sent: SentSlice[], k: number, bps: number) => sent[k + 1].t - sent[k].t - bodyMs(sent[k].len, bps);

  const fullCommitCases: Array<[string, Partial<SimOpts>]> = [
    ["500 after the full slice committed", { fail5xx: { 2: "full" } }],
    ["answer lost after the full slice committed", { loseAnswerOf: [2] }],
  ];
  for (const [label, opts] of fullCommitCases) {
    it(`${label}: continues at once on the same session, finalizes once`, async () => {
      const { file, plain } = fixture(3 * MiB);
      const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], prefixOnAbort: true, ...opts });
      const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
      expect(out).not.toBeInstanceOf(Error);
      expect(idleAfter(sim.st.sent, 1, 50_000_000), "no deliberate backoff").toBeLessThan(100);
      expect(sim.st.finalizes).toBe(1);
      expect(sim.blob().length).toBe(cipherSizeFor([file]));
      const got = await decrypt(sim.blob(), (out as { key: string }).key);
      expect(Buffer.compare(Buffer.from(got), Buffer.from(plain))).toBe(0);
    }, 60_000);
  }

  it("500 after a PARTIAL commit still backs off before resending the tail", async () => {
    const { file } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, schedule: [{ at: 0, bps: 50_000_000 }], prefixOnAbort: true, fail5xx: { 2: "partial" } });
    const out = await settleWithFakeTimers(uploadFileResumable([file], SHARE));
    expect(out).not.toBeInstanceOf(Error);
    expect(idleAfter(sim.st.sent, 1, 50_000_000), "backoff kept (link-model rounding < 1 ms)").toBeGreaterThanOrEqual(290);
  }, 60_000);

  it("a smaller retry fully committed while an earlier LARGER flight is unresolved still backs off", async () => {
    // Pair-room collapse: request 2 (1 MiB+) is cut with a prefix committed; the
    // demoted retry (request 3) then gets a 500 after committing all of ITSELF —
    // but the cut slice's tail beyond it is still outstanding.
    const { file } = fixture(3 * MiB);
    const sim = installSim({ chunkSize: MiB, pairRoom: true, schedule: [{ at: 0, bps: 50_000_000 }, { at: 300, bps: 200_000 }], prefixOnAbort: true, fail5xx: { 3: "full" } });
    const out = await settleWithFakeTimers(uploadFileResumable([file], PAIR));
    expect(out).not.toBeInstanceOf(Error);
    expect(sim.st.sent[1].outcome.startsWith("cut@")).toBe(true);
    expect(sim.st.sent[2].outcome).toBe("500-full");
    expect(sim.st.sent[3].start, "the tail of the cut slice is still to send").toBeLessThan(sim.st.sent[1].start + sim.st.sent[1].len);
    expect(idleAfter(sim.st.sent, 2, 200_000), "backoff kept (link-model rounding < 1 ms)").toBeGreaterThanOrEqual(290);
  }, 60_000);
});
