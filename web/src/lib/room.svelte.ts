// Reactive cross-network "room" the page is currently in, driven by the URL
// fragment (#t=<token> for a share link, #c=<code> for a pairing code). Entering
// a room updates both this state and the URL *without a page reload*; App reacts
// to the change and rebinds the signaling socket to the new room.

import { parseTransferToken, parseCodeParam, CROSS_PATH } from "./transfer-link";

let token = $state("");
let code = $state("");

/** Reactive read of the active share-link token ("" when none). */
export function roomToken(): string { return token; }
/** Reactive read of the active 6-digit pairing code ("" when none). */
export function roomCode(): string { return code; }

/** Seed the room from the current URL fragment (call once on load + on popstate). */
export function initRoomFromLocation(): void {
  token = parseTransferToken(location.hash);
  code = parseCodeParam(location.hash);
}

/** Enter (or leave, with {}) a room: rewrite the URL fragment and update state.
 *  Uses replaceState so a plain tab switch elsewhere still drops the room, and
 *  never reloads — App's effect reconnects the socket. */
export function enterRoom(next: { token?: string; code?: string }): void {
  const t = next.token ?? "";
  const c = next.code ?? "";
  const hash = t ? `#t=${t}` : c ? `#c=${c}` : "";
  history.replaceState({}, "", `${CROSS_PATH}${hash}`);
  token = t;
  code = c;
}

/** Drop any active room without touching the URL — the caller owns navigation
 *  (used by the tab router, which sets its own pathname). App reconnects the
 *  socket to the room-less (LAN) endpoint via its effect. */
export function clearRoom(): void {
  token = "";
  code = "";
}
