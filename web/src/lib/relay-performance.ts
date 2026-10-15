// Throughput-informed relay choice: the pure half.
//
// `pickRelay` (ice.ts) ranks relays by how fast each peer can ALLOCATE on them —
// a setup-latency signal, and the only one the pool had. It cannot see that the
// nearest relay may be the one that moves a file slowest. This file adds the
// second signal a file transfer actually experiences: goodput both peers have
// OBSERVED on completed transfers through each relay (relay-history.ts records
// it; nothing here measures anything or spends a byte).
//
// The contract is docs/protocol/relayium-relay-performance-v1.md and the shared
// vectors are contracts/relay-performance-v1.json. Everything here is pure and
// symmetric under swapping the two peers' inputs, because two peers that hold
// the same maps must name the same relay without negotiating.
//
// ## What the score is, and what it is not
//
// Predicted time for ONE declared reference payload (`RELAY_PERF_REF_BYTES`,
// 32 MiB, the `bulk` policy): the worse peer's setup round trip plus the
// reference payload at the conservative goodput both peers have seen through
// that relay. It is a hint about end-to-end observed transfer goodput, which
// device and peer I/O influence too — never a statement of relay capacity, and
// not a promise that every message is faster. A short text exchange or a tiny
// file is dominated by setup, where the legacy RTT order is already the right
// answer; the reference policy trades a little setup latency for bulk time and
// only when the history says the saving is large (see `beatsLegacy`).
//
// ## When it applies at all
//
// Only when BOTH peers declared the same version, policy and reference size in
// their latest envelope, and only when both the legacy winner and the challenger
// have goodput evidence. Everything else — a cold history, an old peer, a
// malformed declaration — is exactly `pickRelay`.

import { pickRelay, relayChoiceDominates, relayDominanceElapsedMs, type RelayEntry } from "./ice";
import { selectedCandidatePair } from "./webrtc-core";

export const RELAY_PERF_VERSION = 1;
/** The one policy v1 defines: rank for bulk file transfer. */
export const RELAY_PERF_POLICY = "bulk";
/** Reference payload the `bulk` policy predicts completion time for. */
export const RELAY_PERF_REF_BYTES = 32 * 1024 * 1024;
/** Same ceiling as the RTT map, for the same reason: peer-authored keys. */
export const MAX_PERF_ENTRIES = 32;
/** 10 Gbit/s. Above this a claim is not a measurement, and bounding it keeps
 *  every product below exactly representable. */
export const MAX_PERF_KBPS = 10_000_000;
/** A challenger must predict at most this fraction of the legacy winner's time… */
export const OVERRIDE_RATIO_NUM = 4;
export const OVERRIDE_RATIO_DEN = 5;
/** …and save at least this much absolute time. Together they stop two relays
 *  whose histories are within noise of each other from flapping. */
export const OVERRIDE_MIN_SAVING_MS = 250;

/** Kilobits per second, keyed by relay id. Only ids with confident history. */
export type PerfMap = Record<string, number>;

export interface PerfDeclaration {
  v: number;
  policy: string;
  ref: number;
  /** Published evidence: only for relays the sender's own probe has answered. */
  k: PerfMap;
  /**
   * The sender's UPPER bound on any evidence it can publish this room, for
   * every pool relay it holds any history for — sent complete from the first
   * envelope. A relay absent here will never get a `k` entry from this sender,
   * and no `k` entry may exceed its `u` entry. This is what lets the other side
   * reason about evidence that is not published yet (see `perfReleaseVerdict`).
   */
  u: PerfMap;
}

/** A map with no prototype, so a peer-chosen id like `__proto__` or
 *  `toString` is just a key. */
export function emptyMap(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function own(map: Record<string, number>, id: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(map, id)) return undefined;
  const v = map[id];
  return typeof v === "number" ? v : undefined;
}

function copyMap(m: PerfMap): PerfMap {
  const out = emptyMap();
  for (const id of Object.keys(m)) out[id] = m[id];
  return out;
}

/** This side's declaration, as it goes on the wire next to `relayRtt`. */
export function perfDeclaration(k: PerfMap, u: PerfMap): PerfDeclaration {
  return { v: RELAY_PERF_VERSION, policy: RELAY_PERF_POLICY, ref: RELAY_PERF_REF_BYTES, k: copyMap(k), u: copyMap(u) };
}

function parsePerfMap(m: unknown): PerfMap | null {
  if (!m || typeof m !== "object" || Array.isArray(m)) return null;
  const entries = Object.entries(m as Record<string, unknown>);
  if (entries.length > MAX_PERF_ENTRIES) return null;
  const out = emptyMap();
  for (const [id, value] of entries) {
    if (id === "" || id.length > 64) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value < 1 || value > MAX_PERF_KBPS) continue;
    out[id] = Math.floor(value);
  }
  return out;
}

