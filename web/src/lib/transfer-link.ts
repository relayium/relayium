// Cross-network realtime rendezvous: a short pairing code minted by a
// logged-in owner via POST /api/pair (401 without a session — the initiator
// owns the transfer and its relay usage). The join link carries the code in
// the URL fragment (#c=<code>) so it never reaches server logs or the Referer
// header; anyone holding a live code can join its 2-peer room anonymously
// (capability model — only minting requires a session, joining does not).

/** Error carrying the HTTP status of a failed mint. A thrown TypeError (fetch
 *  never reached the server) is left as-is and surfaces as a network error. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

/** Extract a 6-digit pairing code from a hash like "#c=424242". "" if none. */
export function parseCodeParam(hash: string): string {
  const m = /^#c=(\d{6})$/.exec(hash);
  return m ? m[1] : "";
}

/** Path of the cross-network page; join links and the originator both target it. */
export const CROSS_PATH = "/cross-network";

/** Path prefix of the public stored-download page: /d/<id>. Single source of truth. */
export const DOWNLOAD_PREFIX = "/d/";

/** Construct the signaling websocket URL: the code's 2-peer room, or with no
 *  code the LAN (IP-grouped) socket. */
export function wsURL(loc: { protocol: string; host: string }, code = ""): string {
  const proto = loc.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${loc.host}/ws`;
  return code ? `${base}?code=${encodeURIComponent(code)}` : base;
}

/** Mint a short pairing code owned by the logged-in user. Requires a session:
 *  a missing/expired one yields a 401 (surfaced as an HttpError the caller uses
 *  to re-prompt login). The receiver who joins by code needs no session. */
export async function createPair(): Promise<{ code: string; expiresAt: number }> {
  const res = await fetch("/api/pair", { method: "POST" });
  if (!res.ok) throw new HttpError(res.status, `createPair failed: ${res.status}`);
  return res.json();
}
