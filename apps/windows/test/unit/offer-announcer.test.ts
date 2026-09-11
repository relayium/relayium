// Announcing an offer once, and announcing the NEXT one.
//
// Extracted from the effect that calls it because the effect cannot be tested
// and this can. Both halves fail in the same direction if they are wrong —
// announcing too often — and a notification is shown on a lock screen, so that
// direction is the expensive one.

import { describe, expect, it } from "vitest";
import { OfferAnnouncer } from "../../src/renderer/receive/offer-announcer.js";

const room = () => ({});
const offer = (label: string) => ({ label });

describe("one announcement per offer", () => {
  it("announces an offer that has just appeared", () => {
    const a = new OfferAnnouncer<object, object>();
    expect(a.shouldAnnounce(room(), offer("a"))).toBe(true);
  });

  it("does NOT announce the same offer again", () => {
    // The effect this serves runs on every revision, so without this a single
    // offer would notify on every render for as long as it sat unanswered.
    const a = new OfferAnnouncer<object, object>();
    const r = room();
    const held = offer("a");
    expect(a.shouldAnnounce(r, held)).toBe(true);
    expect(a.shouldAnnounce(r, held)).toBe(false);
    expect(a.shouldAnnounce(r, held)).toBe(false);
  });

  it("announces a SECOND offer in the same room", () => {
    // The first was declined, or another arrived. A boolean set once would
    // swallow this, which is the failure that looks like nothing is wrong.
    const a = new OfferAnnouncer<object, object>();
    const r = room();
    expect(a.shouldAnnounce(r, offer("first"))).toBe(true);
    expect(a.shouldAnnounce(r, offer("second"))).toBe(true);
  });

  it("announces the same offer again only after it has gone", () => {
    const a = new OfferAnnouncer<object, object>();
    const r = room();
    const held = offer("a");
    expect(a.shouldAnnounce(r, held)).toBe(true);
    expect(a.shouldAnnounce(r, null)).toBe(false);
    // Cleared by its absence, so a room that offers again is heard.
    expect(a.shouldAnnounce(r, held)).toBe(true);
  });

  it("says nothing when there is no offer", () => {
    const a = new OfferAnnouncer<object, object>();
    expect(a.shouldAnnounce(room(), null)).toBe(false);
    expect(a.shouldAnnounce(room(), undefined)).toBe(false);
  });

  it("keeps rooms apart", () => {
    // Two rooms run at once — same-network and pairing — and an offer in one
    // must not silence the other.
    const a = new OfferAnnouncer<object, object>();
    const lan = room();
    const pair = room();
    const same = offer("a");
    expect(a.shouldAnnounce(lan, same)).toBe(true);
    expect(a.shouldAnnounce(pair, same)).toBe(true);
    expect(a.shouldAnnounce(lan, same)).toBe(false);
  });
});
