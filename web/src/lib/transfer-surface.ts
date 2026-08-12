// web/src/lib/transfer-surface.ts — which transfer destination may draw the
// shared transfer surface, and which of its parts a destination is allowed to
// contain.
//
// **LAN Transfer and Cross-network Transfer are sibling products.** They share
// every underlying model — one signalling client, one peer workspace, one
// staged outbox, one set of in-flight transfers — and they do NOT share a
// screen. `/` answers "who is on this network?"; `/cross-network` answers "what
// is the code?". Neither may answer the other's question, because the whole
// reason a person picks one is that the other's precondition does not hold.
//
// The defect this file exists to prevent: the surface used to appear on
// `/cross-network` the moment a LAN peer became visible, because the condition
// was route-agnostic. A person who opened the cross-network page while another
// browser window sat on the same Wi-Fi was shown that window's device card, its
// name, and — with no peer left — the "open this page on another device on the
// same network" prompt. All three are LAN discovery, on the destination whose
// entire premise is that no shared network exists.
//
// So the rule is stated once, here, as data in / boolean out, rather than as a
// condition inside a 2,500-line component where the route term is easy to drop
// again. The macOS app states the same boundary in
// `TransferSurfacePresentation`; this is the Web half of it.

import type { Route } from "./router.svelte";

export type TransferSurfaceState = {
  route: Route;
  /** The pairing code this page is bound to; "" when there is no room. */
  roomCode: string;
  /**
   * A transfer this page must not lose — `workspace.warnsOnLeave`, plus the
   * stored-receive lane, which is a transfer that does not look like one:
   * a manifest fetch, an unanswered consent prompt and a download whose only
   * keys live in this tab's memory.
   */
  busy: boolean;
  /** A pre-uploaded batch that no longer needs the peer to finish. */
  storedReceiveActive: boolean;
  /** How many other devices the signalling socket is currently offering. */
  visiblePeers: number;
};

/**
 * Whether the shared transfer surface may be drawn on this route.
 *
 * On `/cross-network` the answer is gated on the pairing room, and that is the
 * whole boundary: with a room, the roster IS the room (the signalling socket is
 * bound to the code and the server caps a room at two participants), so every
 * peer it can offer arrived through the code. Without one, the socket is on the
 * room-less LAN endpoint and every peer it can offer is a LAN neighbour — which
 * this destination must not show, however busy this tab happens to be.
 *
 * A LAN transfer that is in flight when the user switches destinations keeps
 * running and keeps its ownership; it simply stays on the destination that owns
 * it, exactly as a live session stays on its own row on macOS. `/` shows it
 * again on the way back.
 */
export function showsTransferSurface(s: TransferSurfaceState): boolean {
  if (s.route === "cross" && !s.roomCode) return false;
  return s.busy || s.storedReceiveActive || s.visiblePeers > 0;
}

/**
 * Whether the device-roster section may be drawn at all.
 *
 * On LAN it always may: with nobody around, its empty state is the product's
 * answer ("no other devices yet — open this page on another device on the same
 * network"), and the scanning signal lives inside it.
 *
 * On cross-network that same empty state is a lie about a network this
 * destination does not use, so the section exists only while there is a peer to
 * put in it — the one participant the code let in. An emptied roster there is
 * not "look for more devices", it is a peer that left, and the workspace header
 * and activity blocks above already report exactly that.
 */
export function showsPeerRoster(route: Route, visiblePeers: number): boolean {
  return route === "lan" || visiblePeers > 0;
}
