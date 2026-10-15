// Client-side control of one stored (resumable) upload: how large each PATCH
// slice is, how long one PATCH may run before it is cut and retried smaller,
// how requests are spaced when the user asked for a limit, and what rate/ETA
// may honestly be shown. Pure logic with an injected clock — the network side
// lives in stored-file.ts. Spec: docs/protocol/relayium-transfer-control-v1.md.
//
// Nothing here changes what is encrypted or what the server is asked to store.
// A slice is a range of the SAME already-produced ciphertext; shrinking a retry
// never re-encrypts, and every byte still goes out in strict offset order with
// one request in flight.

/** Hard memory bound on a server-issued chunkSize. Apple and Android clients
 *  accept up to 64 MiB; a larger (or hostile) value is clamped instead of being
 *  turned into a buffer allocation. Values at or below it are used verbatim. */
export const MAX_SLICE_BYTES = 64 << 20;
/** chunkSize when the server sends none (older servers). Unchanged from before. */
export const DEFAULT_SLICE_BYTES = 8 << 20;
/** The smallest slice a collapse may demote an unlimited upload to. */
export const MIN_FAST_SLICE = 64 * 1024;
/** The smallest slice a rate-limited upload sends: below this, per-request cost
 *  (headers, a server fsync and a database commit per PATCH) dominates. */
export const MIN_PACED_SLICE = 32 * 1024;
/** Paced slices aim to be at most this much of the limit's worth of bytes. */
export const PACED_BURST_MS = 250;
/** Range of a user-chosen cap, bytes per second. */
export const MIN_CAP_BPS = 32 * 1024;
export const MAX_CAP_BPS = 1 << 30;
/** "Background": this share of the reference upload rate, never below
 *  BACKGROUND_FLOOR_BPS. The reference is an EWMA over PROBE-SIZED requests only
 *  (>= BACKGROUND_PROBE_SLICE), a size that does not depend on the limit, so the
 *  mode's own small paced requests cannot talk it down; and it follows a slower
 *  network because a probe-sized request is re-sent every BACKGROUND_PROBE_EVERY
 *  requests. Provisional L1 policy — see the protocol doc. */
export const BACKGROUND_SHARE = 0.5;
export const BACKGROUND_FLOOR_BPS = 32 * 1024;
export const BACKGROUND_PROBE_EVERY = 8;
/** First request of a background upload when nothing has been measured yet. */
export const BACKGROUND_PROBE_SLICE = 256 * 1024;
/** A demoted upload grows back while a slice answers within this time. */
export const FAST_TARGET_MS = 2_000;
/** A PATCH may take this many times its expected duration before it is cut. */
export const WATCHDOG_FACTOR = 4;
/** Ordinary uploads have no deadline: never cut a request sooner than this. */
export const WATCHDOG_FLOOR_MS = 20_000;
/** Pair-room uploads: never cut sooner than this … */
export const PAIR_WATCHDOG_FLOOR_MS = 8_000;
/** … and cut no later than this before the room's join deadline, leaving the
 *  server time to commit (and so renew the room with) the prefix that landed
 *  and this client time to read the offset back. */
export const PAIR_DEADLINE_MARGIN_MS = 30_000;
/** A deadline-derived cut is never scheduled sooner than this after the start. */
export const MIN_DEADLINE_CUT_MS = 1_000;
/** Default-fast request packing (unchanged from before L1): ciphertext frames are
 *  appended until the buffer holds AT LEAST the server's chunkSize, and the
 *  whole buffer is one request. The server's chunkSize is a packing target, not a
 *  byte limit: a request may exceed it by up to one frame (its append cap is
 *  larger). Smaller slices are cut only when demoted after a collapse or paced. */
export const PACKING = "greedy-frames-to-chunkSize";
/** Upper bound on a pair room's remaining window as computed here: the server's
 *  join window is 300 s from the last committed byte, so anything larger is a
 *  clock disagreement and is not trusted. */
export const PAIR_WINDOW_CEILING_MS = 300_000;
/** Consecutive request failures with NO committed progress before giving up. */
export const MAX_FAULTS_WITHOUT_PROGRESS = 5;

export type SpeedMode = "fast" | "background" | "cap";
export interface SpeedPref {
  mode: SpeedMode;
  /** Bytes per second; only read in "cap" mode. */
  capBytesPerSec: number;
}
export const DEFAULT_SPEED_PREF: SpeedPref = { mode: "fast", capBytesPerSec: 1 << 20 };

