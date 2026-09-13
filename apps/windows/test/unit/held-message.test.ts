// What becomes of a message sent before the lane was open.
//
// Pressing Send with no conversation yet is the ASK: the lane opens and the
// body waits. Three endings, each a different promise to the person who pressed
// the button. `grep -rn "awaitingLane|intentHolds|LANE_TERMINAL" test/` returned
// nothing before this file — including for the re-entrancy guard whose absence
// once put one click's message on the peer twice.
import { describe, expect, it } from "vitest";

import { heldMessageOutcome, type HeldMessageState } from "../../src/renderer/rooms/held-message.js";
import type { TextStatus } from "../../../../web/src/lib/text-model";

const ALL: readonly TextStatus[] = [
  "idle", "connecting", "waitingAccept", "incomingRequest",
  "open", "ended", "failed", "refused", "unsupported", "peerBusy",
];
const TERMINAL: readonly TextStatus[] = ["ended", "failed", "refused", "unsupported", "peerBusy"];

const held = (over: Partial<HeldMessageState> = {}): HeldMessageState => ({
  status: "connecting",
  intentHolds: true,
  sending: false,
  ...over,
});

describe("a message waiting for its lane", () => {
  it("waits while the lane is still coming", () => {
    for (const status of ["idle", "connecting", "waitingAccept", "incomingRequest"] as const) {
      expect(heldMessageOutcome(held({ status })), status).toBe("wait");
    }
  });

  it("is delivered the moment the lane is open", () => {
    expect(heldMessageOutcome(held({ status: "open" }))).toBe("deliver");
  });

  it("is NOT delivered twice while one is in flight", () => {
    // "One click, two messages, observed on the peer." The effect that owns
    // this re-enters because sending writes the transcript it reads, and the
    // guard is `sending` set synchronously before the first await. That guard
    // was asserted by nothing until this line.
    expect(heldMessageOutcome(held({ status: "open", sending: true }))).toBe("wait");
  });

  it("is given back, as a failure, once the lane can no longer open", () => {
    for (const status of TERMINAL) {
      expect(heldMessageOutcome(held({ status })), status).toBe("failed");
    }
  });
});

describe("an intent that stopped holding", () => {
  it("abandons the message whatever the lane did", () => {
    // A quit fenced the page, verification was switched on, the peer changed,
    // or the link was replaced. A lane that opens afterwards is the PEER
    // acting, and delivering would send into a conversation nobody chose.
    for (const status of ALL) {
      expect(heldMessageOutcome(held({ status, intentHolds: false })), status).toBe("abandon");
    }
  });

  it("abandons rather than delivering even with the lane open and idle", () => {
    // The order matters and this pins it: the intent is checked BEFORE the
    // status, so an open lane cannot rescue a message the user no longer means.
    expect(heldMessageOutcome({ status: "open", intentHolds: false, sending: false })).toBe("abandon");
  });

  it("is not reported as a failure", () => {
    // Nothing failed. Saying so would put a red line under a send the user
    // themselves invalidated by quitting or switching verification on.
    expect(heldMessageOutcome(held({ status: "failed", intentHolds: false }))).not.toBe("failed");
  });
});

describe("the terminal set", () => {
  it("classifies every status, with none left to hang", () => {
    // It was `readonly string[]` listing five members, so nothing checked it.
    // An eleventh status would have been treated as non-terminal and a held
    // message in it would hang: box empty, nothing delivered, no failure said.
    for (const status of ALL) {
      const outcome = heldMessageOutcome(held({ status }));
      expect(["wait", "deliver", "failed"], status).toContain(outcome);
    }
  });

  it("agrees with the five the lane can actually end on", () => {
    for (const status of ALL) {
      const ends = heldMessageOutcome(held({ status })) === "failed";
      expect(ends, status).toBe(TERMINAL.includes(status));
    }
  });
});
