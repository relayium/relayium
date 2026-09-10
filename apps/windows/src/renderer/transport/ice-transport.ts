// The `/api/ice` transport for `fetchIceConfig`, routed through main.
//
// ## What is reused, and what is replaced
//
// Replaced: the request. A relative `/api/ice` resolves against
// `app://relayium` here and reaches the bundle rather than the API server, so
// main performs it.
//
// Reused: everything else. `fetchIceConfig` classifies the answer — the one
// retry, the `Retry-After` cap, 429-is-rate-limiting-not-a-failure, the
// `relayDenied` passthrough, and `relayStatusOf`'s "a code room with no TURN is
// `none`, a LAN room with no TURN is fine". Re-deriving any of that here is the
// silent divergence the directly-imported protocol exists to prevent, and the
// first draft of this slice proved the point by losing four of those cases.
//
// So this file does exactly one thing: turn main's reply back into the
// `Response` the shared classifier already knows how to read.

import type { IceTransport } from "../../../../../web/src/lib/ice";
import type { IceBridge } from "./bridge.js";

/**
 * The URL `fetchIceConfig` would have fetched, for this code.
 *
 * Recomputed here ONLY to check it — see below. It is not used to address
 * anything.
 */
const expectedPath = (code: string): string =>
  `/api/ice${code ? `?code=${encodeURIComponent(code)}` : ""}`;

/**
 * Statuses that may not carry a body, per the `Response` constructor.
 *
 * Reconstructing one with a body throws, which would turn a server's 204 into a
 * renderer exception rather than a classification.
 */
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * An `IceTransport` bound to one pairing code.
 *
 * ## Why the code is closed over rather than read from the URL
 *
 * Because the renderer does not get to name a destination — that is the rule the
 * whole IPC surface is built on, and a transport that parsed a URL and asked
 * main to fetch it would be exactly the generic proxy this design refuses.
 * `code` is what main accepts, so `code` is what is passed.
 *
 * The URL is still CHECKED against what this code should have produced. Not
 * defence — the caller is the shared module — but a tripwire: if `fetchIceConfig`
 * ever addresses a different path or encodes a code differently, this transport
 * would silently keep fetching the old one, and a mismatch nobody notices is
 * how two clients end up disagreeing about the same endpoint. It fails loudly
 * instead, and `readIceConfig`'s `catch` turns that into "unavailable".
 */
export function createIceTransport(bridge: IceBridge, code: string, owner: string): IceTransport {
  return async (url: string): Promise<Response> => {
    if (url !== expectedPath(code)) {
      throw new Error(`ice transport bound to a different request: ${url}`);
    }

    // The room owns the request. Main bounds how many one room may have in
    // flight and releases them when that room's socket ends, so a closed room
    // does not leave a privileged outbound connection running for an answer
    // nobody will read.
    const reply = await bridge.config(code ? { owner, code } : { owner });

    // No status line at all: a network error, a deadline, a refused redirect, a
    // malformed code. Rejecting is the accurate translation — it is what a
    // browser `fetch` does for the same conditions, and `readIceConfig` already
    // classifies it as "unavailable, worth one retry".
    if (!reply.ok) throw new Error(`ice request failed: ${reply.failure}`);

    const headers = new Headers();
    if (reply.retryAfterSeconds !== undefined) {
      // Handed back as the header it came from, so the shared module's own
      // `Retry-After` parsing and cap are what interpret it. Converting to ms
      // here would be this file making the retry decision.
      headers.set("Retry-After", String(reply.retryAfterSeconds));
    }

    // A null body reaches `res.json()` as a parse failure, which is exactly how
    // `readIceConfig` already treats a body it cannot read — including the
    // oversized and non-JSON cases main folds into `null`.
    const body =
      reply.body === null || NULL_BODY_STATUS.has(reply.status) ? null : JSON.stringify(reply.body);
    if (body !== null) headers.set("content-type", "application/json");

    return new Response(body, { status: reply.status, headers });
  };
}
