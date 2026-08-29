// Fetches the RTCConfiguration.iceServers list from the server. For a rendezvous
// room — an anonymous pairing code (?code=) — the server returns STUN + an
// ephemeral TURN credential; for LAN (no code) it returns STUN only. Passing the
// pairing code is what lets code transfers relay through TURN across strict NATs
// instead of failing STUN-only.
//
// On ANY failure — a non-ok status, a network error, or a body that isn't JSON
// (e.g. a misconfigured nginx serving index.html for /api/*) — the fallback is an
// EMPTY list, not a public STUN server.
//
// 这里以前是 stun.l.google.com。STUN 的用途是问「我的公网地址是什么」，所以那个回落
// 意味着：只要 /api/ice 出一点问题，用户的浏览器就会去向 Google 报到一次，带着公网 IP
// 和会话时序。对一个主打「服务器看不到你的文件」的产品，这是最容易被指出来的自相矛盾。
//
// 空列表不是故障：局域网靠 host 候选就能直连（这恰恰是 /api/ice 挂掉时唯一还能成的
// 场景），而跨网络本来就需要服务器下发 TURN 才成立，回落到公共 STUN 也救不了。
const FALLBACK: RTCIceServer[] = [];

/** Whether the list carries a usable TURN relay (a turn:/turns: URL). Only then is
 *  it safe to force relay-only ICE — otherwise there would be no candidates at all. */
export function hasTurnServer(servers: RTCIceServer[]): boolean {
  return servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  });
}

/** One member of the multi-relay TURN pool: a stable id + a ready-to-use iceServers
 *  list (this relay's URLs with a fresh ephemeral credential). Peers agree on a relay
 *  by `id` and each uses its own credential for it. */
export interface RelayEntry {
  id: string;
  region?: string;
  stun?: string;
  iceServers: RTCIceServer[];
}

/**
 * Why a cross-network session has no relay.
 *
 * Every one of these used to be silent: `/api/ice` failures of any kind fell
 * back to an empty list, and the only `relayDenied` reason the client
 * recognised was "quota". A withheld relay and an unreachable one both surfaced
 * as "connection failed" thirty seconds later.
 */
export type RelayAvailability =
  | "ok" // a relay was issued (or none was needed — LAN)
  | "quota" // owner is over the monthly relay cap; server withheld TURN
  | "unverified" // owner's email is unverified; server withheld TURN
  | "ratelimited" // too many /api/ice requests from this IP — distinct, and retryable by hand
  | "unavailable" // /api/ice could not be read at all (network, 5xx, bad body)
  | "none"; // the request succeeded but named a pairing code and still carried no TURN

export interface IceConfig {
  iceServers: RTCIceServer[]; // fallback / legacy single relay + STUN
  relays: RelayEntry[]; // the pool (empty unless the server advertises one)
  relayDenied?: string; // "quota"/"unverified" when the server deliberately withheld TURN
  /** Why (or whether) a relay is available. See RelayAvailability. */
  relayStatus: RelayAvailability;
}

/** Backoff before the one retry. Long enough to step over a network hiccup,
 *  short enough not to delay a session that is waiting on this. */
const ICE_RETRY_DELAY_MS = 1_200;
/** A `Retry-After` longer than this is the server saying "not soon". Honour it
 *  by not retrying at all, rather than making the user wait and then fail. */
const ICE_MAX_RETRY_AFTER_MS = 5_000;

type IceRead =
  | { ok: true; config: IceConfig }
  | { ok: false; status: RelayAvailability; retryable: boolean; retryAfterMs?: number };

/**
 * One attempt at `/api/ice`.
 *
 * The distinction that matters is *which* failures are worth repeating. A
 * network error or a 5xx is transient — the session gets one relay fetch, at
 * room join, and lives with the answer, so losing it to a momentary hiccup
 * costs the whole transfer; a `Retry-After` on one of those is honoured up to a
 * cap. A 429 is not transient: the limiter is 5/min/IP and a phone behind
 * carrier CGNAT shares that IP with strangers, so an immediate retry spends the
 * user's next token and makes the situation worse. A deliberate denial (403
 * with a `relayDenied` body) is an answer, not a failure, and must reach the UI
 * verbatim.
 */
