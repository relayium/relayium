// Which transport owes a peer the files that are ALREADY uploaded — and the one
// state the answer used to skip: "not decided yet".
//
// Authoritative definition: docs/protocol/relayium-pair-room-v1.md §4.3.
//
// A pre-uploaded entry can go exactly two ways. Either the joiner announced
// `preupload/1` and the key handoff names it (frame kind 12), or it did not and
// the entry is returned to the live-link lane so the transfer still happens. The
// second branch is IRREVERSIBLE: `releaseUploaded()` drops the stored ref, and
// with it the only keys that open that ciphertext. The bytes are already spent
// and already billed; the object outlives the transfer, because a joined room has
// no deadline (§2) and no completion is coming for keys nobody was handed.
//
// So the question is not "does this peer announce preupload/1", which is a
// boolean and answers `undefined` as `false`. It is "has this peer told us yet",
// and until it has, NEITHER branch may run:
//
//   keys  the peer announced it. The handoff owns those entries.
//   live  the peer announced without it, or is never going to announce. The
//         live lane owns them, and the release is correct.
//   wait  no announcement yet, and one is still expected. Nobody owns them.
//
// ── why "wait" has to exist at all ──────────────────────────────────────────
//
// The roster and the hello are two different frames, and the roster always wins.
// `onPeers` is one synchronous handler: it sets the peer list and BROADCASTS our
// own capabilities. It learns nothing. The peer's hello is produced by the peer's
// own `onPeers` and has to travel peer → server → us, so it cannot arrive before
// that handler returns, and it cannot arrive before the effect flush the roster
// change schedules. The send gate runs in that flush.
//
// That made the late hello the ORDINARY case on the auto-send path rather than a
// race: a batch that finished uploading before anyone joined was released and
// re-sent over the live link every time, for a peer perfectly able to be handed
// its keys — and the ciphertext it left behind needed a manual release from /me.
//
// ── what settles it ─────────────────────────────────────────────────────────
//
// The announcement, and nothing else. Every implementation that can join a room
// announces at the roster level on join and on roster change — Web since
// `text/1`, the Swift port, the CLI — because relayium-text-v1.md requires it of
// anything that wants a message session. So for a real peer this resolves one
// signalling round trip after the roster names it, on an event, with no clock
// involved.
//
// The window below is the backstop for the one peer that never says anything at
// all, and it exists because silence cannot be distinguished from lateness by any
// other means: no acknowledgement frame exists (§4.4 says why one must not), and
// a peer with no capabilities never opens a link whose establishment could stand
// in for the answer. It is deliberately NOT a new number — it is
// LINK_REQUEST_TIMEOUT_MS, which is already this protocol's answer to "we sent
// this peer a signalling frame and it never replied". Reaching it costs a
// pre-uploaded batch a delayed live fallback; never reaching it would cost the
// batch entirely.

import { LINK_REQUEST_TIMEOUT_MS } from "./peer-link.svelte";
import { peerCapsKnown, peerSupportsPreupload } from "./peer-caps.svelte";
import { liveLinkCount, liveLinkFiles, releaseUploaded, takeOutbox, uploadedCount } from "./outbox.svelte";
import type { PickedFile } from "./drag";

/** Which transport owes this peer the entries that are already uploaded. */
export type HandoffLane = "wait" | "keys" | "live";

/**
 * How long a peer that has said nothing is still expected to.
 *
 * The link request's timeout, reused rather than reinvented: it is the same
 * judgement about the same transport — a signalling frame went to this peer and
 * nothing came back, so stop expecting one. Deriving it keeps the two from
 * drifting into two different opinions about when a silent peer is silent.
 */
export const CAPS_SETTLE_MS = LINK_REQUEST_TIMEOUT_MS;

/** Whether a settle window for this peer is still open, or has closed. Absent
 *  means no window was ever opened — a peer we are not expecting to hear from. */
let windows = $state<Record<string, "open" | "closed">>({});
/**
 * What each peer id announced, remembered past its roster entry.
 *
 * `retainPeers` prunes peer-caps with the roster, and it is right to: routing and
 * the peer cards are about who is IN the room. This is not that question. A
 * peer's socket can drop while its DataChannel keeps carrying files (the reason
 * `linkAuthoritative` exists in peer-workspace), and the roster empties while the
 * link works perfectly — so reading the pruned announcement there would say "this
 * peer never announced" about a peer that announced and is still connected, and
 * spend the handoff on it.
 *
 * Safe to keep because a peer id is never reused inside one room: a reconnecting
 * peer is issued a fresh one by the server, so a memo can go stale only by being
 * about somebody who has gone. Cleared with the room, like everything else here.
 */
