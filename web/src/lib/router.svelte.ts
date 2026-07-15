// Minimal client-side router for the Relayium SPA, driven by Svelte 5 runes.
// Three pages: the LAN transfer page (default, "/"), the realtime cross-network
// page ("/cross-network"), and the async stored-transfer page ("/offline-transfer").
// A pairing code in the URL fragment (#c=<code>) always implies the cross-network
// page so a join link lands the recipient correctly.

import { parseCodeParam, CROSS_PATH, DOWNLOAD_PREFIX } from "./transfer-link";
import { clearRoom } from "./room.svelte";

export type Route = "lan" | "cross" | "offline" | "download" | "me" | "cli" | "pricing" | "verify-email" | "reset-password";

/** Personal center path. Login-gated page; not part of the transfer flows. */
export const ME_PATH = "/me";

/** CLI docs page (static content; not a transfer flow). */
export const CLI_PATH = "/cli";

/** Pricing / plans page (public marketing + in-app upgrade/downgrade). */
export const PRICING_PATH = "/pricing";

/** Path of the async stored-transfer page (login-gated; the paid tier lives here). */
export const OFFLINE_PATH = "/offline-transfer";

/** Email-verification landing page. The backend's verification email links here
 *  with ?token=<t>; not part of the transfer flows. */
export const VERIFY_EMAIL_PATH = "/verify-email";

/** Password-reset landing page. The backend's reset email links here with
 *  ?token=<t>; not part of the transfer flows. */
export const RESET_PASSWORD_PATH = "/reset-password";

export { CROSS_PATH };

/** Pure mapping from a location to a route. Safe to unit-test without a DOM. */
export function routeFromLocation(pathname: string, hash: string): Route {
  if (downloadId(pathname)) return "download";
  if (parseCodeParam(hash)) return "cross";
  if (pathname === CROSS_PATH) return "cross";
  if (pathname === OFFLINE_PATH) return "offline";
  if (pathname === ME_PATH) return "me";
  if (pathname === CLI_PATH) return "cli";
  if (pathname === PRICING_PATH) return "pricing";
  if (pathname === VERIFY_EMAIL_PATH) return "verify-email";
  if (pathname === RESET_PASSWORD_PATH) return "reset-password";
  return "lan";
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

// Optional guard consulted before a navigation that would tear down room-scoped
// state (and thus abort an in-flight transfer). Returns true to proceed, false to
// cancel. App registers one that confirms before interrupting an active transfer.
let navGuard: (() => boolean) | null = null;
export function setNavGuard(g: (() => boolean) | null): void {
  navGuard = g;
}

/** Switch tabs without reloading: drop any active code room, rewrite the URL,
 *  and update the route. Clearing the room makes App's effect reconnect the
 *  signaling socket to the room-less (LAN) endpoint, so no page reload is needed. */
export function navigate(r: Route): void {
  if (r === route) return; // already on this tab — don't tear down the room / abort a transfer
  if (navGuard && !navGuard()) return; // e.g. user declined the "interrupt transfer?" confirm
  const pathname =
    r === "cross" ? CROSS_PATH
    : r === "offline" ? OFFLINE_PATH
    : r === "me" ? ME_PATH
    : r === "cli" ? CLI_PATH
    : r === "pricing" ? PRICING_PATH
    : r === "verify-email" ? VERIFY_EMAIL_PATH
    : r === "reset-password" ? RESET_PASSWORD_PATH
    : "/";
  clearRoom(); // leaving a 2-peer code room rebinds the socket via App's effect
  history.pushState({}, "", pathname);
  route = r;
}
