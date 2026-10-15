// Bounded, local, salted history of goodput OBSERVED on completed transfers
// through each relay. The evidence relay-performance.ts ranks with.
//
// ## What is kept, and what never is
//
// One entry per qualifying completed transfer: a salted keyed hash of the
// relay id (never the id itself), the relay transport the path used, a coarse
// network class, the minute it finished, quantized goodput, a volume bucket and
// this side's probe round trip to that relay at the time. No peer id, IP
// address, network name, file name, size, hash, key or content — nothing that
// identifies a person, a file or a place. At most `MAX_HISTORY_ENTRIES`, none
// older than `HISTORY_TTL_MS`. Storage is optional: a page that cannot persist
// keeps the same history in memory for its own lifetime.
//
// ## What an entry means
//
// Observed end-to-end transfer goodput: bytes over the wall time from consent
// to the receiver's COMPLETE. It includes the peer's disk and both devices'
// encryption as well as the network, so it is a hint about how transfers
// through this relay have gone for THIS device, never a capacity claim.
//
// Pure TypeScript with no browser global at import time (a Windows renderer and
// SSR import graph reach this file). Everything environmental is injected.

import type { RelayEntry } from "./ice";
import { attributeRelay } from "./relay-performance";

export const HISTORY_STORAGE_KEY = "relayium.relayPerf.v1";
export const MAX_HISTORY_ENTRIES = 30;
export const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
/** A sample this small says little about bulk goodput. */
export const MIN_SAMPLE_BYTES = 8 * 1024 * 1024;
/** One sample this large is confident on its own. */
export const CONFIDENT_SINGLE_BYTES = 32 * 1024 * 1024;
/** Fast links finish 8 MiB in well under a second; the floor is only there to
 *  reject a clock artefact, not to exclude fast relays. */
export const MIN_SAMPLE_MS = 200;
const MAX_KBPS = 10_000_000;
const MAX_RTT_MS = 60_000;
/** Round trips are kept to this grain. */
const RTT_GRAIN_MS = 5;
/** Goodput is kept in eighth-octave steps (about 9 %). */
const KBPS_STEPS_PER_OCTAVE = 8;

export type HistoryTransport = "udp" | "tcp" | "tls" | "unknown";

export interface HistoryStorage {
  get(): string | null;
  set(value: string): void;
}

export interface RelayHistoryOptions {
  storage?: HistoryStorage | null;
  /** Wall clock, ms. Persisted entries outlive a page, so TTL needs one. */
  now?: () => number;
  /** Source of the local salt. Defaults to `crypto.getRandomValues` at call time. */
  randomBytes?: (n: number) => Uint8Array;
}

export interface RelaySample {
  relayId: string;
  bytes: number;
  activeMs: number;
  transport: HistoryTransport;
  /** Coarse network class, e.g. "wifi", "cellular", "unknown". */
  net: string;
  /** This side's probe round trip to the relay in the room the sample came from. */
  rttMs: number;
}

/** One persisted entry, positional to keep storage small:
 *  [hash, transport, net, minute, kbpsStep, volumeBucket, rttMs]. */
export type HistoryEntry = [string, HistoryTransport, string, number, number, number, number];

export interface RelayHistory {
  /** Record a qualifying sample. False when it does not qualify. */
  add(sample: RelaySample): boolean;
  /**
   * Conservative goodput estimate (kbit/s) for `relayId` on network `net`, or
   * null without confident evidence. With `rttMs`, only samples whose recorded
   * round trip is consistent with it count — a moved vantage point is a
   * different path. With null, no such filter, and the answer is an UPPER
   * BOUND on what the filtered call can return for ANY round trip: the largest
   * row (a lower quartile of a subset is never above the subset's maximum,
   * which is never above the whole set's), returned only when the whole set is
   * confident (a confident subset implies a confident superset).
   */
  estimate(relayId: string, net: string, rttMs: number | null): number | null;
  /** The network changed under this page: nothing recorded before now is
   *  confident any more for the life of this page. */
  noteNetworkChange(): void;
  /** Current entries, for tests and diagnostics. */
  entries(): readonly HistoryEntry[];
  /** Keep one clean transfer's phase timings for local diagnostics. Memory
   *  only, last `MAX_DIAGNOSTICS`; never persisted, never sent. */
  observe(d: TransferDiagnostic): void;
  recent(): readonly TransferDiagnostic[];
}

export const MAX_DIAGNOSTICS = 8;

/** Phase timings of one clean batch. Sizes are a log2 bucket, never exact. */
export interface TransferDiagnostic {
  dir: "send" | "recv";
  volumeBucket: number;
  activeMs: number;
  creditWaitMs: number;
  bufferWaitMs: number;
  finalizeMs: number;
  /** Whether the path could be attributed to one agreed relay. */
  attributed: boolean;
}

