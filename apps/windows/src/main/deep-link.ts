// `relayium://` and `https://relayium.com/…` links, parsed into the routes the
// product actually has.
//
// The route set is not invented here. It mirrors
// `RelayiumKit/Sources/RelayiumAppKit/AppDeepLink.swift`, which is what the
// released macOS app handles:
//
//   * `download(URL)`            — a stored link
//   * `realtime(code?)`          — cross-network, optionally pre-filled
//   * `realtimeWithMode(code, mode)` — with a trailing `/file` or `/text`
//
// Windows parses exactly these and nothing else. `download` is recognised and
// then REJECTED as not-yet-handled rather than dropped: the difference between
// "this is not a Relayium link" and "this is a stored link and this build cannot
// open it yet" is the difference between a bug report and a known gap, and only
// the first is silent.

export type TransferMode = "files" | "text";

export type DeepLinkRoute =
  | { readonly kind: "download"; readonly url: string }
  | { readonly kind: "realtime"; readonly code: string | null }
  | { readonly kind: "realtime-with-mode"; readonly code: string; readonly mode: TransferMode };

export type DeepLinkRejection =
  | "not-a-relayium-link"
  | "untrusted-origin"
  | "unknown-route"
  | "malformed"
  | "too-long"
  /** A route this build understands but cannot yet act on. */
  | "not-yet-supported";

export type DeepLinkResult =
  | { readonly ok: true; readonly route: DeepLinkRoute }
  | { readonly ok: false; readonly reason: DeepLinkRejection };

export const APP_SCHEME = "relayium";
export const PRODUCTION_HOST = "relayium.com";

/** The one route the released app generates. */
const PAIRING_PATH = "cross-network";

/**
 * A pairing code is SIX DIGITS, and it is a string.
 *
 * `004291` is a real code. Parsed as a number it becomes `4291`, which is a
 * different code and will not join anything — so it is matched and carried as
 * text, leading zeros intact, and never converted.
 */
const CODE = /^[0-9]{6}$/;

const MAX_URL_LENGTH = 2048;

/** `mode=text` / `mode=file`. Absent means the link names no mode. */
function parseMode(raw: string | null): TransferMode | null | "invalid" {
  if (raw === null) return null;
  const mode = raw.toLowerCase();
  if (mode === "text") return "text";
  if (mode === "file" || mode === "files") return "files";
  return "invalid";
}

/**
 * Parse one argument.
 *
 * ## The shape, taken from the released app rather than guessed
 *
 * `AppDeepLink.swift` generates
 * `https://relayium.com/cross-network?mode=text#c=004291`: the code lives in the
 * FRAGMENT, the mode in the QUERY. An earlier version of this file read neither
 * — it looked for the code as a path segment — so every real link parsed as
 * "cross-network, no code" and would have opened an empty pairing screen. The
 * fragment also never leaves the client, which is why the code is carried there.
 *
 * Total: every input yields a result, and it never throws. Its only caller is an
 * event handler in the main process, where a throw is an unhandled rejection
 * rather than a diagnostic.
 */
export function parseDeepLink(raw: string): DeepLinkResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, reason: "malformed" };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, reason: "too-long" };

  const lower = raw.toLowerCase();
  if (!lower.startsWith(`${APP_SCHEME}:`) && !lower.startsWith("https:")) {
    return { ok: false, reason: "not-a-relayium-link" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Credentials and a non-standard port are refused on BOTH schemes. A custom
  // scheme is not a safer input than https — anything on the machine can hand
  // one to this app.
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "untrusted-origin" };

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  let segments: string[];

  if (scheme === "https") {
    if (url.hostname.toLowerCase() !== PRODUCTION_HOST) return { ok: false, reason: "untrusted-origin" };
    if (url.port !== "" && url.port !== "443") return { ok: false, reason: "untrusted-origin" };
    segments = url.pathname.split("/").filter((part) => part.length > 0);
  } else if (scheme === APP_SCHEME) {
    if (url.port !== "") return { ok: false, reason: "untrusted-origin" };
    // ## Canonical conversion, not "the host is the route"
    //
    // `relayium://cross-network?mode=text#c=004291` puts the first path element
    // in `host`. It is spliced back onto the front of the path so exactly one
    // route grammar is evaluated below; treating an arbitrary host as a route
    // name would let `relayium://anything` reach the same code paths as the
    // production origin.
    segments = [url.hostname, ...url.pathname.split("/").filter((part) => part.length > 0)].filter(
      (part) => part.length > 0,
    );
  } else {
    return { ok: false, reason: "not-a-relayium-link" };
  }

  const [head, ...rest] = segments;
  if (head === undefined) return { ok: false, reason: "unknown-route" };
  const route = head.toLowerCase();

  if (route === "d" || route === "download") {
    // Recognised, and handed on WHOLE.
    //
    // Deliberately not parsed here. `stored/link.ts` decides what a stored link
    // is — hosts, credentials, query, length, fragment — and two parsers over
    // one attacker-supplied string diverge, with the one nearest the key being
    // the one that matters. So this returns the original text and the stored
    // path stays the single authority.
    //
    // `url` is the ORIGINAL string, not a re-serialised one: a fragment is a
    // key, and normalising it through `URL` is a way to change it.
    return { ok: true, route: { kind: "download", url: raw } };
  }
  if (route !== PAIRING_PATH) return { ok: false, reason: "unknown-route" };
  // Exactly one path element. A trailing segment is not a link this product
  // generates, and guessing what it meant is how a route grows by accident.
  if (rest.length > 0) return { ok: false, reason: "unknown-route" };

  const mode = parseMode(url.searchParams.get("mode"));
  if (mode === "invalid") return { ok: false, reason: "unknown-route" };

  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (fragment.length === 0) {
    return mode === null
      ? { ok: true, route: { kind: "realtime", code: null } }
      : { ok: false, reason: "malformed" };
  }

  // ONE item. `#c=1&c=2` is not a link this product makes, and taking the first
  // would silently pick one of two codes.
  if (fragment.includes("&")) return { ok: false, reason: "malformed" };
  if (!fragment.startsWith("c=")) return { ok: false, reason: "malformed" };

  const code = fragment.slice(2);
  if (!CODE.test(code)) return { ok: false, reason: "malformed" };

  return mode === null
    ? { ok: true, route: { kind: "realtime", code } }
    : { ok: true, route: { kind: "realtime-with-mode", code, mode } };
}
/**
 * The first parseable link in an argv, or a rejection.
 *
 * A second instance forwards everything it was started with, including switches
 * and a path. Scanning for the first thing that parses — rather than assuming a
 * position — is what makes that safe.
 */
export function routeFromArgv(argv: readonly string[]): DeepLinkResult {
  let lastRejection: DeepLinkRejection = "not-a-relayium-link";
  for (const arg of argv) {
    const result = parseDeepLink(arg);
    if (result.ok) return result;
    if (result.reason !== "not-a-relayium-link") lastRejection = result.reason;
  }
  return { ok: false, reason: lastRejection };
}