/** The legacy per-request maximum, from init's `chunkSize`. A positive integer is
 *  the server's word (bounded by MAX_SLICE_BYTES); anything else is the old
 *  default. This is the ONLY maximum: L1 never sends a slice larger than the
 *  server issued, for any purpose. */
export function legacySliceMax(chunkSize: unknown): number {
  if (typeof chunkSize === "number" && Number.isSafeInteger(chunkSize) && chunkSize > 0) {
    return Math.min(chunkSize, MAX_SLICE_BYTES);
  }
  return DEFAULT_SLICE_BYTES;
}

export function clampCap(bps: number): number {
  if (!Number.isFinite(bps)) return DEFAULT_SPEED_PREF.capBytesPerSec;
  return Math.min(MAX_CAP_BPS, Math.max(MIN_CAP_BPS, Math.round(bps)));
}

/** Slice sizing and per-request time budget for one upload. */
export class SliceController {
  readonly max: number;
  /** Current unlimited-mode slice; below `max` only after a collapse. */
  private cur: number;
  /** EWMA of per-request rate (bytes committed / request wall time), B/s. */
  private ewma: number | undefined;
  /** Background reference rate: EWMA over probe-sized requests only. */
  private bgRef: number | undefined;
  /** Requests answered since the last probe-sized one. */
  private sinceProbe = 0;

  constructor(max: number) {
    this.max = Math.max(1, Math.floor(max));
    this.cur = this.max;
  }

  goodput(): number | undefined {
    return this.ewma;
  }

  backgroundReference(): number | undefined {
    return this.bgRef;
  }

  /** True after a collapse demoted the unlimited slice below the packing target. */
  demoted(): boolean {
    return this.cur < this.max;
  }

  /** The rate pacing should hold this upload to, or undefined for no pacing. */
  paceRate(pref: SpeedPref): number | undefined {
    if (pref.mode === "cap") return clampCap(pref.capBytesPerSec);
    if (pref.mode === "background") {
      if (this.bgRef === undefined) return undefined; // first (probe) request
      return Math.max(BACKGROUND_FLOOR_BPS, this.bgRef * BACKGROUND_SHARE);
    }
    return undefined;
  }

  /** The burst capacity for pacing under `pref`: the largest body next() can
   *  return while paced (a background probe may be larger than rate x 250 ms). */
  burstCapacity(pref: SpeedPref): number {
    const rate = this.paceRate(pref);
    if (rate === undefined) return this.max;
    const base = Math.min(this.max, pacedBurst(rate));
    return pref.mode === "background" ? Math.max(base, Math.min(this.max, BACKGROUND_PROBE_SLICE)) : base;
  }

  /** Target size of the next slice. In unlimited, non-demoted operation this is
   *  `max` and the caller packs greedily (see PACKING); otherwise it is the
   *  exact byte length to cut from the retained ciphertext. */
  next(pref: SpeedPref): number {
    if (pref.mode === "background" && (this.bgRef === undefined || this.sinceProbe >= BACKGROUND_PROBE_EVERY)) {
      return Math.min(this.cur, this.max, BACKGROUND_PROBE_SLICE);
    }
    const rate = this.paceRate(pref);
    if (rate === undefined) return this.cur;
    const paced = Math.max(MIN_PACED_SLICE, Math.floor((rate * PACED_BURST_MS) / 1000));
    return Math.min(this.cur, paced, this.max);
  }

  private sample(bytes: number, ms: number): number | undefined {
    if (bytes <= 0 || ms <= 0) return undefined;
    const r = (bytes * 1000) / ms;
    this.ewma = this.ewma === undefined ? r : this.ewma * 0.7 + r * 0.3;
    if (bytes >= Math.min(BACKGROUND_PROBE_SLICE, this.max)) {
      this.bgRef = this.bgRef === undefined ? r : this.bgRef * 0.5 + r * 0.5;
      this.sinceProbe = 0;
    } else {
      this.sinceProbe += 1;
    }
    return r;
  }

  /** A request answered (200 or 409) after `ms`, committing `bytes` new bytes. */
  onAnswered(bytes: number, ms: number): void {
    this.sample(bytes, ms);
    if (this.cur < this.max && bytes > 0 && ms <= FAST_TARGET_MS) {
      this.cur = Math.min(this.max, this.cur * 2);
    }
  }

