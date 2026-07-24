import type { Route } from "./router.svelte";
import { CROSS_PATH, OFFLINE_PATH, PRICING_PATH, APPS_PATH, CLI_PATH } from "./router.svelte";
import type { Messages } from "./i18n/types";

// pageMeta returns the per-route <title> + <meta description> + canonical path.
// Only the two cross-network product modes get bespoke copy; every other route
// uses the default home title/description. canonicalPath lets the SPA point its
// <link rel=canonical>/og:url at the route's own URL instead of always "/", so
// /cross-network and /offline-transfer index as themselves rather than folding
// into the homepage.
export function pageMeta(
  route: Route,
  m: Messages
): { title: string; description: string; canonicalPath: string } {
  if (route === "cross") return { title: m.titleCross, description: m.descCross, canonicalPath: CROSS_PATH };
  if (route === "offline") return { title: m.titleOffline, description: m.descOffline, canonicalPath: OFFLINE_PATH };
  if (route === "pricing") return { title: `${m.pricingPage.title} · Relayium`, description: m.pricingPage.subtitle, canonicalPath: PRICING_PATH };
  if (route === "apps") return { title: m.appsPage.metaTitle, description: m.appsPage.metaDesc, canonicalPath: APPS_PATH };
  // /cli was missing here, so the docs page inherited the homepage's title AND
  // its canonical — the page told Google "I am the homepage" and de-indexed
  // itself. The static shell (scripts/pages/shells.mjs) gets it right in the raw
  // HTML; without this branch the SPA overwrote that back to "/" on boot, which
  // is exactly what a rendering crawler reads.
  if (route === "cli") return { title: m.cliPage.metaTitle, description: m.cliPage.metaDesc, canonicalPath: CLI_PATH };
  return { title: m.titleDefault, description: m.descDefault ?? m.titleDefault, canonicalPath: "/" };
}

// hreflang → localized-URL prefix. English (and x-default) live at the root; each
// other language has static pages under "/<prefix>". Order and codes mirror the
// static <link rel=alternate> tags baked into index.html.
const HREFLANG_PREFIX: [string, string][] = [
  ["en", ""],
  ["zh-Hans", "/zh"],
  ["ja", "/ja"],
  ["ko", "/ko"],
  ["de", "/de"],
  ["fr", "/fr"],
  ["ar", "/ar"],
  ["es", "/es"],
  ["pt", "/pt"],
  ["x-default", ""],
];

// Routes that actually have a localized page in every language. Only these get an
// hreflang cluster: /pricing and /cli exist in English only, and pointing an
// alternate at /zh/pricing — a URL that 404s — is worse than emitting none.
const CLUSTERED_PATHS = new Set(["/", CROSS_PATH, OFFLINE_PATH, APPS_PATH]);

// altHreflangs maps a canonical path to its per-language alternate URLs, or to an
// empty list when the route has no localized twins. index.html ships the homepage
// cluster (/, /zh/, …); the SPA calls this so /cross-network and /offline-transfer
// point their hreflang at their own localized pages instead of the homepage.
//
// The localized pages are generated at <lang>/<slug>/index.html and the origin
// 301s the slash-less form, so the alternates MUST carry the trailing slash —
// that is the form the static pages use to reference each other, and an
// alternate that redirects is a non-reciprocal cluster. English keeps its
// slash-less SPA route (there is no /cross-network/ directory).
export function altHreflangs(canonicalPath: string): { hreflang: string; path: string }[] {
  if (!CLUSTERED_PATHS.has(canonicalPath)) return [];
  return HREFLANG_PREFIX.map(([hreflang, prefix]) => ({
    hreflang,
    path: canonicalPath === "/" ? prefix + "/" : prefix + canonicalPath + (prefix ? "/" : ""),
  }));
}
