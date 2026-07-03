// Fetches the RTCConfiguration.iceServers list from the server. For a rendezvous
// room — an anonymous pairing code (?code=) — the server returns STUN + an
// ephemeral TURN credential; for LAN (no code) it returns STUN only. Passing the
// pairing code is what lets code transfers relay through TURN across strict NATs
// instead of failing STUN-only. On ANY failure — a non-ok status, a network
// error, or a body that isn't JSON (e.g. a misconfigured nginx serving
// index.html for /api/*) — we fall back to a public STUN server so a direct-only
// connection can still be attempted and the app never gets stuck before
// signaling starts.
const FALLBACK: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export async function fetchIceServers(code = ""): Promise<RTCIceServer[]> {
  const q = code ? `?code=${encodeURIComponent(code)}` : "";
  try {
    const res = await fetch(`/api/ice${q}`, { credentials: "include" });
    if (!res.ok) return FALLBACK;
    return ((await res.json()).iceServers as RTCIceServer[]) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}