  /** A request was cut by the watchdog after `ms`; `committed` bytes of its
   *  slice turned out to have landed. Shrinks the next slice — including the
   *  retry of the rest of this one — to what the observed rate can deliver in
   *  FAST_TARGET_MS, and always to at most half of what was just tried. */
  onCollapse(committed: number, tried: number, ms: number): void {
    const observed = ms > 0 ? (Math.max(0, committed) * 1000) / ms : 0;
    if (observed > 0) this.ewma = this.ewma === undefined ? observed : Math.min(this.ewma, observed);
    if (this.bgRef !== undefined) this.bgRef = Math.min(this.bgRef, observed > 0 ? observed : this.bgRef / 2);
    const fit = Math.floor((observed * FAST_TARGET_MS) / 1000);
    this.cur = Math.min(this.max, Math.max(MIN_FAST_SLICE, Math.min(Math.floor(tried / 2), fit)));
  }

  /**
   * How long the next request of `sliceLen` bytes may run, or undefined for "let
   * it run" (the pre-L1 behaviour: the server's own lifetime bounds it).
   *
   *  - Nothing measured yet: no budget for an ordinary upload; a pair room is
   *    bounded only by its deadline.
   *  - Measured: WATCHDOG_FACTOR × expected, at least the floor, doubled for each
   *    consecutive request that committed nothing — a slow link that keeps
   *    moving bytes is never cut repeatedly, because each cut lowers the rate
   *    estimate and so lengthens the next budget.
   *  - Pair room with a known deadline: additionally at most
   *    remaining − PAIR_DEADLINE_MARGIN_MS. If that is below the floor, a cut
   *    could not help, so there is no budget.
   */
  watchdogMs(sliceLen: number, opts: { pairRoom: boolean; roomRemainingMs?: number; stalls: number }): number | undefined {
    const floor = opts.pairRoom ? PAIR_WATCHDOG_FLOOR_MS : WATCHDOG_FLOOR_MS;
    let budget: number | undefined;
    if (this.ewma !== undefined && this.ewma > 0) {
      const expected = (sliceLen * 1000) / this.ewma;
      budget = Math.max(floor, WATCHDOG_FACTOR * expected) * 2 ** Math.min(Math.max(0, opts.stalls), 6);
    }
    if (opts.pairRoom && opts.roomRemainingMs !== undefined) {
      // Cutting before the deadline is what lets the prefix that landed renew
      // the room; once inside the margin a cut can no longer be settled in
      // time, so the request is left to the server's own answer (410 if over).
      const byDeadline = opts.roomRemainingMs - PAIR_DEADLINE_MARGIN_MS;
      if (byDeadline < MIN_DEADLINE_CUT_MS) return undefined;
      budget = budget === undefined ? byDeadline : Math.min(budget, byDeadline);
    }
    return budget;
  }
}

/** Remaining time of a pair room's join window, from the server's own clock.
 *  `expiresAtSec` and the `Date` header are both server time, so client clock
 *  skew cancels out; without a Date header the local clock is used, and either
 *  way the result is clamped to [0, PAIR_WINDOW_CEILING_MS] and ages with the
 *  local monotonic clock since the answer arrived. */
export function roomRemainingMs(
  d: { expiresAtSec: number; serverNowMs: number; receivedAtMono: number },
  nowMono: number,
): number {
  const left = d.expiresAtSec * 1000 - (d.serverNowMs + (nowMono - d.receivedAtMono));
  if (!Number.isFinite(left)) return 0;
  return Math.min(PAIR_WINDOW_CEILING_MS, Math.max(0, left));
}

/**
 * Request spacing ("pacing") shared by every upload in this page: a token bucket
 * with a FIFO of waiting tickets.
 *
 * - Tokens (request-body bytes) refill at `rate` from actual monotonic elapsed
 *   time, up to `capacity` (one paced burst). Nothing accumulates beyond that, so
 *   a long idle period or a cancel never buys a catch-up burst.
 * - Only an actual dispatch consumes tokens: a waiting ticket holds nothing, so
 *   cancelling it (or re-planning after a setting change) needs no refund and
 *   cannot move anyone else's schedule.
 * - Only the head ticket may take tokens, so concurrent uploads are served in
 *   order and two bodies cannot both be released by one refill.
 * Guarantee (with every body <= capacity): for any two dispatch instants
 * t1 <= t2, the bytes dispatched in [t1, t2] are at most
 * rate x (t2 - t1) + capacity. Each body still leaves at network speed.
 * Every attempt is charged — retries and requests later cut included.
 */
export interface PaceTicket {
  readonly id: number;
}

export class TokenBucket {
  private tokens: number | undefined;
  private last = 0;
  private lastRate = 0;
  private queue: PaceTicket[] = [];
  private seq = 0;
  constructor(private readonly now: () => number) {}

  enqueue(): PaceTicket {
    const t = { id: ++this.seq };
    this.queue.push(t);
    return t;
  }

