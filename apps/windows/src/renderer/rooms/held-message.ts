/**
 * What becomes of a message the user sent before the lane was open.
 *
 * Pressing Send with no conversation yet is the ASK: the lane is opened and the
 * body is held until it can go. Three things can then happen to it, and each is
 * a different promise to the person who pressed the button — delivered, or
 * given back with the send marked failed, or given back quietly because the
 * intent behind it no longer holds.
 *
 * ## Why this is not in the effect
 *
 * It was, and nothing could reach it: `grep -rn "awaitingLane|intentHolds|
 * LANE_TERMINAL" test/` returned nothing. The effect's own comment records a
 * defect it has already produced — "One click, two messages, observed on the
 * peer" — from re-entering while the held message was still marked waiting.
 * The guard against that is `sending` being set synchronously before the first
 * await, which is subtle, load-bearing, and was asserted by nothing.
 *
 * The same extraction on the notification decisions found a defect that had
 * shipped, on the first run of the first test.
 */

import type { TextStatus } from "../../../../../web/src/lib/text-model";

/**
 * Every text status, classified as ending the wait or not.
 *
 * A total map rather than the `readonly string[]` this replaces. That array
 * happened to list all five terminal members, and being typed `string[]` meant
 * nothing checked it: an eleventh status would have been treated as
 * non-terminal, and a held message in it would hang — box empty, nothing
 * delivered, no failure reported.
 */
const TERMINAL = {
  idle: false,
  connecting: false,
  waitingAccept: false,
  incomingRequest: false,
  open: false,
  ended: true,
  failed: true,
  refused: true,
  unsupported: true,
  peerBusy: true,
} as const satisfies Record<TextStatus, boolean>;

export type HeldMessageOutcome =
  /** Send it now. */
  | "deliver"
  /** Nothing to decide yet — the lane is still on its way. */
  | "wait"
  /** Give the body back, and say the send failed. */
  | "failed"
  /**
   * Give the body back without calling it a failure.
   *
   * The intent behind the message stopped holding: a quit fenced the page,
   * verification was switched on, the peer changed, or the link was replaced.
   * The lane opening afterwards is the PEER acting, not the user asking again,
   * and delivering here would send into a conversation the user never chose.
   */
  | "abandon";

export interface HeldMessageState {
  readonly status: TextStatus;
  /** Whether the intent captured at Send still holds. */
  readonly intentHolds: boolean;
  /** A send already in flight. The re-entrancy guard. */
  readonly sending: boolean;
}

export function heldMessageOutcome(state: HeldMessageState): HeldMessageOutcome {
  // Checked FIRST, and before the status: an abandoned intent is abandoned
  // whatever the lane went on to do, and a lane that opened for the peer must
  // not deliver a body the user no longer means to send.
  if (!state.intentHolds) return "abandon";
  if (state.status === "open") {
    // "One click, two messages, observed on the peer." The effect that owns
    // this re-enters while a delivery is in flight, because sending writes the
    // transcript the effect reads.
    return state.sending ? "wait" : "deliver";
  }
  return TERMINAL[state.status] ? "failed" : "wait";
}
