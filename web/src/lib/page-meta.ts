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
