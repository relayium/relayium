// Whether the pre-upload key handoff may leave this device for a given peer.
//
// Authoritative definition: docs/protocol/relayium-pair-room-v1.md §4.5.
//
// The handoff is a PULL: the file lane asks for the current stored key set on
// every (re)established transport and again whenever a new object appears
// (mixed-file-session's `emitStoredKeys`). That is the right shape for the
// protocol's "re-send the WHOLE current set" rule, and it is also the only place
// a sender-side decision can be enforced — every other path to the wire is a
// consequence of a link existing, and a link exists as soon as the workspace is
// opened.
//
// Which is precisely the hole. In a code room with advanced verification on, the
// batch is held behind a sender confirmation because the joiner might be someone
// who guessed a live code, and the whole stated remedy is "compare the
// verification code before you send". The code only appears once a link is up —
// so OPENING the workspace is what puts it on screen. An emission that rides
// attachment therefore hands the keys over one authenticated link before the
// person is asked anything, and a guesser can fetch and open every finalized
// object while the sender is still reading the prompt. Unlike a live batch there
// is no second stop behind it: the receiver's accept step gates bytes landing on
// a disk, and these bytes are already on a server that will serve them to whoever
// holds the key.
//
// So the pull is gated on an authorization, and the authorization is a statement
// about a WORLD rather than a flag: this peer, in this room, on this link, under
// this preference. Anything that changes underneath it stops matching and the
// gate fails closed — a different target, a reconnect (the server renames the
// peer), a new authentication step with a new SAS, a room switch, the link
// ending, the preference changing. That is deliberately not "the button is
// hidden": the emission does not go through the button, and neither does an
// inbound link the peer builds itself.
//
// A LAN room, and a code room with the preference off, have no such stop and
// never did — see verify-gates for why a confirmation with no code on screen is
// worse than none. `handoffAllowed` says so in one line, so no caller has to.

import { needsSendConfirmation } from "./verify-gates";

/**
 * The world an emission would happen in, as the sender sees it right now.
 *
 * Every field is something a person could have checked, or something whose
 * change means they checked a different thing. `linkGeneration` is the identity
 * of the authenticated link — it advances on establishment and teardown but NOT
 * on a transport replacement, which is exactly the distinction wanted: a rebuilt
 * transport carries the same keys and the same compared SAS, a new link does not.
 */
export interface HandoffContext {
  /** The peer the frame would be addressed to. */
  peerId: string;
  /** The code room this page is in, or "" for none. */
  roomCode: string;
  /** The live link's identity, or -1 when there is no live link. Never a stale
   *  number from an ended one: an ended link has no code on screen. */
  linkGeneration: number;
  /** The advanced-verification preference, as it is right now. */
  verifyOn: boolean;
}

/**
 * The one authorization this page holds, or null.
 *
 * One, not a set: the confirmation is about a link, and there is at most one
 * unified link at a time. `$state.raw` because it is replaced rather than
 * mutated and is read during render — the send gate closes on it (or the bar it
 * armed comes straight back) and the release control reappears on it (or a fully
 * pre-uploaded batch is left with nothing on screen that can reach it).
 */
let grant = $state.raw<HandoffContext | null>(null);

/**
 * Record the user's confirmed Send for exactly this world.
 *
 * Refuses a context that could not have been compared: no peer, or no live link
 * and therefore no SAS. The confirmation bar can be armed before any link exists
 * — a preselected batch (the OS share sheet, or files picked before the code was
 * minted) arms it the instant one peer joins — and `canReleaseConfirmedSend`
 * already refuses to release there. This refuses to REMEMBER it, so a link that
 * comes up later cannot inherit a decision made against nothing.
 */
export function authorizeHandoff(ctx: HandoffContext): void {
  if (ctx.peerId === "" || ctx.linkGeneration < 0) return;
  grant = { ...ctx };
}

/** Forget it. The room switch and the explicit Disconnect call this; so does
 *  anything else that ends the thing the user was looking at. Belt and braces —
 *  the context comparison below already fails closed on both. */
export function revokeHandoff(): void {
  grant = null;
}

/**
 * Whether the stored key set may be handed to this peer right now.
 *
 * Read at the LATE boundary (the pull inside the send chain, at seal time),
 * never cached by the caller: an authorization can be withdrawn while a frame is
 * sealing, and the frame that lands on the wire is the one that has to be
 * allowed — not the one that was scheduled.
 */
export function handoffAllowed(ctx: HandoffContext): boolean {
  // No stop in force: LAN, or a code room with advanced verification off. There
  // is no code on screen to compare, so there is nothing being bypassed.
  if (!needsSendConfirmation(ctx.verifyOn, ctx.roomCode)) return true;
  const g = grant;
  if (!g) return false;
  if (ctx.peerId === "" || ctx.linkGeneration < 0) return false;
  return g.peerId === ctx.peerId
    && g.roomCode === ctx.roomCode
    && g.linkGeneration === ctx.linkGeneration
    && g.verifyOn === ctx.verifyOn;
}