// ── SHA-256 / HMAC (sync) ──────────────────────────────────────────────────────
// Selection is synchronous (it runs inside the probe callback that publishes the
// same atomic envelope), so the keyed hash cannot await SubtleCrypto. The test
// file checks this against WebCrypto.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

export function hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array {
  let k = key.length > 64 ? sha256(key) : key;
  const block = new Uint8Array(64);
  block.set(k);
  k = block;
  const inner = new Uint8Array(64 + msg.length);
  const outer = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) {
    inner[i] = k[i] ^ 0x36;
    outer[i] = k[i] ^ 0x5c;
  }
  inner.set(msg, 64);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

// ── history ────────────────────────────────────────────────────────────────────

const TRANSPORTS: readonly HistoryTransport[] = ["udp", "tcp", "tls", "unknown"];

function cleanNet(net: string): string {
  return /^[a-z0-9-]{1,16}$/.test(net) ? net : "unknown";
}

function validEntry(e: unknown): e is HistoryEntry {
  if (!Array.isArray(e) || e.length !== 7) return false;
  const [h, tr, net, t, g, vb, rtt] = e as unknown[];
  return typeof h === "string" && /^[0-9a-f]{16}$/.test(h)
    && TRANSPORTS.includes(tr as HistoryTransport)
    && typeof net === "string" && cleanNet(net) === net
    && Number.isInteger(t) && (t as number) >= 0
    && Number.isInteger(g) && (g as number) >= 0 && (g as number) <= 200
    && Number.isInteger(vb) && (vb as number) >= 0 && (vb as number) <= 63
    && Number.isInteger(rtt) && (rtt as number) >= 0 && (rtt as number) <= MAX_RTT_MS;
}

const kbpsOfStep = (g: number) => Math.min(MAX_KBPS, Math.max(1, Math.round(2 ** (g / KBPS_STEPS_PER_OCTAVE))));

export function createRelayHistory(opts: RelayHistoryOptions = {}): RelayHistory {
  const now = opts.now ?? (() => Date.now());
  const randomBytes = opts.randomBytes ?? ((n: number) => {
    const out = new Uint8Array(n);
    globalThis.crypto.getRandomValues(out);
    return out;
  });
  let storage = opts.storage ?? null;
  let salt: Uint8Array;
  let list: HistoryEntry[] = [];
  /** Minute at or after which entries count; raised by a network change. */
  let since = 0;

  function load() {
    let raw: string | null = null;
    try { raw = storage ? storage.get() : null; } catch { storage = null; }
    try {
      const parsed = raw ? JSON.parse(raw) as { v?: unknown; s?: unknown; e?: unknown } : null;
      if (parsed && parsed.v === 1 && typeof parsed.s === "string" && /^[0-9a-f]{64}$/.test(parsed.s)
          && Array.isArray(parsed.e)) {
        salt = unhex(parsed.s);
        list = parsed.e.filter(validEntry).slice(-MAX_HISTORY_ENTRIES);
        return;
      }
    } catch { /* malformed: start fresh */ }
    salt = randomBytes(32);
    list = [];
  }

  function save() {
    if (!storage) return;
    try {
      storage.set(JSON.stringify({ v: 1, s: hex(salt), e: list }));
    } catch {
      // Quota, private mode, a revoked permission: keep going in memory.
      storage = null;
    }
  }

  function prune() {
    const minute = Math.floor(now() / 60_000);
    const oldest = minute - HISTORY_TTL_MS / 60_000;
    // An entry from the future means the wall clock went backwards; it cannot be
    // aged correctly, so it goes.
    const previousLength = list.length;
    list = list.filter((e) => e[3] > oldest && e[3] <= minute + 5).slice(-MAX_HISTORY_ENTRIES);
    if (list.length !== previousLength) save();
  }

  const hashes = new Map<string, string>();
  function hashOf(relayId: string): string {
    let h = hashes.get(relayId);
    if (h === undefined) {
      h = hex(hmacSha256(salt, new TextEncoder().encode(relayId)).subarray(0, 8));
      if (hashes.size < 64) hashes.set(relayId, h);
    }
    return h;
  }

  load();
  // Expiry applies to persisted records too, including a reload with no room.
  prune();
  let diagnostics: TransferDiagnostic[] = [];

  return {
    observe(d) {
      diagnostics = [...diagnostics, { ...d }].slice(-MAX_DIAGNOSTICS);
    },
    recent() {
      return diagnostics.map((d) => ({ ...d }));
    },
    add(sample) {
      const { bytes, activeMs, rttMs } = sample;
      if (typeof sample.relayId !== "string" || sample.relayId === "" || sample.relayId.length > 64) return false;
      if (!Number.isFinite(bytes) || !Number.isFinite(activeMs) || !Number.isFinite(rttMs)) return false;
      if (bytes < MIN_SAMPLE_BYTES || activeMs < MIN_SAMPLE_MS || rttMs < 0 || rttMs > MAX_RTT_MS) return false;
      const kbps = Math.min(MAX_KBPS, (bytes * 8) / activeMs);
      if (!(kbps >= 1)) return false;
      prune();
      const entry: HistoryEntry = [
        hashOf(sample.relayId),
        TRANSPORTS.includes(sample.transport) ? sample.transport : "unknown",
        cleanNet(sample.net),
        Math.floor(now() / 60_000),
        Math.round(Math.log2(kbps) * KBPS_STEPS_PER_OCTAVE),
        Math.min(63, Math.floor(Math.log2(bytes))),
        Math.round(rttMs / RTT_GRAIN_MS) * RTT_GRAIN_MS,
      ];
      list = [...list, entry].slice(-MAX_HISTORY_ENTRIES);
      save();
      return true;
    },

    estimate(relayId, net, rttMs) {
      prune();
      const h = hashOf(relayId);
      const n = cleanNet(net);
      const rows = list.filter((e) => e[0] === h && e[2] === n && e[3] >= since
        && (rttMs === null || Math.abs(e[6] - rttMs) <= Math.max(100, e[6])));
      if (rows.length === 0) return null;
      const confident = rows.length >= 2 || rows.some((e) => 2 ** e[5] >= CONFIDENT_SINGLE_BYTES);
      if (!confident) return null;
      const sorted = rows.map((e) => kbpsOfStep(e[4])).sort((a, b) => a - b);
      // Upper bound (see the interface): the maximum, never a quartile — a
      // quartile of all rows can sit far BELOW the quartile of the rows a round
      // trip later selects.
      if (rttMs === null) return sorted[sorted.length - 1];
      // Lower quartile: a single lucky transfer does not make a relay look fast.
      return sorted[Math.floor((sorted.length - 1) / 4)];
    },

    noteNetworkChange() {
      since = Math.floor(now() / 60_000) + 1;
    },

    entries() {
      prune();
      return list.map((e) => [...e] as HistoryEntry);
    },
  };
}

