// Whether an interrupted unified link may be rebuilt at all, and for how long.
//
// The mechanism lives in peer-link (hold the link, re-offer an authenticated
// transport inside a bounded window); the mechanism has no opinion about
// whether rebuilding is even possible. Two things can make it impossible while
// the link still looks holdable:
//
//   1. **Signaling.** A rebuild is an authenticated offer sent THROUGH the
//      signalling socket, addressed by peer id. With the socket down there is
//      nothing to send it over; after a rejoin the server issues a fresh id, so
//      the peer this link points at is not addressable any more and our own
//      identity is not the one the peer would answer. A room that refuses or
//      expires the rejoin is the same answer, arrived at faster. So is the
//      symmetric case: the server confirmed that the REMOTE peer's socket is
//      gone, which leaves its id just as unaddressable even though our own
//      socket is perfectly fine.
//   2. **The relay credential.** A relayed link's TURN credential expires (see
//      relay-deadline). Re-offering with it allocates nothing; the window would
//      be spent presenting stale credentials as a recovery in progress.
//
// Losing signaling ALONE never touches a healthy DataChannel here. This is only
// consulted when the transport has actually died, or to tell the user that if it
// does die it cannot be brought back. That separation is the point: an
// in-flight transfer over a live data channel must not be aborted because the
// rendezvous socket blinked.

import { LINK_RECOVERY_WINDOW_MS } from "./peer-link.svelte";

/** "" means recovery is allowed. Anything else names why it is not, and is what
 *  the terminal state says to the user — "reconnect" and "re-pair" are different
 *  instructions and must not be collapsed into one. */
export type RecoveryBlock = "" | "signaling" | "credential";

export interface RecoveryState {
  /** Whether the signalling socket currently holds a room membership. */
  joined: boolean;
  /** The identity that membership was issued under, or "" while there is none. */
  selfId: string;
  /** The identity this link was established under. A rejoin that returns a
   *  different one is a different membership, not a restored one. */
  establishedSelfId: string;
  /** The room refused the rejoin, or the code expired. Terminal by itself. */
  rejoinRefused: boolean;
  /** Whether the peer this link points at is still in the room, as the SERVER
   *  reports it — a `left` frame, never the debounced roster. A roster that
   *  stops naming a peer id is a representative handoff and says nothing about
   *  its socket; a `left` frame is the socket. */
  peerPresent: boolean;
  /** The relayed link's credential boundary, or null when nothing bounds it
   *  (LAN, P2P, or a code room whose ICE config carried no TURN username). */
  credentialDeadlineAt: number | null;
  now: number;
}

export function recoveryBlock(s: RecoveryState): RecoveryBlock {
  // Credential first when both are gone: it is the stronger statement. Telling
  // someone to wait for the connection to come back, when the relay it needs has
  // expired regardless, sends them to wait for something that cannot happen.
  if (s.credentialDeadlineAt !== null && s.now >= s.credentialDeadlineAt) return "credential";
  if (!s.joined || s.selfId === "" || s.selfId !== s.establishedSelfId) return "signaling";
  if (s.rejoinRefused) return "signaling";
  if (!s.peerPresent) return "signaling";
  return "";
}

/**
 * How long the rebuild driver may keep trying.
 *
 * The existing 90-second window is unchanged wherever there is no credential
 * boundary — LAN, P2P, and a code room the server issued no TURN username for.
 * With one, the window is clipped to it, so the driver can never still be
 * re-offering after the credential it would offer under has died. Zero means "do
 * not start": there is no such thing as a stale-credential recovery attempt.
 */
export function recoveryWindowMs(credentialDeadlineAt: number | null, now: number): number {
  if (credentialDeadlineAt === null) return LINK_RECOVERY_WINDOW_MS;
  return Math.max(0, Math.min(LINK_RECOVERY_WINDOW_MS, credentialDeadlineAt - now));
}