async function readIceConfig(url: string): Promise<IceRead> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include" });
  } catch {
    return { ok: false, status: "unavailable", retryable: true };
  }
  if (res.status === 429) return { ok: false, status: "ratelimited", retryable: false };
  if (!res.ok) {
    // A denial the server chose to explain is a real answer; read it rather
    // than flattening it into "unavailable".
    const denied = await deniedReason(res);
    if (denied) return { ok: false, status: denied, retryable: false };
    return {
      ok: false,
      status: "unavailable",
      retryable: res.status >= 500,
      retryAfterMs: retryAfterMs(res),
    };
  }
  try {
    const body = (await res.json()) as {
      iceServers?: RTCIceServer[];
      relays?: RelayEntry[];
      relayDenied?: string;
    };
    return {
      ok: true,
      config: {
        iceServers: body.iceServers ?? FALLBACK,
        relays: body.relays ?? [],
        relayDenied: body.relayDenied,
        relayStatus: "ok",
      },
    };
  } catch {
    // 200 with a body that isn't JSON — a misconfigured proxy serving
    // index.html for /api/*. Repeating it will not help.
    return { ok: false, status: "unavailable", retryable: false };
  }
}

/** `Retry-After`, in ms, when it is a delta-seconds value we are willing to wait. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("Retry-After");
  if (!raw) return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

/** The `relayDenied` reason from a non-2xx body, if it carries one. */
async function deniedReason(res: Response): Promise<RelayAvailability | null> {
  try {
    const body = (await res.json()) as { relayDenied?: string };
    if (body.relayDenied === "quota" || body.relayDenied === "unverified") return body.relayDenied;
  } catch { /* not a JSON body */ }
  return null;
}

export async function fetchIceConfig(code = ""): Promise<IceConfig> {
  const q = code ? `?code=${encodeURIComponent(code)}` : "";
  const url = `/api/ice${q}`;
  let read = await readIceConfig(url);
  const wait = read.ok ? 0 : read.retryAfterMs ?? ICE_RETRY_DELAY_MS;
  if (!read.ok && read.retryable && wait <= ICE_MAX_RETRY_AFTER_MS) {
    await new Promise((r) => setTimeout(r, wait));
    read = await readIceConfig(url);
  }
  // Unreadable: keep the empty list (never a third-party STUN — see FALLBACK)
  // but say why, instead of letting it look like a normal LAN config.
  if (!read.ok) return { iceServers: FALLBACK, relays: [], relayStatus: read.status };
  return { ...read.config, relayStatus: relayStatusOf(read.config, code) };
}

/** Classify a successfully-read response. `relayDenied` is the server's own
 *  explanation and wins; otherwise a code-scoped request that still carries no
 *  relay anywhere is "none" — the deployment issued nothing usable. A request
 *  with no code is LAN, where having no relay is the normal, correct state. */
function relayStatusOf(cfg: IceConfig, code: string): RelayAvailability {
  if (cfg.relayDenied === "quota" || cfg.relayDenied === "unverified") return cfg.relayDenied;
  if (!code) return "ok";
  const pooled = cfg.relays.some((r) => hasTurnServer(r.iceServers));
  return pooled || hasTurnServer(cfg.iceServers) ? "ok" : "none";
}

export async function fetchIceServers(code = ""): Promise<RTCIceServer[]> {
  return (await fetchIceConfig(code)).iceServers;
}

/**
 * How many pool relays the no-selection fallback folds in.
 *
 * Each entry costs one TURN allocation during ICE (bytes are only relayed on
 * the pair that actually gets nominated), so this bounds what a hostile or
 * misconfigured `/api/ice` response can make a client do. It must stay above
 * the size of a real pool, or the cap would silently drop the one relay that
 * works: production currently advertises five, so this leaves headroom rather
 * than sitting under it.
 */
export const MAX_FALLBACK_RELAYS = 8;

