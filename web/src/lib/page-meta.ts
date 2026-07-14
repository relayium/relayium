import type { Route } from "./router.svelte";
import { CROSS_PATH, OFFLINE_PATH } from "./router.svelte";
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
  ["x-default", ""],
];

// altHreflangs maps a canonical path to its per-language alternate URLs. index.html
// ships the homepage cluster (/, /zh/, …); the SPA calls this so /cross-network and
// /offline-transfer point their hreflang at their own localized pages
// (/zh/cross-network, …) — which exist as static pages — instead of the homepage.
export function altHreflangs(canonicalPath: string): { hreflang: string; path: string }[] {
  return HREFLANG_PREFIX.map(([hreflang, prefix]) => ({
    hreflang,
    path: canonicalPath === "/" ? prefix + "/" : prefix + canonicalPath,
  }));
}
