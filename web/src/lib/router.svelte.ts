// Minimal client-side router for the Relayium SPA, driven by Svelte 5 runes.
// Two routes: the LAN transfer page (default, "/") and the cross-network page
// ("/cross-network"). A transfer token in the URL fragment (#t=<token>) always
// implies the cross-network page so a shared link lands the recipient correctly.

import { parseTransferToken, parseCodeParam, CROSS_PATH, DOWNLOAD_PREFIX } from "./transfer-link";
import { clearRoom } from "./room.svelte";

export type Route = "lan" | "cross" | "download";

export { CROSS_PATH };

/** Pure mapping from a location to a route. Safe to unit-test without a DOM. */
export function routeFromLocation(pathname: string, hash: string): Route {
  if (downloadId(pathname)) return "download";
  if (parseTransferToken(hash) || parseCodeParam(hash)) return "cross";
  return pathname === CROSS_PATH ? "cross" : "lan";
}

/** Extract the file id from a /d/<id> path, or "" when not a download path. */
export function downloadId(pathname: string): string {
  return pathname.startsWith(DOWNLOAD_PREFIX)
    ? pathname.slice(DOWNLOAD_PREFIX.length)
    : "";
}

let route = $state<Route>("lan");

export function currentRoute(): Route {
  return route;
}

/** Read the live browser location into the reactive route (use on load + popstate). */
export function syncRouteFromLocation(): void {
  route = routeFromLocation(location.pathname, location.hash);
}

/** Switch tabs without reloading: drop any active token/code room, rewrite the URL,
 *  and update the route. Clearing the room makes App's effect reconnect the
 *  signaling socket to the room-less (LAN) endpoint, so no page reload is needed. */
export function navigate(r: Route): void {
  const pathname = r === "cross" ? CROSS_PATH : "/";
  clearRoom(); // leaving a 2-peer token/code room rebinds the socket via App's effect
  history.pushState({}, "", pathname);
  route = r;
}
