// Parsing one stored-link string into the two values a receive needs.
//
// ## What this is allowed to produce
//
// An object id and a key. Nothing else — in particular, NOT an origin. The
// origin is this build's (`origin.ts`), so a link cannot redirect a download
// anywhere: `https://relayium.com/d/<id>` and `relayium://d/<id>` reach exactly
// the same endpoint as each other, and a hostile link that names another host
// is refused rather than followed. That is why this returns `{id, key}` and the
// transport takes its origin from the build.
//
// ## Why the grammar is exact rather than tolerant
//
// The alternative — "parse a URL, pull out the last path segment and the
// fragment" — accepts `https://relayium.com/anything/else/d/x?utm=1#k=…` and
// every other shape nobody generates. This app fetches unauthenticated bytes
// and writes them to the user's disk, so the set of strings that can start that
// is the documented one: one route element, one id, one `#k=` fragment, no
// query, no credentials, no non-standard port. A link outside it is refused,
// never repaired.
//
// ## The key never appears in a rejection, and never in a log
//
// Every refusal below is a bare reason code: no input, no substring, no length.
// And the accepted result carries its key on a NON-ENUMERABLE property, so
// `JSON.stringify(link)`, a structured log line or an object dump cannot spill
// it. Reaching the key requires naming it.

import { PRODUCTION_HOST } from "../deep-link.js";
import { apiOrigin } from "../origin.js";

/** Why a link was refused. Stable strings — the renderer maps them to copy. */
export type StoredLinkRejection =
  | "not-a-relayium-link"
  | "untrusted-origin"
  | "not-a-stored-link"
  | "malformed"
  | "too-long"
  | "invalid-id"
  | "missing-key";

export interface StoredLink {
  readonly id: string;
  /**
   * The base64url key from the fragment, still encoded.
   *
   * Non-enumerable (see the header). It is handed straight to
   * `StoredRuntime.importKeyFromFragment`, which decodes it and imports it
   * non-extractably. The bundle runs in THIS process, so that is not isolation:
   * what it buys is that the raw bytes stay a temporary inside one call and are
   * never journalled, logged or sent.
   */
  readonly key: string;
}

export type StoredLinkResult =
  | { readonly ok: true; readonly link: StoredLink }
  | { readonly ok: false; readonly reason: StoredLinkRejection };

/** Matches `deep-link.ts`. A link this long is not one the product generates. */
const MAX_LINK_LENGTH = 2048;

/**
 * The two route heads the released clients recognise.
 *
 * `web/src/lib/transfer-link.ts` builds `/d/`; `src/main/deep-link.ts` — which
 * already routes `relayium://` arguments in this process — recognises `d` and
 * `download`. Both are admitted here so the two parsers in one app cannot
 * disagree about what a stored link is, and nothing wider is.
 */
const ROUTE_HEADS = new Set(["d", "download"]);

/**
 * The id grammar, restated from `web/src/lib/stored-file.ts`.
 *
 * That module's `checkedStoredObjectId` is private, so this is a restatement
 * rather than a reuse — pinned by a test that spells out the same rule. Wide
 * enough for any plausible future id format, narrow enough that every member is
 * inert in a URL path, a query string and a link fragment; every id the server
 * actually issues is 32 hex characters, nowhere near the edge of it.
 *
 * `%` is absent, so a percent-encoded id is refused rather than decoded — this
 * parser never unescapes anything, and the value it returns is the value the
 * transport encodes.
 */
const STORED_OBJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `web/src/lib/stored-file.ts`'s `parseDownloadKey`, exactly. */
const KEY_FRAGMENT = /^#k=([A-Za-z0-9_-]+)$/;

/**
 * The hosts an `https://` stored link may name.
 *
 * Production always, plus this build's configured origin when it differs —
 * which only an engineering build can arrange, and only to a loopback host
 * (`origin.ts` enforces that). A production link stays valid in an engineering
 * build: the link supplies an id and a key, the BUILD supplies the origin, so
 * the two are independent by design.
 */
export function trustedLinkHosts(): readonly string[] {
  const configured = new URL(apiOrigin()).hostname;
  return configured === PRODUCTION_HOST ? [PRODUCTION_HOST] : [PRODUCTION_HOST, configured];
}

const refuse = (reason: StoredLinkRejection): StoredLinkResult => ({ ok: false, reason });

/**
 * Parse one stored link. Total: every input yields a result, and it never
 * throws — its callers are event handlers where a throw is an unhandled
 * rejection rather than a diagnostic.
 */
export function parseStoredLink(raw: string, hosts: readonly string[] = trustedLinkHosts()): StoredLinkResult {
  if (typeof raw !== "string" || raw.length === 0) return refuse("malformed");
  if (raw.length > MAX_LINK_LENGTH) return refuse("too-long");

  const lower = raw.toLowerCase();
  if (!lower.startsWith("relayium:") && !lower.startsWith("https:")) return refuse("not-a-relayium-link");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("malformed");
  }

  // Credentials are refused on BOTH schemes. A custom scheme is not a safer
  // input than https — anything on the machine can hand one to this app.
  if (url.username !== "" || url.password !== "") return refuse("untrusted-origin");
  // No query. The product generates none on a stored link, and a parser that
  // ignores unknown parameters is a parser that will one day honour one.
  if (url.search !== "") return refuse("not-a-stored-link");

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  let segments: string[];
  if (scheme === "https") {
    if (!hosts.includes(url.hostname.toLowerCase())) return refuse("untrusted-origin");
    if (url.port !== "" && url.port !== "443") return refuse("untrusted-origin");
    segments = url.pathname.split("/").filter((part) => part.length > 0);
  } else if (scheme === "relayium") {
    if (url.port !== "") return refuse("untrusted-origin");
    // `relayium://d/<id>` puts the route element in `host`. It is spliced back
    // onto the front of the path so exactly one grammar is evaluated below;
    // treating an arbitrary host as a route name would let `relayium://anything`
    // reach this code path. Same conversion `deep-link.ts` performs.
    segments = [url.hostname, ...url.pathname.split("/").filter((part) => part.length > 0)].filter(
      (part) => part.length > 0,
    );
  } else {
    return refuse("not-a-relayium-link");
  }

  const [head, ...rest] = segments;
  if (head === undefined || !ROUTE_HEADS.has(head.toLowerCase())) return refuse("not-a-stored-link");
  // Exactly one element after the route. A trailing segment is not a link this
  // product generates, and guessing what it meant is how a route grows by
  // accident.
  if (rest.length !== 1) return refuse("not-a-stored-link");
  const id = rest[0];
  if (id === undefined || !STORED_OBJECT_ID.test(id)) return refuse("invalid-id");

  const key = KEY_FRAGMENT.exec(url.hash)?.[1];
  // A stored link without its key is not a weaker link, it is an unusable one:
  // the bytes are AES-GCM under a key that only ever lived in the fragment.
  if (key === undefined) return refuse("missing-key");

  const link = { id } as { id: string; key: string };
  Object.defineProperty(link, "key", { value: key, enumerable: false });
  return { ok: true, link };
}
