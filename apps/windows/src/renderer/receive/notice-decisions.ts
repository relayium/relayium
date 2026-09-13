/**
 * Which resident notices a room's current state produces.
 *
 * ## Why this is not in the effect
 *
 * `OfferAnnouncer` already made this argument and stopped one step short. Its
 * header says: "Extracted from the effect that raises it because the effect
 * cannot be tested and this can." What stayed behind was four decisions, and
 * none of them was reachable by any suite:
 *
 *  * which inbound message id is new, and whether a replayed transcript counts;
 *  * whether a verification code is waiting, announced once per room;
 *  * that a file offer uses one announcer;
 *  * that a message request uses a DIFFERENT one, keyed by link generation.
 *
 * The last one's mistake shipped invisibly: a single shared announcer was
 * injected deliberately and no suite noticed, because nothing drove the effect.
 *
 * ## It returns notices; it does not send them
 *
 * A function that called the bridge would need the bridge injected, which is
 * exactly the machinery this avoids. The caller stays an effect, keeps reading
 * reactive state, and does the sending.
 */

import type { ResidentNotice } from "../../shared/ipc-contract.js";
import type { OfferAnnouncer } from "./offer-announcer.js";

/** Everything about one room that decides a notice. Nothing reactive. */
export interface NoticeRoomState {
  /** Inbound message ids, newest anywhere in the list. */
  readonly inboundIds: readonly number[];
  /** The verification code, or "" when there is none to compare. */
  readonly sasCode: string;
  readonly verificationConfirmed: boolean;
  /** The file offer object, whose IDENTITY is what makes it one offer. */
  readonly incoming: object | null;
  /** True while a conversation request is waiting for an answer. */
  readonly textRequested: boolean;
  /** Changes per link, so a second request after a decline is announceable. */
  readonly linkGeneration: number;
}

/**
 * The memory a decision needs between calls.
 *
 * A file offer uses `OfferAnnouncer`, which keys by the offer OBJECT's
 * identity — correct there, because the workspace hands out one object per
 * offer and holds on to it.
 *
 * A message request does NOT, and that is a correction this extraction earned
 * on its first test run. The request was given its own announcer and a
 * `{ generation }` token, and the token was rebuilt on every pass — so identity
 * never matched and the request re-announced on EVERY effect run for as long as
 * it was outstanding. The effect runs on every revision. Nothing caught it
 * because the decision lived inside the effect.
 *
 * So the request is remembered by the GENERATION, which is a number and
 * compares by value. The same shape as `seenInbound` beside it.
 */
export interface NoticeMemory<Room extends object> {
  readonly seenInbound: Map<Room, number>;
  readonly announcedSas: Set<Room>;
  readonly offers: OfferAnnouncer<Room, object>;
  /** The link generation whose message request was announced, per room. */
  readonly announcedTextRequest: Map<Room, number>;
}

export function noticesFor<Room extends object>(
  room: Room,
  state: NoticeRoomState,
  memory: NoticeMemory<Room>,
): readonly ResidentNotice[] {
  const notices: ResidentNotice[] = [];

  const latest = state.inboundIds.reduce((id, next) => Math.max(id, next), 0);
  const previous = memory.seenInbound.get(room) ?? 0;
  if (latest > previous) {
    memory.seenInbound.set(room, latest);
    // Only for messages that arrived after this page started watching, so a
    // reconnect that replays a transcript does not re-announce it.
    if (previous > 0 || state.inboundIds.includes(latest)) notices.push("saved-message");
  }

  // A code waiting to be compared is the one thing that genuinely needs the
  // user, which is what `attention` is for. Once per room.
  const waiting = state.sasCode !== "" && !state.verificationConfirmed;
  if (waiting && !memory.announcedSas.has(room)) {
    memory.announcedSas.add(room);
    notices.push("attention");
  }
  if (!waiting) memory.announcedSas.delete(room);

  // An offer nobody has answered yet. Its own announcer.
  if (memory.offers.shouldAnnounce(room, state.incoming)) notices.push("incoming");

  // A conversation nobody has answered yet.
  //
  // By GENERATION, which compares by value. A `{ generation }` object compared
  // by identity is a fresh object on every pass and therefore always "new" —
  // the defect this extraction found. The generation still does what the token
  // was for: a second conversation after the first was declined belongs to a
  // later link and is announceable, while the same one is not.
  if (state.textRequested) {
    if (memory.announcedTextRequest.get(room) !== state.linkGeneration) {
      memory.announcedTextRequest.set(room, state.linkGeneration);
      notices.push("incoming-text");
    }
  } else {
    memory.announcedTextRequest.delete(room);
  }

  return notices;
}
