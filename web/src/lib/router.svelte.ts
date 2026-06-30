// Minimal client-side router for the Relayium SPA, driven by Svelte 5 runes.
// Two routes: the LAN transfer page (default, "/") and the cross-network page
// ("/cross-network"). A transfer token in the URL fragment (#t=<token>) always
// implies the cross-network page so a shared link lands the recipient correctly.

import { parseTransferToken, CROSS_PATH, DOWNLOAD_PREFIX } from "./transfer-link";

export type Route = "lan" | "cross" | "download";

export { CROSS_PATH };

/** Pure mapping from a location to a route. Safe to unit-test without a DOM. */
export function routeFromLocation(pathname: string, hash: string): Route {
  if (downloadId(pathname)) return "download";
  if (parseTransferToken(hash)) return "cross";
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

/** Switch tabs without reloading: rewrite the URL and update the route. Drops any
 *  stale token fragment so a plain tab switch never re-enters a transfer room.
 *  If a transfer token is in the current URL, the signaling socket is bound to the
 *  2-peer token room. Leaving it must fully reload so the socket reconnects
 *  into the correct room (LAN, or a fresh token-less cross page). */
export function navigate(r: Route): void {
  const pathname = r === "cross" ? CROSS_PATH : "/";
  // If a transfer token is in the URL, the signaling socket is bound to the
  // 2-peer token room. Leaving it must fully reload so the socket reconnects
  // into the correct room (LAN, or a fresh token-less cross page).
  if (parseTransferToken(location.hash)) {
    location.href = pathname; // full navigation + reload; drops the token
    return;
  }
  history.pushState({}, "", pathname);
  route = r;
}
