// Reactive cross-network "room" the page is currently in, driven by the URL
// fragment (#c=<code>). Entering a room updates both this state and the URL
// *without a page reload*; App reacts and rebinds the signaling socket.

import { parseCodeParam, CROSS_PATH } from "./transfer-link";

let code = $state("");

/** Reactive read of the active 6-digit pairing code ("" when none). */
export function roomCode(): string { return code; }

/** Seed the room from the current URL fragment (call once on load + on popstate). */
export function initRoomFromLocation(): void {
  code = parseCodeParam(location.hash);
}

/** Enter (or leave, with {}) a room: rewrite the URL fragment and update state.
 *  Uses replaceState so a plain tab switch elsewhere still drops the room, and
 *  never reloads — App's effect reconnects the socket. */
export function enterRoom(next: { code?: string }): void {
  const c = next.code ?? "";
  history.replaceState({}, "", `${CROSS_PATH}${c ? `#c=${c}` : ""}`);
  code = c;
}

/** Drop any active room without touching the URL — the caller owns navigation
 *  (used by the tab router, which sets its own pathname). */
export function clearRoom(): void { code = ""; }
