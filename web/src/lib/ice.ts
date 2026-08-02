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

/** Measure every relay in the pool in parallel; drop the ones that didn't answer. */
export async function measureRelays(pool: RelayEntry[]): Promise<Record<string, number>> {
  const pairs = await Promise.all(pool.map(async (e) => [e.id, await measureRelay(e)] as const));
  const out: Record<string, number> = {};
  for (const [id, rtt] of pairs) if (rtt !== null) out[id] = rtt;
  return out;
}