let heard = $state<Record<string, boolean>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function closeWindow(peerId: string): void {
  const timer = timers.get(peerId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(peerId);
  }
  if (windows[peerId] !== "closed") windows = { ...windows, [peerId]: "closed" };
}

function openWindow(peerId: string): void {
  windows = { ...windows, [peerId]: "open" };
  timers.set(peerId, setTimeout(() => closeWindow(peerId), CAPS_SETTLE_MS));
}

/**
 * Follow the roster: open a settle window for each peer that just appeared.
 *
 * Called from the same handler that broadcasts our own capabilities, because
 * that is the instant the window is actually about — we have announced to this
 * peer, and a peer that speaks the protocol is announcing back right now.
 *
 * A peer the roster stops naming has its window closed at once rather than left
 * to time out. Nothing more is coming from it, and a peer that never announced
 * can hold no link either (routing needs `link/1`), so there is no working
 * connection whose answer we would be throwing away — only a batch that would
 * otherwise sit waiting for a page that has gone.
 */
export function noteRosterPeers(ids: readonly string[]): void {
  const present = new Set(ids);
  for (const id of Object.keys(windows)) {
    if (!present.has(id) && windows[id] === "open") closeWindow(id);
  }
  for (const id of ids) {
    if (windows[id] === undefined && heard[id] === undefined) openWindow(id);
  }
}

/**
 * A capability hello arrived from this peer: record what it means for the lane
 * and stop expecting one.
 *
 * Takes the answer from `peerSupportsPreupload` rather than from the caller, so
 * the memo and the live predicate can never be two different opinions about the
 * same frame — this is the exact-match gate, read once, at the moment the
 * announcement lands.
 */
export function notePeerCaps(peerId: string): void {
  heard = { ...heard, [peerId]: peerSupportsPreupload(peerId) };
  closeWindow(peerId);
}

/** A new room: its own peers, its own announcements, its own windows. */
export function resetHandoffLanes(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  windows = {};
  heard = {};
}

/**
 * Which transport owes this peer its already-uploaded entries.
 *
 * The live announcement wins over the memo, always: it is the current roster
 * fact, the memo is only what is left when the roster has been pruned out from
 * under a peer that is still connected. A peer with no window at all — never in
 * a roster this page saw, or one whose window has closed — is `live`, which is
 * exactly the behaviour that existed before this module: unknown means the live
 * lane, once there is no longer any reason to expect an announcement.
 */
export function handoffLane(peerId: string): HandoffLane {
  if (peerCapsKnown(peerId)) return peerSupportsPreupload(peerId) ? "keys" : "live";
  const memo = heard[peerId];
  if (memo !== undefined) return memo ? "keys" : "live";
  return windows[peerId] === "open" ? "wait" : "live";
}

/**
 * Whether an already-uploaded entry is the HANDOFF's to deliver rather than the
 * live lane's — the boolean `liveLinkCount`/`liveLinkFiles` take.
 *
 * `wait` answers true, and that is the whole correction: an undecided lane must
 * not be read as "the live link owes this", because the caller acting on that
 * answer releases the keys. It is never read as consent to SEND a kind-12 frame
 * — that gate is `peerSupportsPreupload` and stays exact, so an unknown peer is
 * still never handed a frame kind it cannot parse.
 */
export function peerTakesKeys(peerId: string): boolean {
  return handoffLane(peerId) !== "live";
}

/**
 * How many entries the live link owes THIS peer — the gate in front of every
 * drain, and the peer-specific question it has to be.
 *
 * Two rules, and the second is new:
 *
 *  - the count is peer-specific. Asking the peer-independent staged count is 0
 *    for a batch that finished uploading before anyone joined, so the gate never
 *    opened, the drain was never reached, and the old-peer fallback inside it was
 *    dead code for exactly the case it exists for.
 *  - a batch holding pre-uploaded entries waits for the lane AS A BATCH. Letting
 *    the staged half through while the uploaded half is undecided splits one
 *    user action across two transports and two consent prompts — and worse, the
 *    first half opens a legacy transfer, which makes the peer `busy` for new
 *    intent and leaves the uploaded half with no link to hand keys over and no
 *    control on screen that could reach it.
 *
 * A batch with nothing uploaded is untouched by either rule, which is every LAN
 * queue and every code room before its first finalize: same gate, same number,
 * same instant it always opened.
 */