/**
 * Build the RTCConfiguration for a new connection.
 *
 * With a relay selected, use only that one and force relay-only: on a
 * cross-network path the direct candidates are going to fail anyway, and
 * waiting out their checks costs ~20s before ICE falls back to the relay it
 * would have used.
 *
 * With none selected — measurement still running, or timed out, or the peer's
 * RTT table has not arrived — use every relay we were handed. This used to fall
 * back to `hasTurnServer(iceServers)`, which sees only the legacy top-level
 * entry; a deployment that puts its relays in the `relays` pool (or a user with
 * "only my nodes" set, which withholds the top-level TURN) therefore looked
 * relay-less, dropped the pool credentials it had just been issued, and left
 * both peers with host/srflx candidates that cannot cross CGNAT. Phones hit
 * this most: the probe budget is seconds, and a cellular radio waking from idle
 * plus two Allocate round trips can eat it. Measurement is an optimisation, not
 * a precondition for having a relay at all.
 */
export function chooseRtcConfig(
  cfg: Pick<IceConfig, "iceServers" | "relays">,
  selectedRelayId: string | null,
): { iceServers: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy } {
  const picked = selectedRelayId ? cfg.relays.find((r) => r.id === selectedRelayId) : undefined;
  if (picked) return { iceServers: picked.iceServers, iceTransportPolicy: "relay" };

  const merged = [...cfg.iceServers];
  for (const relay of cfg.relays.slice(0, MAX_FALLBACK_RELAYS)) merged.push(...relay.iceServers);
  // Relay-only is only ever safe when a relay is actually present; a STUN-only
  // list (LAN, or a code room the server issued nothing for) keeps "all" so host
  // candidates still work. Unchanged from before for those cases.
  return hasTurnServer(merged) ? { iceServers: merged, iceTransportPolicy: "relay" } : { iceServers: merged };
}

/** Pick the relay id that minimises the *worse* of the two peers' RTTs to it (then
 *  the sum, then the id for a stable, both-sides-identical tie-break). Only relays
 *  both peers measured are eligible. Returns null if there's no common relay. Pure
 *  and symmetric: fed (mine, theirs) on one side and (theirs, mine) on the other, it
 *  yields the SAME id — which is what lets both peers converge without negotiation. */
export function pickRelay(
  mine: Record<string, number>,
  theirs: Record<string, number>,
): string | null {
  let best: string | null = null;
  let bestMax = Infinity;
  let bestSum = Infinity;
  for (const id of Object.keys(mine)) {
    if (!(id in theirs)) continue;
    const mx = Math.max(mine[id], theirs[id]);
    const sum = mine[id] + theirs[id];
    if (mx < bestMax || (mx === bestMax && sum < bestSum) || (mx === bestMax && sum === bestSum && (best === null || id < best))) {
      best = id;
      bestMax = mx;
      bestSum = sum;
    }
  }
  return best;
}

/**
 * Whether `selectedId` already beats every relay of ours that is still being
 * probed — so waiting for the rest of our own measurement cannot change it.
 *
 * ## What the gate needs this for
 *
 * `pickRelay` is only final once `mine` can no longer grow, and `mine` stops
 * growing at the LAST probe: a relay that is silently dropping packets spends
 * the whole 9 s `measureRelay` budget and pins the answer behind it. The gate's
 * five-second peer bound then expires first, and a pairing that had a good
 * common relay in hand after 200 ms still waits five seconds for it. That is
 * the production shape a dead advertised relay produced.
 *
 * ## The two ways a pending relay is retired
 *
 * `pickRelay` orders candidates by the WORSE of the two peers' legs, so a
 * pending relay can only win if its own worst leg lands at or below the current
 * pick's `worstLeg`.
 *
 *  - **By the peer's leg alone, with no clock at all.** If `theirs[id]` is
 *    already strictly greater than `worstLeg`, then `max(ours, theirs)` for that
 *    relay is too, whatever our probe eventually reports.
 *  - **By elapsed measurement time**, when — and only when — the caller can
 *    supply a monotonic elapsed reading whose anchor is at or after the instant
 *    EVERY still-pending probe began timing. See `elapsedMs`.
 *
 * ## Why it is `>` and never `>=`
 *
 * At equality the pending relay ties on the worst leg and `pickRelay` falls
 * through to the sum and then to the id, either of which can still hand it the
 * room. Retiring a candidate that could tie is retiring one that could win.
 *
 * ## What this deliberately does NOT claim
 *
 * Only that our own remaining probes cannot change the answer, evaluated
 * against the two maps as they stand. `theirs` may still grow — a relay we have
 * measured but the peer has not can become a candidate when it does, and a peer
 * that revises a leg downwards can revive one the peer-leg test retired. Both
 * are exactly the uncertainty the already-shipped "measurement finished"
 * release accepts, because a peer map arriving after it moves the choice in the
 * same way; the peer deadline is what bounds it. This adds no new exposure.
 *
 * Mirrored by `RelayChoice.dominates` in RelayiumKit.
 *
 * @param elapsedMs Monotonic milliseconds since an anchor that is at or after
 *   the start of every probe still missing from `mine`, or `null` when no such
 *   anchor is available — in which case only the peer-leg test may retire a
 *   pending relay. `null` is the honest answer, not a degenerate one: an anchor
 *   taken BEFORE a probe started makes elapsed time an over-estimate of that
 *   probe's round trip, which retires relays that can still win.
 */
