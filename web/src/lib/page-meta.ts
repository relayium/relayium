import type { Route } from "./router.svelte";
import type { Messages } from "./i18n/types";

// pageMeta returns the per-route <title> + <meta description>. Only the two
// cross-network product modes get bespoke copy; every other route uses the
// default home title/description.
export function pageMeta(route: Route, m: Messages): { title: string; description: string } {
  if (route === "cross") return { title: m.titleCross, description: m.descCross };
  if (route === "offline") return { title: m.titleOffline, description: m.descOffline };
  return { title: m.titleDefault, description: m.descDefault ?? m.titleDefault };
}