/**
 * Validate a peer's `relayPerf` declaration.
 *
 * Null for anything that does not declare exactly v1 / `bulk` / the v1
 * reference size — which is what makes support a statement and not mere object
 * presence. Over `MAX_PERF_ENTRIES` the whole declaration is rejected (a
 * truncated map is a different map). Bad entries are dropped individually.
 */
export function parseRelayPerf(data: unknown): PerfDeclaration | null {
  if (!data || typeof data !== "object") return null;
  const decl = (data as { relayPerf?: unknown }).relayPerf;
  if (!decl || typeof decl !== "object" || Array.isArray(decl)) return null;
  const { v, policy, ref, k, u } = decl as { v?: unknown; policy?: unknown; ref?: unknown; k?: unknown; u?: unknown };
  if (v !== RELAY_PERF_VERSION || policy !== RELAY_PERF_POLICY || ref !== RELAY_PERF_REF_BYTES) return null;
  const kk = parsePerfMap(k);
  const uu = parsePerfMap(u);
  if (!kk || !uu) return null;
  // A published value is never above the sender's own declared bound, and a
  // relay it declared no bound for has no published value: enforced here so a
  // broken or hostile sender cannot defeat the other side's release reasoning.
  const out = emptyMap();
  for (const id of Object.keys(kk)) {
    const bound = own(uu, id);
    if (bound !== undefined) out[id] = Math.min(kk[id], bound);
  }
  return { v, policy, ref, k: out, u: uu };
}

/** The pair's goodput through `id`: the slower of the two peers' evidence, or
 *  the one side that has any. Symmetric by construction. */
