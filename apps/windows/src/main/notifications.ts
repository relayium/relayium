// What a notification is allowed to say.
//
// Mirrors the invariant the macOS app states at `InboxCopy.swift`: the whole
// type is counts and closed codes. There is no branch here that can reach a file
// name, a path, an account email, a device id, a task id, a bearer or key
// material — because the input type carries none of them.
//
// That is the point of `NotificationEvent`'s cases carrying, between them, one
// count and nothing else. `savedMessage` has no associated value at all, so a
// preview is not merely omitted: it is unrepresentable.
//
// Neither half interpolates. Every arm returns a catalog lookup, so there is no
// template literal anywhere in this module for a value to enter through —
// asserted as text by the owning test, the way `InboxSurfaceGuardTests` does.
//
// A Windows toast additionally needs an AUMID on a registered shortcut. That is
// an installer question and is not settled; this module decides only what may be
// said, never whether it can be delivered.

import type { MessageKey, Translate } from "./l10n.js";

export type NotificationEvent =
  /** Files landed. The count is a fact that costs a passer-by nothing. */
  | { readonly kind: "saved"; readonly files: number }
  /**
   * A message landed. No count, no sender, no length, no first words — a
   * message has no fact that is safe on a locked screen, so this case spends
   * itself on where to read it instead.
   */
  | { readonly kind: "saved-message" }
  | { readonly kind: "attention" }
  | { readonly kind: "failed" }
  /**
   * An upload finished and its link is ready.
   *
   * Carries nothing. The link itself is the secret — its fragment holds the
   * key — and a notification is shown on a lock screen, read by whoever is
   * standing there and retained by the system after it is dismissed. This says
   * that there is something to collect and where, and nothing about what.
   */
  | { readonly kind: "link-ready" }
  /**
   * Somebody is offering to send files, and nobody has answered yet.
   *
   * No peer, no names, no count. The offer card carries all of that behind the
   * window; this exists for the person who cannot see it, and a lock screen is
   * not where any of it belongs.
   */
  | { readonly kind: "incoming" }
  /**
   * Somebody started a MESSAGE session, and nobody has answered yet.
   *
   * Its own kind rather than a second use of `incoming`, because that one says
   * files. The reason it exists is the reason `incoming` exists, written on
   * that one: nothing was clicked to start it, the window may not be in front
   * of anybody, and the sender waits at `waitingAccept` until it is answered.
   *
   * Carries nothing about the peer or the message, for the same reason.
   */
  | { readonly kind: "incoming-text" };

export interface NotificationContent {
  readonly title: string;
  readonly body: string;
}

const TITLE: Readonly<Record<NotificationEvent["kind"], MessageKey>> = {
  saved: "resident.notify.savedTitle",
  "saved-message": "resident.notify.messageSavedTitle",
  attention: "resident.notify.attentionTitle",
  failed: "resident.notify.failedTitle",
  "link-ready": "resident.notify.linkReadyTitle",
  incoming: "resident.notify.incomingTitle",
  "incoming-text": "resident.notify.incomingTextTitle",
};

const BODY: Readonly<Record<NotificationEvent["kind"], MessageKey>> = {
  saved: "resident.notify.savedBody",
  "saved-message": "resident.notify.messageSavedBody",
  attention: "resident.notify.attentionBody",
  failed: "resident.notify.failedBody",
  "link-ready": "resident.notify.linkReadyBody",
  incoming: "resident.notify.incomingBody",
  "incoming-text": "resident.notify.incomingTextBody",
};

/**
 * Render an event.
 *
 * `event.files` is deliberately NOT read. A count would be safe to show, but
 * showing it here would mean this function formats a number into a string, and
 * that is the seam every leak starts as. When a count is wanted it will arrive
 * as its own catalog key set, not as interpolation.
 */
export function present(event: NotificationEvent, t: Translate): NotificationContent {
  return { title: t(TITLE[event.kind]), body: t(BODY[event.kind]) };
}
