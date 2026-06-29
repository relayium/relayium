// Fetches the RTCConfiguration.iceServers list from the server. For a token-room
// the server returns STUN + an ephemeral TURN credential; for LAN (no token) it
// returns STUN only. On any failure we fall back to a public STUN server so a
// direct-only connection can still be attempted.
export async function fetchIceServers(token: string): Promise<RTCIceServer[]> {
  const q = token ? `?room=${encodeURIComponent(token)}` : "";
  const res = await fetch(`/api/ice${q}`, { credentials: "include" });
  if (!res.ok) return [{ urls: "stun:stun.l.google.com:19302" }];
  return (await res.json()).iceServers as RTCIceServer[];
}