  /** Leave the queue without taking anything (cancel, re-plan, or after taking). */
  leave(ticket: PaceTicket): void {
    const i = this.queue.indexOf(ticket);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private refill(rate: number, capacity: number): void {
    const t = this.now();
    if (this.tokens === undefined) {
      this.tokens = capacity;
    } else {
      // Elapsed time refills at the rate that was in force during it.
      this.tokens += (Math.max(0, t - this.last) * this.lastRate) / 1000;
      if (this.tokens > capacity) this.tokens = capacity;
    }
    this.last = t;
    this.lastRate = rate;
  }

  /**
   * Try to dispatch `bytes` for `ticket` at `rate` with burst `capacity`.
   * Returns 0 when the bytes were taken (the ticket has left the queue and the
   * caller must send now), otherwise the milliseconds worth waiting before trying
   * again (callers cap each wait at 250 ms so setting changes are seen).
   */
  tryTake(ticket: PaceTicket, bytes: number, rate: number, capacity: number): number {
    this.refill(rate, capacity);
    if (this.queue[0] !== ticket) return 250;
    // A body larger than the burst (not produced by the slice planner) waits for
    // a full bucket and then runs it into debt, which later tickets repay.
    const need = Math.min(bytes, capacity);
    const have = this.tokens ?? 0;
    if (have >= need) {
      this.tokens = have - bytes;
      this.leave(ticket);
      return 0;
    }
    return Math.max(1, ((need - have) * 1000) / rate);
  }

  /** Forget all state (tests). */
  reset(): void {
    this.tokens = undefined;
    this.queue = [];
    this.lastRate = 0;
  }
}

/** Largest single request body the slice planner can produce under `rate`. */
export function pacedBurst(rate: number): number {
  return Math.max(MIN_PACED_SLICE, Math.floor((rate * PACED_BURST_MS) / 1000));
}

/** Window oracle used by tests: the worst excess of dispatched bytes over
 *  rate x span + capacity, over every pair of dispatch instants. <= 0 holds. */
export function worstWindowExcess(events: Array<{ t: number; bytes: number }>, rate: number, capacity: number): number {
  const ev = [...events].sort((a, b) => a.t - b.t);
  let worst = -Infinity;
  for (let i = 0; i < ev.length; i++) {
    let sum = 0;
    for (let j = i; j < ev.length; j++) {
      sum += ev[j].bytes;
      worst = Math.max(worst, sum - (rate * (ev[j].t - ev[i].t)) / 1000 - capacity);
    }
  }
  return worst;
}

/** Confirmed-progress rate and ETA. Only server-acknowledged offsets are fed in. */
export class ProgressRate {
  static readonly WINDOW_MS = 20_000;
  static readonly MIN_SPAN_MS = 3_000;
  static readonly STALL_MS = 15_000;
  private samples: Array<{ t: number; at: number }> = [];

  record(t: number, committed: number): void {
    const last = this.samples.at(-1);
    if (last && committed <= last.at) return; // only forward movement is progress
    this.samples.push({ t, at: committed });
    const keepFrom = t - ProgressRate.WINDOW_MS;
    while (this.samples.length > 2 && this.samples[1].t <= keepFrom) this.samples.shift();
  }

  /** Bytes/second over the window, or undefined when there is not enough to say
   *  (fewer than two commits, under MIN_SPAN_MS of history, or stalled). */
  rate(now: number): number | undefined {
    if (this.samples.length < 2) return undefined;
    const first = this.samples[0];
    const last = this.samples.at(-1)!;
    if (now - last.t > ProgressRate.STALL_MS) return undefined;
    const span = last.t - first.t;
    if (span < ProgressRate.MIN_SPAN_MS) return undefined;
    return ((last.at - first.at) * 1000) / span;
  }

