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

export interface IceConfig {
  iceServers: RTCIceServer[]; // fallback / legacy single relay + STUN
  relays: RelayEntry[]; // the pool (empty unless the server advertises one)
  relayDenied?: string; // "quota" when the code owner is over the monthly relay cap and TURN was withheld
}

export async function fetchIceConfig(code = ""): Promise<IceConfig> {
  const q = code ? `?code=${encodeURIComponent(code)}` : "";
  try {
    const res = await fetch(`/api/ice${q}`, { credentials: "include" });
    if (!res.ok) return { iceServers: FALLBACK, relays: [] };
    const body = (await res.json()) as {
      iceServers?: RTCIceServer[];
      relays?: RelayEntry[];
      relayDenied?: string;
    };
    return { iceServers: body.iceServers ?? FALLBACK, relays: body.relays ?? [], relayDenied: body.relayDenied };
  } catch {
    return { iceServers: FALLBACK, relays: [] };
  }
}

export async function fetchIceServers(code = ""): Promise<RTCIceServer[]> {
  return (await fetchIceConfig(code)).iceServers;
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
 *  relays, so comparing them is valid. */
export async function measureRelay(entry: RelayEntry, timeoutMs = 4000): Promise<number | null> {
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
