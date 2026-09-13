// What accepting a delivery says it did.
//
// The chain this replaces covered six of `InboxAcceptOutcome`'s eight members
// and three of `DeliveryReceipt`'s four, and both gaps ended at the same
// sentence: "That did not work. Relayium will try again on its own."
import { describe, expect, it } from "vitest";

import { acceptedCopy } from "../../src/renderer/inbox/accepted-copy.js";
import { BLOCKED_KEY } from "../../src/renderer/inbox/blocked-copy.js";
import type { InboxAcceptOutcome, InboxFailureCode } from "../../src/shared/ipc-contract.js";
import { en, zh } from "../../src/renderer/i18n/messages.js";

const receipt = {
  saved: { kind: "saved", total: 2, residue: "none", ackPending: false, recorded: true },
  savedAck: { kind: "saved", total: 2, residue: "none", ackPending: true, recorded: true },
  message: { kind: "saved-message", ackPending: false, recorded: true },
  partial: { kind: "partial", savedCount: 1, total: 3, residue: "present" },
  refused: { kind: "refused", failure: { code: "key-unavailable", residue: "none" } },
} as const;

/** Every member, with a representative payload. Total by TYPE, not by memory. */
const OUTCOMES = {
  received: { kind: "received", receipt: receipt.saved },
  queued: { kind: "queued" },
  "not-enabled": { kind: "not-enabled" },
  blocked: { kind: "blocked", reason: "whatever" },
  "already-settled": { kind: "already-settled" },
  busy: { kind: "busy" },
  refused: { kind: "refused" },
  failed: { kind: "failed", reason: "internal" },
} as const satisfies Record<InboxAcceptOutcome["kind"], InboxAcceptOutcome>;

describe("what accepting a delivery says", () => {
  it("answers every outcome, in both maintained languages", () => {
    for (const outcome of Object.values(OUTCOMES)) {
      const { key } = acceptedCopy(outcome);
      expect(en[key], outcome.kind).toBeTruthy();
      expect(zh[key], outcome.kind).toBeTruthy();
    }
  });

  it("does not promise a retry when receiving is OFF", () => {
    // The defect, and the worse half of it: the old fallback said Relayium
    // would try again on its own, and with receiving off nothing is running to
    // try. A person told that waits for something that is never coming.
    const said = en[acceptedCopy(OUTCOMES["not-enabled"]).key];
    expect(said).not.toBe(en.inboxFailed);
    expect(said.toLowerCase()).not.toContain("try again on its own");
    // And it names the remedy, which is the whole reason it is its own case.
    expect(said.toLowerCase()).toContain("switched off");
  });

  it("answers a refused receipt from the code it CARRIES", () => {
    // The receipt holds an `InboxFailure`, and `BLOCKED_KEY` is total over
    // every code it can hold. The fallback threw that away.
    for (const code of Object.keys(BLOCKED_KEY) as InboxFailureCode[]) {
      const outcome: InboxAcceptOutcome = {
        kind: "received",
        receipt: { ...receipt.refused, failure: { code, residue: "none" } },
      };
      expect(acceptedCopy(outcome).key, code).toBe(BLOCKED_KEY[code]);
      expect(en[acceptedCopy(outcome).key], code).not.toBe(en.inboxFailed);
    }
  });

  it("reports files on disk as saved even when the ACK is missing", () => {
    // A lost acknowledgement is not a lost delivery, and the receipt's own doc
    // says calling it a failure would be false in the direction that matters.
    const pending = acceptedCopy({ kind: "received", receipt: receipt.savedAck });
    expect(en[pending.key]).not.toBe(en.inboxFailed);
    expect(pending.key).not.toBe(acceptedCopy(OUTCOMES.received).key);
  });

  it("carries the counts for a partial, and only for a partial", () => {
    const partial = acceptedCopy({ kind: "received", receipt: receipt.partial });
    expect("values" in partial && partial.values).toEqual({ saved: 1, total: 3 });
    for (const outcome of Object.values(OUTCOMES)) {
      if (outcome.kind === "received") continue;
      expect("values" in acceptedCopy(outcome), outcome.kind).toBe(false);
    }
  });

  it("still says `failed` for the one member that fallback was right about", () => {
    // Named rather than inherited, so the next member added does not silently
    // take this sentence the way `not-enabled` did.
    expect(acceptedCopy(OUTCOMES.failed).key).toBe("inboxFailed");
  });

  it("gives the non-received outcomes distinct sentences", () => {
    const plain = (["queued", "not-enabled", "blocked", "already-settled", "busy", "refused"] as const)
      .map((kind) => en[acceptedCopy(OUTCOMES[kind]).key]);
    expect(new Set(plain).size).toBe(plain.length);
  });
});