export function relayChoiceDominates(
  selectedId: string | null,
  mine: Record<string, number>,
  theirs: Record<string, number>,
  poolIds: readonly string[],
  elapsedMs: number | null,
): boolean {
  if (selectedId === null) return false;
  const myLeg = own(mine, selectedId);
  const peerLeg = own(theirs, selectedId);
  // Not a common relay, so not something `pickRelay` could have returned and
  // not something a pending probe has to beat. Defensive: unreachable through
  // `pickRelay`, which only ever names an id both maps carry.
  if (myLeg === undefined || peerLeg === undefined) return false;
  const worstLeg = Math.max(myLeg, peerLeg);

  // `measureRelay` reports `Math.round(...)`, so the comparison has to be made
  // in that same rounded domain or it is out by up to half a millisecond in the
  // unsafe direction. Rounding is monotone, so for a probe that has not
  // published yet — its true duration already exceeds `elapsedMs` — the value
  // it will eventually report is at least `Math.round(elapsedMs)`.
  const lowerBound = elapsedMs === null ? null : Math.round(elapsedMs);
  const clockRetires = lowerBound !== null && lowerBound > worstLeg;

  for (const id of poolIds) {
    if (own(mine, id) !== undefined) continue; // answered — `pickRelay` weighed it
    const known = own(theirs, id);
    if (known !== undefined && known > worstLeg) continue;
    if (clockRetires) continue;
    return false;
  }
  return true;
}

/** An OWN entry of an RTT map, and `undefined` for anything inherited. Relay ids
 *  are strings this client did not author — `"toString"` is a legal one — and
 *  plain-object indexing would answer with `Object.prototype`'s member for it,
 *  which reads as "already measured" and would retire a probe that is running. */
function own(map: Record<string, number>, id: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(map, id)) return undefined;
  const v = map[id];
  return typeof v === "number" ? v : undefined;
}

/**
 * The elapsed measurement time at which `relayChoiceDominates` is guaranteed to
 * retire every unfinished probe, for a pick whose worse leg is `worstLegMs`.
 *
 * What a caller uses to schedule the wake-up rather than poll for it. One whole
 * millisecond past the leg: the rule is a STRICT inequality evaluated on
 * `Math.round(elapsedMs)`, so `worstLegMs + 1` is the smallest integer elapsed
 * that clears it for certain (`worstLegMs + 0.5` also would, and rounding a
 * scheduled delay down is exactly what would make the wake-up find the
 * condition still false and have to arm itself again).
 *
 * Mirrored by `RelayChoice.dominanceElapsedMs` in RelayiumKit.
 */
export function relayDominanceElapsedMs(worstLegMs: number): number {
  return worstLegMs + 1;
}

