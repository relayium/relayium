// Minimal client-side router for the Relayium SPA, driven by Svelte 5 runes.
// Three pages: the LAN transfer page (default, "/"), the realtime cross-network
// page ("/cross-network"), and the async stored-transfer page ("/offline-transfer").
// A pairing code in the URL fragment (#c=<code>) always implies the cross-network
// page so a join link lands the recipient correctly.

import { parseCodeParam, CROSS_PATH, DOWNLOAD_PREFIX } from "./transfer-link";
import { clearRoom } from "./room.svelte";

export type Route = "lan" | "cross" | "offline" | "download" | "me" | "cli" | "apps" | "device-inbox" | "pricing" | "verify-email" | "reset-password" | "magic-link";

/** Path of the LAN / same-network transfer page. It is the site root, so this
 *  constant exists to name it rather than to compute it: copy that links the
 *  three transfer modes side by side should not spell one of them as a bare
 *  string while the other two are constants. */
export const LAN_PATH = "/";

/** Personal center path. Login-gated page; not part of the transfer flows. */
export const ME_PATH = "/me";

/** CLI docs page (static content; not a transfer flow). */
export const CLI_PATH = "/cli";

/** Apps / downloads hub: web, CLI, and (coming soon) native macOS/iOS. Marketing page. */
export const APPS_PATH = "/apps";

/** Device Inbox: the public entry point for "browser → a folder on a machine I
 *  own". A first-class destination alongside the other five (PRD §12), not a
 *  page hidden behind a device card, so it is a real route with a real nav link.
 *  English-only, like /cli and /pricing — see page-meta.ts's CLUSTERED_PATHS for
 *  why a localized alternate that 404s is worse than none. */
export const DEVICE_INBOX_PATH = "/device-inbox";

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

/** Sign-in-link landing page. The emailed link hits GET /api/auth/magic/verify,
 *  which only redirects here — the token is spent by a POST from this page, on a
 *  click. That is what stops a mail gateway's prefetch from burning the link and
 *  collecting the session cookie (see handleMagicVerifyRedirect). Must match
 *  magicLinkPath in server/account/handlers.go. */
export const MAGIC_PATH = "/magic-link";

export { CROSS_PATH };

/** Pure mapping from a location to a route. Safe to unit-test without a DOM. */
export function routeFromLocation(pathname: string, hash: string): Route {
  if (downloadId(pathname)) return "download";
  if (parseCodeParam(hash)) return "cross";
  if (pathname === CROSS_PATH) return "cross";
  if (pathname === OFFLINE_PATH) return "offline";
  if (pathname === ME_PATH) return "me";
  if (pathname === CLI_PATH) return "cli";
  if (pathname === APPS_PATH) return "apps";
  if (pathname === DEVICE_INBOX_PATH) return "device-inbox";
  if (pathname === PRICING_PATH) return "pricing";
  if (pathname === VERIFY_EMAIL_PATH) return "verify-email";
  if (pathname === RESET_PASSWORD_PATH) return "reset-password";
  if (pathname === MAGIC_PATH) return "magic-link";
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
//
// A guard may also answer with a PROMISE, which is what lets the confirmation be
// an in-app dialog instead of window.confirm(). The synchronous shape is kept —
// and kept synchronous end to end — on purpose: making every navigation await
// would defer the route change by a microtask for the overwhelmingly common case
// of no guard at all, for the benefit of the one case that has a question to ask.
type NavVerdict = boolean | Promise<boolean>;
let navGuard: (() => NavVerdict) | null = null;
export function setNavGuard(g: (() => NavVerdict) | null): void {
  navGuard = g;
}

/** Switch tabs without reloading: drop any active code room, rewrite the URL,
 *  and update the route. Clearing the room makes App's effect reconnect the
 *  signaling socket to the room-less (LAN) endpoint, so no page reload is needed. */
export function navigate(r: Route): void {
  if (r === route) return; // already on this tab — don't tear down the room / abort a transfer
  if (!navGuard) return commitNavigation(r);
  const verdict = navGuard();
  if (verdict === false) return; // e.g. user declined the "interrupt transfer?" confirm
  if (verdict === true) return commitNavigation(r);
  // A pending question. Nothing is torn down until it is answered, so a user who
  // cancels keeps the transfer they were asked about.
  //
  // `from` is what makes a late answer safe. An awaited guard means arbitrary
  // time passes between the click and the answer, and a popstate or a second
  // navigation can land in between — at which point this answer is about a
  // question the user has already moved on from, and acting on it would yank
  // them off the page they are now on.
  const from = route;
  void verdict.then((ok) => {
    if (ok && route === from) commitNavigation(r);
  });
}

/** The navigation itself, once nothing stands in its way. */
function commitNavigation(r: Route): void {
  if (r === route) return;
  const pathname =
    r === "cross" ? CROSS_PATH
    : r === "offline" ? OFFLINE_PATH
    : r === "me" ? ME_PATH
    : r === "cli" ? CLI_PATH
    : r === "apps" ? APPS_PATH
    : r === "device-inbox" ? DEVICE_INBOX_PATH
    : r === "pricing" ? PRICING_PATH
    : r === "verify-email" ? VERIFY_EMAIL_PATH
    : r === "reset-password" ? RESET_PASSWORD_PATH
    : r === "magic-link" ? MAGIC_PATH
    : LAN_PATH;
  clearRoom(); // leaving a 2-peer code room rebinds the socket via App's effect
  history.pushState({}, "", pathname);
  route = r;
}