export function liveLinkFor(peerId: string): number {
  const lane = handoffLane(peerId);
  if (lane === "wait" && uploadedCount() > 0) return 0;
  return liveLinkCount(lane !== "live");
}

/**
 * How many entries are owed to the KEY HANDOFF for this peer — the debt no
 * live-lane count can see.
 *
 * `liveLinkFor` above is 0 for a fully pre-uploaded batch handed to a capable
 * peer, and correctly so: the live lane owes nothing, the handoff owes
 * everything. But that is also the ordinary shape of a code room — stage, mint,
 * finalize, wait — so a sender driven only by the live-lane count has nothing to
 * act on in the ordinary case: no link is built, no frame kind 12 is emitted,
 * and a batch whose ciphertext is already paid for arrives as silence.
 *
 * `wait` answers 0 on purpose. An undecided peer is owed nothing yet, and the
 * two callers of this both act — one builds a link, the other arms a
 * confirmation — so answering early would spend a decision one round trip before
 * the answer exists, which is the mistake the lane above exists to stop.
 *
 * An entry still `uploading` is in neither answer, exactly as in `liveLinkFor`:
 * its bytes are moving and there is no key to hand over yet.
 */
export function handoffOwed(peerId: string): number {
  return handoffLane(peerId) === "keys" ? uploadedCount() : 0;
}

/**
 * Everything this peer is still waiting on, whichever transport will carry it.
 *
 * What a control that says "N files still queued for this peer" has to count,
 * and it is deliberately wider than what `liveLinkFor` above gates: a batch
 * whose entries are all pre-uploaded is not an empty batch, and a control that
 * measured it with the live lane's ruler would report nothing, never render,
 * and leave those files
 * with nothing on screen that could reach them — after a Cancel, inside a
 * unified workspace, there is no peer chooser to go back to.
 *
 * `keysReleased` is whether the handoff for this peer is already authorized to
 * leave. Once it is, those entries are the handoff's problem and are not waiting
 * on any control; until then they are part of what the user is being asked
 * about. For a `live` peer the flag changes nothing — there is no handoff there
 * to release — and for an undecided one this describes nothing at all, because
 * the control must not name files it is not yet allowed to release.
 */
export function pendingFilesFor(peerId: string, keysReleased: boolean): PickedFile[] {
  const lane = handoffLane(peerId);
  if (lane === "wait" && uploadedCount() > 0) return [];
  return liveLinkFiles(lane !== "live" && keysReleased);
}

/** The count behind `pendingFilesFor`, for the gate in front of that control.
 *  One question again: a control that renders on one number and describes
 *  another is a control that can be shown for an empty sentence. */
export function pendingCountFor(peerId: string, keysReleased: boolean): number {
  const lane = handoffLane(peerId);
  if (lane === "wait" && uploadedCount() > 0) return 0;
  return liveLinkCount(lane !== "live" && keysReleased);
}

/**
 * Take the batch the live link is responsible for, for this exact peer.
 *
 * The extra step over `takeOutbox()` is the release, and it now happens on
 * exactly one lane. `live` means this peer has told us it cannot be handed keys
 * (or is never going to tell us anything): its objects are unreachable
 * ciphertext, and left `uploaded` they are drained by neither lane — the user
 * simply never sees the file arrive. Returning them costs the bytes that were
 * already spent and delivers the transfer.
 *
 * `wait` releases NOTHING. That is the correction this module exists for: the
 * release is one-way, so performing it on an undecided lane spends the handoff
 * for a peer that was about to announce it could take one. The gate above keeps
 * this from being reached in that state; the check is repeated here because a
 * gate and the irreversible step behind it should not be able to disagree.
 *
 * The stored object is deliberately not deleted on the `live` path, and nothing
 * reclaims it on a clock: the peer has JOINED, so the room has no deadline of its
 * own. No completion is coming either — the peer that would spend one never
 * learned the keys — so it is held until the sender's own account releases that
 * room (the pairing-transfer storage list on /me) or the account is deleted.
 */
export function drainFor(peerId: string): PickedFile[] {
  if (handoffLane(peerId) === "live") releaseUploaded();
  return takeOutbox();
}