/** Measure the TURN Allocate round-trip to one relay: time from setLocalDescription
 *  to its first `relay` candidate. Relay-only so nothing but the TURN path is probed.
 *  Returns null if no relay candidate arrives before the timeout (relay down / bad
 *  creds). The absolute value carries fixed overhead, but it's consistent across
 *  relays, so comparing them is valid.
 *
 *  The budget covers more than one round trip: DNS for the TURN name, the two
 *  Allocate exchanges long-term credentials require (the first always draws a
 *  401 challenge), and on a phone the radio waking from idle. Tens of
 *  milliseconds on desktop Wi-Fi, over a second on cellular — which is why 4s
 *  measured the whole pool as unreachable on mobile. Measuring nothing now only
 *  costs the optimisation (chooseRtcConfig still uses the pool), and this runs
 *  concurrently across relays in the background, so a slow probe delays no
 *  transfer. */
export async function measureRelay(entry: RelayEntry, timeoutMs = 9000): Promise<number | null> {
  const pc = new RTCPeerConnection({ iceServers: entry.iceServers, iceTransportPolicy: "relay" });
  try {
    const start = performance.now();
    return await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      pc.onicecandidate = (e) => {
        if (e.candidate && e.candidate.candidate.includes(" typ relay")) {
          clearTimeout(timer);
          resolve(Math.round(performance.now() - start));
        }
      };
      pc.createDataChannel("probe"); // an m-line so ICE actually gathers
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch(() => { clearTimeout(timer); resolve(null); });
    });
  } finally {
    pc.close();
  }
}

/**
 * Measure every relay in the pool in parallel, reporting each ONE AS IT ANSWERS.
 *
 * `onResult` is what makes this usable rather than merely correct. Awaiting the
 * whole pool means the caller sees nothing until the SLOWEST relay finishes, so
 * a single unreachable node pinned every result at the full `measureRelay`
 * timeout — nine seconds during which this page had nothing to publish, nothing
 * to select from and nothing to tell its peer. One dead relay cost every
 * transfer the entire relay-choice budget and produced nothing for it.
 *
 * Reporting per probe means a slow relay costs only its own absence: the fast
 * ones are on the wire, and in the peer's hands, immediately. Relays that never
 * answer are simply never reported, which is what makes them ineligible.
 *
 * The resolved map is still the complete one, for a caller that wants to know
 * when measurement has FINISHED — which is a different question from what has
 * been measured so far, and the one a relay gate waits on.
 *
 * ## Every probe has started before the first `onResult`
 *
 * `relayChoiceDominates` stands elapsed time in for an unfinished probe's round
 * trip, and that substitution is sound only against an anchor at or after the
 * instant that probe began timing. This function is what makes the FIRST
 * `onResult` such an anchor, and the argument is entirely about which
 * JavaScript job each line runs in:
 *
 *  - `pool.map(cb)` calls `cb` for every entry synchronously, in one job.
 *  - `cb` is `async`, so its body runs synchronously up to its first `await`.
 *    That first `await` is `await measureRelay(e)`, whose operand is evaluated
 *    first — so `measureRelay` is ENTERED in the same job.
 *  - `measureRelay` likewise runs synchronously to its own first `await`, which
 *    is `await new Promise(...)`. A promise executor runs synchronously during
 *    construction, and `const start = performance.now()` — the probe's clock —
 *    is on the line above it.
 *
 * So every probe's `start` is taken during the synchronous execution of
 * `pool.map`. `onResult` is reachable only after an `await` resumes, which is a
 * microtask at the very earliest, and no microtask runs until that synchronous
 * job has finished. The first published result therefore happens strictly after
 * the last probe started, and a main-thread stall of any length between two
 * constructions moves both sides of that ordering, not one.
 *
 * The three loose ends, none of which weakens it: a relay whose
 * `RTCPeerConnection` constructor throws leaves a rejected promise and the loop
 * continues, so the other probes still start; a relay that never answers is
 * simply never published, and stays pending, which is the conservative side; and
 * an empty pool publishes nothing at all, so there is no anchor and no choice to
 * make one for.
 *
 * `web/src/lib/ice.test.ts` pins this ordering against a deliberately stalled
 * construction, so it is a test rather than a comment.
 */
export async function measureRelays(
  pool: RelayEntry[],
  onResult?: (id: string, rttMs: number) => void,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(pool.map(async (e) => {
    const rtt = await measureRelay(e);
    if (rtt === null) return;
    out[e.id] = rtt;
    onResult?.(e.id, rtt);
  }));
  return out;
}
