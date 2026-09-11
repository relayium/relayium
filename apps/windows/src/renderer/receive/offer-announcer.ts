// Whether an offer that is on screen has already been announced.
//
// Extracted from the effect that raises it because the effect cannot be tested
// and this can. The rule has two halves and both are easy to get wrong in the
// same direction — announcing too often — which on a lock screen is worse than
// a feature that does nothing.

/**
 * One announcement per OFFER, not per render and not per room.
 *
 * Keyed by the offer object itself rather than by a flag, so:
 *
 *  * a re-render of the same offer announces nothing, and an effect that runs
 *    on every revision is therefore safe to call this from;
 *  * a SECOND offer — the first declined, another arriving, or a new peer — is
 *    its own event and is announced, which a boolean set once would have
 *    swallowed.
 *
 * The room is held weakly: a controller that is thrown away takes its entry
 * with it rather than pinning it here for the life of the page.
 */
export class OfferAnnouncer<Room extends object, Offer extends object> {
  readonly #announced = new WeakMap<Room, Offer>();

  /**
   * Whether THIS offer should be announced now.
   *
   * Answering true records it, so a caller that asks twice for one offer gets
   * one announcement. `null` means there is no offer, which clears the room so
   * the next one is announceable.
   */
  shouldAnnounce(room: Room, offer: Offer | null | undefined): boolean {
    if (!offer) {
      this.#announced.delete(room);
      return false;
    }
    if (this.#announced.get(room) === offer) return false;
    this.#announced.set(room, offer);
    return true;
  }
}
