import { describe, it, expect } from "vitest";
import { canReleaseConfirmedSend, queuedReleaseTarget, shouldConfirmBeforeSend } from "./confirm-send";

describe("shouldConfirmBeforeSend", () => {
  it("requires confirmation in a code room (cross-network)", () => {
    expect(shouldConfirmBeforeSend("123456")).toBe(true);
  });
  it("does NOT require confirmation on LAN (no code)", () => {
    expect(shouldConfirmBeforeSend(null)).toBe(false);
    expect(shouldConfirmBeforeSend("")).toBe(false);
    expect(shouldConfirmBeforeSend(undefined)).toBe(false);
  });
});

// The stop the bar exists to be. `shouldConfirmBeforeSend` decides that one is
// needed; this decides whether the user has yet been given the thing they are
// being asked to check.
describe("canReleaseConfirmedSend", () => {
  const linked = {
    confirmed: true,
    unified: true,
    targetPeerId: "peer-1",
    linkPeerId: "peer-1",
    shownSas: "483920",
  };

  it("releases a unified batch once the workspace is displaying that link's code", () => {
    expect(canReleaseConfirmedSend(linked)).toBe(true);
  });

  it.each([
    ["no link has been built yet", { linkPeerId: "", shownSas: "" }],
    ["the link exists but its code is not on screen", { shownSas: "" }],
    ["the live link belongs to a different peer", { linkPeerId: "peer-2" }],
  ])("fails closed while %s", (_label, over) => {
    // A queued batch reaching a unified peer before its SAS exists is the whole
    // hole: with advanced verification on in a code room, the confirmation is
    // "compare the code" — and a Send that works before there IS a code turns
    // the stop into a click-through against a possible code-guesser.
    expect(canReleaseConfirmedSend({ ...linked, ...over })).toBe(false);
  });

  it("leaves the legacy path exactly as it was", () => {
    // A peer that does not speak link/1 has no workspace and no pre-connection
    // code: its SAS appears on the transfer card once the legacy connection is
    // up, which is unchanged behaviour and not this gate's business.
    expect(canReleaseConfirmedSend({ ...linked, unified: false, linkPeerId: "", shownSas: "" }))
      .toBe(true);
  });

  it("never holds a batch that was not behind the confirmation in the first place", () => {
    // LAN, or verification off: there is no bar, so there is nothing to bypass —
    // and a gate that answered "no" here would strand a queue with no control on
    // screen that could ever release it.
    expect(canReleaseConfirmedSend({ ...linked, confirmed: false, linkPeerId: "", shownSas: "" }))
      .toBe(true);
  });
});

// The standing release control inside the workspace. Its whole reason to exist
// is that Cancel must not be a way to lose files: inside a unified workspace the
// peer chooser is gone, so the bar is the only thing that can still reach the
// queue, and dismissing it removed the last one.
describe("queuedReleaseTarget", () => {
  const live = { linkPeerId: "peer-1", queued: 2, blocked: false };

  it("names the live link's peer when there is something to release", () => {
    expect(queuedReleaseTarget(live)).toBe("peer-1");
  });

  it.each([
    ["there is no live link", { linkPeerId: "" }],
    ["nothing is queued", { queued: 0 }],
    ["new outbound intent to that peer is refused", { blocked: true }],
  ])("renders nothing while %s", (_label, over) => {
    // ONE answer for the control's visibility and for its handler. Before this
    // they read different sources — the button appeared for any live link while
    // the handler looked the peer up in the ROSTER — so a peer whose signalling
    // went away left a button on screen that did nothing at all when clicked.
    expect(queuedReleaseTarget({ ...live, ...over })).toBe("");
  });

  // The target is resolved from the link, so a roster that no longer names the
  // peer changes nothing here: that is the correlated-loss case this closes.
  it("does not depend on the peer still being in the roster", () => {
    expect(queuedReleaseTarget({ linkPeerId: "gone-from-roster", queued: 1, blocked: false }))
      .toBe("gone-from-roster");
  });

  // …and re-arming is exactly "the target is still there", so an armed
  // confirmation for that peer is not stale even with an empty roster, while one
  // for anybody else is.
  it("is the same value an armed confirmation is kept alive by", () => {
    const target = queuedReleaseTarget(live);
    expect(target === "peer-1").toBe(true);
    expect(target === "peer-2").toBe(false);
    expect(queuedReleaseTarget({ ...live, queued: 0 }) === "peer-1").toBe(false);
  });

  // The release is a re-arm, never a send: the whole point of the stop is the
  // code comparison, so the two predicates compose rather than substitute.
  it("still leaves the code comparison in front of the actual release", () => {
    const target = queuedReleaseTarget(live);
    expect(canReleaseConfirmedSend({
      confirmed: true, unified: true, targetPeerId: target,
      linkPeerId: target, shownSas: "",
    })).toBe(false);
    expect(canReleaseConfirmedSend({
      confirmed: true, unified: true, targetPeerId: target,
      linkPeerId: target, shownSas: "483920",
    })).toBe(true);
  });
});