// ── from a finished batch to a history entry ──────────────────────────────────

/** The room a batch finished in, captured synchronously at completion. */
export interface SampleRoom {
  /** The room epoch at completion; compared again after the async stats read. */
  epoch: number;
  pool: readonly RelayEntry[];
  /** Relays this room built a connection on by agreement. */
  builtIds: ReadonlySet<string>;
  /** This side's probe round trips in this room. */
  ownRtt: Readonly<Record<string, number>>;
  net: string;
}

export interface FinishedBatch {
  dir: "send" | "recv";
  bytes: number;
  activeMs: number;
  creditWaitMs: number;
  bufferWaitMs: number;
  finalizeMs: number;
  /** The connection's getStats(). */
  stats: () => Promise<RTCStatsReport>;
}

export type SampleOutcome = "recorded" | "too-small" | "no-pool" | "stale" | "unattributed" | "no-stats" | "rejected";

/**
 * Turn one clean batch into evidence, or explain why not. Always leaves a
 * diagnostic. Attribution is from the connection's OBSERVED selected pair (see
 * `attributeRelay`); a room that changed while stats were read records nothing.
 */
export async function recordTransferSample(
  history: RelayHistory,
  batch: FinishedBatch,
  room: SampleRoom,
  currentEpoch: () => number,
): Promise<SampleOutcome> {
  const diag = {
    dir: batch.dir,
    volumeBucket: Math.floor(Math.log2(Math.max(1, batch.bytes))),
    activeMs: Math.round(batch.activeMs),
    creditWaitMs: Math.round(batch.creditWaitMs),
    bufferWaitMs: Math.round(batch.bufferWaitMs),
    finalizeMs: Math.round(batch.finalizeMs),
  };
  const done = (outcome: SampleOutcome, attributed = false): SampleOutcome => {
    history.observe({ ...diag, attributed });
    return outcome;
  };
  if (batch.bytes < MIN_SAMPLE_BYTES) return done("too-small");
  if (room.pool.length === 0) return done("no-pool");
  let stats: RTCStatsReport;
  try { stats = await batch.stats(); } catch { return done("no-stats"); }
  if (currentEpoch() !== room.epoch) return done("stale");
  const where = attributeRelay(stats, room.pool, room.builtIds);
  const rtt = where ? room.ownRtt[where.relayId] : undefined;
  if (!where || typeof rtt !== "number") return done("unattributed");
  const ok = history.add({
    relayId: where.relayId, bytes: batch.bytes, activeMs: batch.activeMs,
    transport: where.transport, net: room.net, rttMs: rtt,
  });
  return done(ok ? "recorded" : "rejected", true);
}
