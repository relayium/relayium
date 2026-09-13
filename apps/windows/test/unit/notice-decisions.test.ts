// Which resident notices a room's state produces.
//
// These exist because the decisions were inside an `$effect` and nothing could
// reach them. The proof of that is on the record: the shared-announcer mistake
// this file's last case names was injected deliberately during the batch that
// added the message-request notice, and NO suite noticed.
import { describe, expect, it } from "vitest";

import { noticesFor, type NoticeMemory, type NoticeRoomState } from "../../src/renderer/receive/notice-decisions.js";
import { OfferAnnouncer } from "../../src/renderer/receive/offer-announcer.js";

function memory(): NoticeMemory<object> {
  return {
    seenInbound: new Map<object, number>(),
    announcedSas: new Set<object>(),
    offers: new OfferAnnouncer<object, object>(),
    announcedTextRequest: new Map<object, number>(),
  };
}

const quiet: NoticeRoomState = {
  inboundIds: [],
  sasCode: "",
  verificationConfirmed: true,
  incoming: null,
  textRequested: false,
  linkGeneration: 1,
};

const state = (over: Partial<NoticeRoomState> = {}): NoticeRoomState => ({ ...quiet, ...over });

describe("a room with nothing happening", () => {
  it("produces no notices", () => {
    expect(noticesFor({}, quiet, memory())).toEqual([]);
  });
});

describe("an arriving message", () => {
  it("is announced once", () => {
    const room = {};
    const mem = memory();
    expect(noticesFor(room, state({ inboundIds: [1] }), mem)).toContain("saved-message");
    expect(noticesFor(room, state({ inboundIds: [1] }), mem)).not.toContain("saved-message");
  });

  it("announces the next one too", () => {
    const room = {};
    const mem = memory();
    noticesFor(room, state({ inboundIds: [1] }), mem);
    expect(noticesFor(room, state({ inboundIds: [1, 2] }), mem)).toContain("saved-message");
  });

  it("does not announce the same transcript twice", () => {
    // What actually protects this is the high-water mark: the second pass has
    // `latest === previous`, so nothing fires.
    const room = {};
    const mem = memory();
    noticesFor(room, state({ inboundIds: [1, 2, 3] }), mem);
    expect(noticesFor(room, state({ inboundIds: [1, 2, 3] }), mem)).toEqual([]);
  });

  it("DOES announce a transcript it is seeing for the first time", () => {
    // Recorded as behaviour rather than asserted as desirable.
    //
    // The shipped code carries a second condition next to the high-water mark —
    // `previous > 0 || history.some(e => e.dir === "in" && e.id === latest)` —
    // under a comment saying it is "only for messages that arrived after this
    // page started watching, so a reconnect that replays a transcript does not
    // re-announce it". That condition is VACUOUS: `latest` is derived from the
    // inbound ids, so it is always one of them, and the guard is
    // `previous > 0 || true`.
    //
    // Found by injection — deleting the guard changed no test, because the
    // high-water mark had already stopped the second pass.
    //
    // Left alone deliberately. Suppressing a first-observation transcript is a
    // product judgement (a person returning to a room may well want to know
    // what arrived), and this batch is an extraction. Recorded in ACTIVE-WORK.
    expect(noticesFor({}, state({ inboundIds: [1, 2, 3] }), memory())).toContain("saved-message");
  });
});

describe("a verification code waiting to be compared", () => {
  it("is announced once per room, and again after it is answered and returns", () => {
    const room = {};
    const mem = memory();
    const waiting = state({ sasCode: "123456", verificationConfirmed: false });
    expect(noticesFor(room, waiting, mem)).toContain("attention");
    expect(noticesFor(room, waiting, mem)).not.toContain("attention");
    // Answered: the memory clears, so a LATER code is its own event.
    noticesFor(room, state({ sasCode: "123456", verificationConfirmed: true }), mem);
    expect(noticesFor(room, waiting, mem)).toContain("attention");
  });

  it("is not announced when there is no code yet", () => {
    // Before the code is derived there is nothing to compare, and calling that
    // "attention" would send somebody to a screen with nothing on it.
    expect(noticesFor({}, state({ sasCode: "", verificationConfirmed: false }), memory())).toEqual([]);
  });
});

describe("two kinds of unanswered offer", () => {
  it("announces a file offer once", () => {
    const room = {};
    const mem = memory();
    const offer = { files: 2 };
    expect(noticesFor(room, state({ incoming: offer }), mem)).toContain("incoming");
    expect(noticesFor(room, state({ incoming: offer }), mem)).not.toContain("incoming");
  });

  it("announces a message request once, and says MESSAGE not files", () => {
    const room = {};
    const mem = memory();
    const first = noticesFor(room, state({ textRequested: true }), mem);
    expect(first).toContain("incoming-text");
    expect(first).not.toContain("incoming");
    expect(noticesFor(room, state({ textRequested: true }), mem)).not.toContain("incoming-text");
  });

  it("announces a SECOND conversation after the first is gone", () => {
    // Keyed by the link generation rather than the status, which is one
    // constant value: a second request would otherwise look identical to the
    // one already announced.
    const room = {};
    const mem = memory();
    noticesFor(room, state({ textRequested: true, linkGeneration: 1 }), mem);
    noticesFor(room, state({ textRequested: false, linkGeneration: 1 }), mem);
    expect(noticesFor(room, state({ textRequested: true, linkGeneration: 2 }), mem)).toContain("incoming-text");
  });

  it("does not let one kind silence the other", () => {
    // THE case. A file batch and a conversation can be outstanding on one room
    // at the same time, and a single announcer keyed by room lets whichever
    // arrived second displace the first — so the person hears about one of the
    // two things waiting for them.
    //
    // The mistake this names was injected during the batch that added the
    // message-request notice and NO suite noticed, because the decision lived
    // in an effect. That is why this file exists.
    const room = {};
    const mem = memory();
    const both = state({ incoming: { files: 1 }, textRequested: true });
    expect(noticesFor(room, both, mem)).toEqual(["incoming", "incoming-text"]);
    // And neither re-announces on the next pass.
    expect(noticesFor(room, both, mem)).toEqual([]);
  });

  it("keeps two rooms' memories apart", () => {
    const mem = memory();
    const offer = { files: 1 };
    expect(noticesFor({}, state({ incoming: offer }), mem)).toContain("incoming");
    expect(noticesFor({}, state({ incoming: offer }), mem)).toContain("incoming");
  });
});

describe("everything at once", () => {
  it("produces each notice exactly once, in a stable order", () => {
    const room = {};
    const mem = memory();
    const busy = state({
      inboundIds: [7],
      sasCode: "123456",
      verificationConfirmed: false,
      incoming: { files: 3 },
      textRequested: true,
    });
    expect(noticesFor(room, busy, mem)).toEqual([
      "saved-message",
      "attention",
      "incoming",
      "incoming-text",
    ]);
  });
});