  etaMs(now: number, total: number): number | undefined {
    const r = this.rate(now);
    const last = this.samples.at(-1);
    if (r === undefined || !last || r <= 0) return undefined;
    return Math.max(0, ((total - last.at) * 1000) / r);
  }
}

/** Local, content-free accounting of one upload. No names, keys or hashes. */
export interface UploadStats {
  /** Wall time awaiting the encryptor (file read + encryption, not separable here). */
  prepareMs: number;
  /** Wall time from each PATCH's start to its answer: network AND server commit. */
  requestMs: number;
  /** Deliberate waits imposed by a speed limit. */
  pacingMs: number;
  /** Offset reads and retry backoff after a failed or cut request. */
  recoveryMs: number;
  /** PATCH requests started. */
  requests: number;
  /** Requests cut by the watchdog. */
  watchdogCuts: number;
  /** Request body bytes ATTEMPTED, every attempt counted. An upper bound on what
   *  left this device (a cut or failed request may have sent only part of its
   *  body), and excludes HTTP/TLS overhead. Not a measurement of wire traffic and
   *  never a basis for billing. */
  attemptedPayloadBytes: number;
  /** Of those, bytes whose offsets an earlier attempt had already requested to
   *  send (overlap of requested ranges, not observed retransmission). */
  replayedRequestedBytes: number;
  /** Bytes the server confirmed. */
  committedBytes: number;
}

export function emptyStats(): UploadStats {
  return { prepareMs: 0, requestMs: 0, pacingMs: 0, recoveryMs: 0, requests: 0, watchdogCuts: 0, attemptedPayloadBytes: 0, replayedRequestedBytes: 0, committedBytes: 0 };
}

/** Wire/replay accounting for an attempt covering [from, to). */
export function noteAttempt(stats: UploadStats, highestSent: number, from: number, to: number): number {
  stats.requests += 1;
  stats.attemptedPayloadBytes += to - from;
  stats.replayedRequestedBytes += Math.max(0, Math.min(to, highestSent) - from);
  return Math.max(highestSent, to);
}

// ── Speed preference: pure TypeScript ─────────────────────────────────────────
// Read by stored-file.ts before every request. Deliberately NOT a Svelte runes
// module: stored-file.ts is also bundled into Node runtimes (the Windows stored
// runtime), where `$state` and `window` do not exist. Nothing here touches
// storage at module load. The Svelte wrapper (transfer-speed-pref.svelte.ts)
// only mirrors this for the UI.

export const SPEED_PREF_KEY = "relayium.transfer.speed";
const SPEED_MODES: readonly SpeedMode[] = ["fast", "background", "cap"];

/** Validate a stored preference; anything malformed is the default. */
export function parseSpeedPref(raw: string | null | undefined): SpeedPref {
  if (!raw) return { ...DEFAULT_SPEED_PREF };
  try {
    const v = JSON.parse(raw) as { mode?: unknown; capBytesPerSec?: unknown };
    const mode = SPEED_MODES.includes(v.mode as SpeedMode) ? (v.mode as SpeedMode) : DEFAULT_SPEED_PREF.mode;
    const cap = typeof v.capBytesPerSec === "number" ? clampCap(v.capBytesPerSec) : DEFAULT_SPEED_PREF.capBytesPerSec;
    return { mode, capBytesPerSec: cap };
  } catch {
    return { ...DEFAULT_SPEED_PREF };
  }
}

export function normalizeSpeedPref(p: SpeedPref): SpeedPref {
  return {
    mode: SPEED_MODES.includes(p.mode) ? p.mode : DEFAULT_SPEED_PREF.mode,
    capBytesPerSec: clampCap(p.capBytesPerSec),
  };
}

type PrefStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function prefStorage(): PrefStorage | undefined {
  try {
    return typeof localStorage !== "undefined" && localStorage ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** This page's choice when persisting it failed (quota / private mode / none). */
let unpersisted: SpeedPref | undefined;

/** The preference uploads follow right now. Without storage (Node runtimes,
 *  blocked storage) it is the in-memory choice, else the default "fast". */
export function currentSpeedPref(): SpeedPref {
  if (unpersisted) return unpersisted;
  const st = prefStorage();
  if (!st) return { ...DEFAULT_SPEED_PREF };
  try {
    return parseSpeedPref(st.getItem(SPEED_PREF_KEY));
  } catch {
    return { ...DEFAULT_SPEED_PREF };
  }
}

/** Set the preference; persists when possible, otherwise applies to this page. */
export function saveSpeedPref(next: SpeedPref): SpeedPref {
  const clean = normalizeSpeedPref(next);
  const st = prefStorage();
  try {
    if (!st) throw new Error("no storage");
    const isDefault = clean.mode === DEFAULT_SPEED_PREF.mode && clean.capBytesPerSec === DEFAULT_SPEED_PREF.capBytesPerSec;
    if (isDefault) st.removeItem(SPEED_PREF_KEY);
    else st.setItem(SPEED_PREF_KEY, JSON.stringify(clean));
    unpersisted = undefined;
  } catch {
    unpersisted = clean;
  }
  return clean;
}

export function sameSpeedPref(a: SpeedPref, b: SpeedPref): boolean {
  return a.mode === b.mode && (a.mode !== "cap" || a.capBytesPerSec === b.capBytesPerSec);
}

/** Tests only. */
export function resetSpeedPrefMemoryForTests(): void {
  unpersisted = undefined;
}
