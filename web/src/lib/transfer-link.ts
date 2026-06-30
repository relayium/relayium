// One-time cross-network transfer link: a rendezvous room token carried in the
// URL fragment (#t=<token>) so it never reaches server logs or the Referer
// header. The token is minted by the (authenticated) sender via POST
// /api/transfers; anyone holding the link can join the room (capability model).

/** Extract the transfer token from a location hash like "#t=abc". "" if none. */
export function parseTransferToken(hash: string): string {
  const m = /^#t=([A-Za-z0-9]+)$/.exec(hash);
  return m ? m[1] : "";
}

/** Path of the cross-network page; shared links and the originator both target it. */
export const CROSS_PATH = "/cross-network";

/** Build the shareable link for a token against the given origin. */
export function buildTransferLink(origin: string, token: string): string {
  return `${origin}${CROSS_PATH}#t=${token}`;
}

/** Construct the signaling websocket URL, appending ?room= for a token-room. */
export function wsURL(
  loc: { protocol: string; host: string },
  token: string,
): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${loc.host}/ws`;
  return token ? `${base}?room=${encodeURIComponent(token)}` : base;
}

/** Mint a rendezvous token. Requires an authenticated session (cookie). */
export async function createTransfer(): Promise<{
  token: string;
  expiresAt: number;
}> {
  const res = await fetch("/api/transfers", {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`createTransfer failed: ${res.status}`);
  return res.json();
}
