// Recognising the relayium CLI on the other end of a pairing code.
//
// Pairing codes share ONE namespace with the CLI (`server/internal/signal`
// mints them all), so a code printed by `relayium send` can be typed into this
// page — and the CLI can join a code this page minted. The two transports
// cannot interoperate: the CLI moves bytes over a direct pinned-TLS connection
// and this client over WebRTC. The refusal is correct; what was wrong is that
// every client failed by OMISSION, with copy written for a different cause:
// this page waited forever on `pair.waiting` because a joiner has no mint
// expiry to count down.
//
// The discriminator is a TOP-LEVEL `kind` string, and that choice is
// load-bearing, so the reasoning is written down rather than left to be
// re-derived:
//
//   - The CLI's handshake frames are `{"kind":"commit",…}` and
//     `{"kind":"reveal",…}` (`server/internal/rzvous/handshake.go`, `hsMsg`).
//   - No app or web peer ever emits a top-level `kind`. Verified against every
//     emitter, not assumed: `InboundSignal` (webrtc-core.ts) declares no such
//     field, and the other payloads are `{caps}`, `{relayRtt}`, `{rename}`,
//     `{link,leave,auth}`, `{linkRequest,link}`, `{busy,link}`,
//     `{link,renew,auth}` and `{link,reveal}`. The one `kind:` literal in this
//     codebase — `linkLeavePayload` — builds a string that is SIGNED, never a
//     signal envelope, and its own comment says the field exists precisely to
//     keep it unreachable from `authPayload`.
//   - `commit` alone would NOT work as the discriminator. It is a real field on
//     `InboundSignal` (the base64 commitment riding the offer/answer), which is
//     exactly how RelayiumKit's shape-permissive `peerCommit(from:)` came to
//     accept a CLI frame as an app commit.
//
// The verdict is LATCHED against the room it was seen in, never derived from
// the live roster: the CLI exits on this page's capability hello about 0.2 s
// after joining, so by the time anything renders, the roster is empty again and
// a roster-derived answer would be "nobody is here".

/** The room code a CLI peer was seen in ("" = none). Latched, not live. */
let seenInRoom = $state("");

/**
 * Whether this signal payload came from the relayium CLI's handshake.
 *
 * Pure and exported on its own so the other clients' ports and the tests can
 * exercise the discriminator without a room, a socket or a latch.
 */
export function isCliHandshakeSignal(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  return typeof (data as { kind?: unknown }).kind === "string";
}

/**
 * Record a CLI peer if this is one of its frames. Returns whether it latched,
 * so a caller can stop processing a frame nothing else will understand.
 *
 * `room` is passed rather than read from the room store so that the latch is
 * keyed by the room it belongs to: entering another code reads back false
 * without any reset wiring, and a stale verdict cannot outlive its room.
 */
export function noteCliPeer(data: unknown, room: string): boolean {
  if (!room || !isCliHandshakeSignal(data)) return false;
  seenInRoom = room;
  return true;
}

/** Reactive read: was a CLI peer seen in THIS room? */
export function cliPeerInRoom(room: string): boolean {
  return room !== "" && seenInRoom === room;
}

/** Test seam only — production code keys the latch by room instead of resetting. */
export function resetCliPeer(): void {
  seenInRoom = "";
}