export function jointGoodput(minePerf: PerfMap, theirsPerf: PerfMap, id: string): number | undefined {
  const a = own(minePerf, id);
  const b = own(theirsPerf, id);
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Integer milliseconds to move the reference payload at `kbps`. */
export function transferMs(kbps: number): number {
  return Math.ceil((RELAY_PERF_REF_BYTES * 8) / kbps);
}

/** Predicted completion of the reference payload through a relay whose worse
 *  setup leg is `worstMs`. */
export function predictedMs(worstMs: number, kbps: number): number {
  return worstMs + transferMs(kbps);
}

/** Whether a challenger predicted at `challengerMs` may displace the legacy
 *  winner predicted at `legacyMs`. Integer arithmetic only. */
export function beatsLegacy(challengerMs: number, legacyMs: number): boolean {
  return challengerMs * OVERRIDE_RATIO_DEN < legacyMs * OVERRIDE_RATIO_NUM
    && legacyMs - challengerMs >= OVERRIDE_MIN_SAVING_MS;
}

export interface PerfPick {
  id: string | null;
  /** The relay `pickRelay` alone would have named. */
  legacy: string | null;
  /** Predicted reference time of the pick, when goodput decided it. */
  predictedMs: number | null;
  /** The legacy winner's predicted time, when it had evidence. */
  legacyPredictedMs: number | null;
}

/**
 * The pair's choice under the `bulk` policy.
 *
 * Starts from `pickRelay` and overrides it only with a common relay whose
 * predicted reference time beats the legacy winner's by the override margin,
 * when both have goodput evidence. Among several qualifying challengers the
 * lowest predicted time wins, then the legacy `(worst, sum, id)` order — the
 * same total order on both sides.
 */
export function pickRelayPerf(
  mine: Record<string, number>,
  theirs: Record<string, number>,
  minePerf: PerfMap,
  theirsPerf: PerfMap,
): PerfPick {
  const legacy = pickRelay(mine, theirs);
  if (legacy === null) return { id: null, legacy, predictedMs: null, legacyPredictedMs: null };
  const gL = jointGoodput(minePerf, theirsPerf, legacy);
  if (gL === undefined) return { id: legacy, legacy, predictedMs: null, legacyPredictedMs: null };
  const legacyMs = predictedMs(Math.max(mine[legacy], theirs[legacy]), gL);
  let best: string | null = null;
  let bestMs = Infinity;
  let bestWorst = Infinity;
  let bestSum = Infinity;
  for (const id of Object.keys(mine)) {
    if (id === legacy) continue;
    const m = own(mine, id);
    const t = own(theirs, id);
    if (m === undefined || t === undefined) continue;
    const g = jointGoodput(minePerf, theirsPerf, id);
    if (g === undefined) continue;
    const worst = Math.max(m, t);
    const ms = predictedMs(worst, g);
    if (!beatsLegacy(ms, legacyMs)) continue;
    const sum = m + t;
    if (ms < bestMs || (ms === bestMs && (worst < bestWorst
        || (worst === bestWorst && (sum < bestSum || (sum === bestSum && (best === null || id < best))))))) {
      best = id;
      bestMs = ms;
      bestWorst = worst;
      bestSum = sum;
    }
  }
  if (best === null) return { id: legacy, legacy, predictedMs: legacyMs, legacyPredictedMs: legacyMs };
  return { id: best, legacy, predictedMs: bestMs, legacyPredictedMs: legacyMs };
}

/**
 * Everything the release rule knows about goodput evidence in this room.
 *
 * `minePerf`/`theirsPerf` are PUBLISHED values (final per relay once that side's
 * round trip for it is known). `mineUpper`/`theirsUpper` bound what each side
 * can still publish for relays whose round trip it has not reported yet: ours
 * is the room-start snapshot of our history, theirs is the peer's declared `u`.
 * A relay absent from an upper map can never receive evidence from that side.
 */
export interface PerfKnowledge {
  mine: Record<string, number>;
  theirs: Record<string, number>;
  minePerf: PerfMap;
  theirsPerf: PerfMap;
  mineUpper: PerfMap;
  theirsUpper: PerfMap;
}

interface Verdict {
  /** No completion of the unknowns can make this relay change the pick, now. */
  retired: boolean;
  /** Smallest rounded elapsed (ms) at which our own clock alone retires it,
   *  or null when only a PEER envelope can. */
  retiresAt: number | null;
}

/**
 * Whether one relay whose data is not yet complete on BOTH sides can still
 * change the pick: by becoming the legacy winner, or by becoming a qualifying
 * challenger that beats the current pick.
 *
 * Every unknown is replaced by its most favourable possible value:
 *  - our round trip, if unanswered: at least rounded elapsed since every probe
 *    started (the legacy anchor argument), else 0 when there is no anchor;
 *  - the peer's round trip, if unreported: at least 0 — nothing bounds it;
 *  - each side's evidence: its published value once that side reported the
 *    relay (absent then means none, ever), else its UPPER bound (absent means
 *    none, ever). The joint goodput is the min of two values or the one value,
 *    so its best case is the larger of the two bounds.
 * Unknown capacity is never scored as measured: these bounds only decide
 * whether it is still POSSIBLE for the relay to win, never which relay wins.
 */
function verdict(
  x: string,
  k: PerfKnowledge,
  legacyWorst: number,
  legacyMs: number | null,
  pickMs: number | null,
  pickIsChallenger: boolean,
  lowerBound: number | null,
): Verdict {
  const myLeg = own(k.mine, x);
  const peerLeg = own(k.theirs, x);
  const ownPending = myLeg === undefined;
  // Floor of the worse leg, excluding the elapsed term (added below).
  const fixedFloor = Math.max(myLeg ?? 0, peerLeg ?? 0);

  // Legacy half: x can win the legacy order only if its worse leg can be <=
  // legacyWorst (ties fall through to sum and id, so `>` retires).
  let eLegacy: number | null;
  if (fixedFloor > legacyWorst) eLegacy = 0;
  else if (ownPending) eLegacy = legacyWorst + 1;
  else eLegacy = null; // only the peer's report can tell

  // Challenger half.
  let eChallenger: number | null = 0;
  if (legacyMs !== null) {
    const mineBound = ownPending ? own(k.mineUpper, x) : own(k.minePerf, x);
    const peerBound = peerLeg === undefined ? own(k.theirsUpper, x) : own(k.theirsPerf, x);
    const best = Math.max(mineBound ?? 0, peerBound ?? 0);
    if (best >= 1) {
      const R = transferMs(best);
      const thresholds = [
        Math.ceil((legacyMs * OVERRIDE_RATIO_NUM) / OVERRIDE_RATIO_DEN), // ratio fails
        legacyMs - OVERRIDE_MIN_SAVING_MS + 1, // saving fails
      ];
      if (pickIsChallenger && pickMs !== null) thresholds.push(pickMs + 1); // slower than the pick
      let e: number | null = null;
      for (const T of thresholds) {
        const at = fixedFloor + R >= T ? 0 : ownPending ? T - R : null;
        if (at !== null && (e === null || at < e)) e = at;
      }
      eChallenger = e;
    }
  }
  if (eLegacy === null || eChallenger === null) {
    return { retired: false, retiresAt: null };
  }
  const retiresAt = Math.max(eLegacy, eChallenger);
  const retired = retiresAt === 0 || (lowerBound !== null && lowerBound >= retiresAt);
  return { retired, retiresAt: retiresAt === 0 || ownPending ? retiresAt : null };
}

function uncertainIds(k: PerfKnowledge, poolIds: readonly string[]): string[] {
  return poolIds.filter((id) => own(k.mine, id) === undefined || own(k.theirs, id) === undefined);
}

/**
 * The release rule while goodput ranking is in force: true when no relay whose
 * data is incomplete on either side can still change the pick.
 *
 * Unlike the legacy rule this considers relays the PEER has not reported yet,
 * and it never short-circuits on our own measurement being finished: the
 * peer's round trip and evidence for a relay arrive together in its envelope,
 * and before they do they can still move a goodput-ranked choice. That is the
 * difference between both peers' FIRST builds agreeing and only their final
 * maps agreeing. The existing per-peer grace still bounds the wait.
 */
export function relayPerfChoiceDominates(
  selectedId: string | null,
  k: PerfKnowledge,
  poolIds: readonly string[],
  elapsedMs: number | null,
): boolean {
  if (selectedId === null) return false;
  const pick = pickRelayPerf(k.mine, k.theirs, k.minePerf, k.theirsPerf);
  if (pick.id !== selectedId || pick.legacy === null) return false;
  const legacyWorst = Math.max(k.mine[pick.legacy], k.theirs[pick.legacy]);
  const lowerBound = elapsedMs === null ? null : Math.round(elapsedMs);
  for (const x of uncertainIds(k, poolIds)) {
    const v = verdict(x, k, legacyWorst, pick.legacyPredictedMs, pick.predictedMs,
      pick.id !== pick.legacy, lowerBound);
    if (!v.retired) return false;
  }
  return true;
}

/**
 * The elapsed time at which our own clock alone makes
 * `relayPerfChoiceDominates` true for the current maps, or null when some
 * relay can only be retired by a peer envelope (which re-evaluates anyway).
 * Every bound is an integer compared with `>=` against the rounded elapsed.
 */
export function relayPerfDominanceElapsedMs(
  k: PerfKnowledge,
  poolIds: readonly string[],
): number | null {
  const pick = pickRelayPerf(k.mine, k.theirs, k.minePerf, k.theirsPerf);
  if (pick.legacy === null) return null;
  const legacyWorst = Math.max(k.mine[pick.legacy], k.theirs[pick.legacy]);
  let at = 0;
  for (const x of uncertainIds(k, poolIds)) {
    const v = verdict(x, k, legacyWorst, pick.legacyPredictedMs, pick.predictedMs,
      pick.id !== pick.legacy, null);
    if (v.retiresAt === null) return null;
    at = Math.max(at, v.retiresAt);
  }
  return at;
}

/** Legacy re-exports, so the selection imports one module for both modes. */
export { pickRelay, relayChoiceDominates, relayDominanceElapsedMs };

export type RelayTransport = "udp" | "tcp" | "tls" | "unknown";

export interface RelayAttribution {
  relayId: string;
  transport: RelayTransport;
}

function urlsOf(entry: RelayEntry): string[] {
  const out: string[] = [];
  for (const s of entry.iceServers) {
    const u = s.urls;
    if (typeof u === "string") out.push(u.toLowerCase());
    else if (Array.isArray(u)) for (const x of u) if (typeof x === "string") out.push(x.toLowerCase());
  }
  return out;
}

/**
 * Which pool relay a finished transfer ACTUALLY ran through, or null.
 *
 * Attributable only when the agent's selected pair has a LOCAL relay
 * candidate, that candidate names the TURN server URL it was allocated on, the
 * URL belongs to exactly one entry of this room's pool, and that entry is one
 * this room built a connection with by agreement (`builtIds`). A pool-fallback
 * build, a direct path, an unknown pair or a URL two entries share is not
 * evidence about any one relay and records nothing.
 */
export function attributeRelay(
  stats: RTCStatsReport,
  pool: readonly RelayEntry[],
  builtIds: ReadonlySet<string>,
): RelayAttribution | null {
  const pair = selectedCandidatePair(stats) as { localCandidateId?: unknown } | null;
  if (!pair || typeof pair.localCandidateId !== "string") return null;
  const local = stats.get(pair.localCandidateId) as
    { candidateType?: unknown; url?: unknown; relayProtocol?: unknown } | undefined;
  if (!local || local.candidateType !== "relay" || typeof local.url !== "string") return null;
  const url = local.url.toLowerCase();
  const owners = pool.filter((e) => urlsOf(e).includes(url));
  if (owners.length !== 1) return null;
  const relayId = owners[0].id;
  if (!builtIds.has(relayId)) return null;
  const p = local.relayProtocol;
  const transport: RelayTransport = p === "udp" || p === "tcp" || p === "tls" ? p : "unknown";
  return { relayId, transport };
}
