// What a send outcome is allowed to claim, and what a target may show.
//
// Pure narrowing, so these are assertions about the CONTRACT rather than about
// a composition: three of the four outcome members are not success, and two of
// them have a specific way of being reported wrongly.

import { describe, expect, it } from "vitest";
import {
  describeSendOutcome,
  describeTarget,
  retryShape,
} from "../../src/main/features/inbox-send.js";
import type { SendOutcome } from "../../src/main/inbox/send-coordinator.js";

const task = (state: string) => ({ ID: "t1", State: state }) as never;

describe("a send outcome, as a page may see it", () => {
  it("reports the SERVER's state, not the creation flag", () => {
    // `created` answers "was this attempt the one that made it", which a
    // converged retry answers `false` while being every bit as delivered.
    const converged = describeSendOutcome({
      kind: "delivered",
      created: false,
      task: task("queued"),
    } as SendOutcome);
    expect(converged).toEqual({ kind: "delivered", created: false, state: "queued" });
    expect(retryShape(converged)).toBe("none");
  });

  it("keeps unknown as unknown, and asks for CONVERGENCE rather than a new send", () => {
    // Collapsing it into `refused` would assert nothing was delivered — the one
    // thing this outcome means the process cannot establish. Sending afresh
    // would risk a second task for one user action.
    const unknown = describeSendOutcome({ kind: "unknown", reason: "transport" } as SendOutcome);
    expect(unknown).toEqual({ kind: "unknown", reason: "transport" });
    expect(retryShape(unknown)).toBe("converge");
  });

  it("carries an orphaned object as a report, and a retryable refusal as fresh", () => {
    const refused = describeSendOutcome({
      kind: "refused",
      reason: "server-refused",
      releasedObject: false,
      retryable: true,
      orphanedObject: true,
    } as SendOutcome);
    expect(refused).toMatchObject({ orphanedObject: true, retryable: true });
    // A retryable refusal genuinely created nothing, so a fresh attempt is safe.
    expect(retryShape(refused)).toBe("fresh");
  });

  it("offers no retry for a refusal that is not retryable", () => {
    const refused = describeSendOutcome({
      kind: "refused",
      reason: "unsupported_content_kind",
      releasedObject: false,
      retryable: false,
      orphanedObject: false,
    } as SendOutcome);
    expect(retryShape(refused)).toBe("none");
  });

  it("carries central's last word on a cancellation", () => {
    expect(describeSendOutcome({ kind: "cancelled", task: task("revoked") } as SendOutcome)).toEqual({
      kind: "cancelled",
      state: "revoked",
    });
    expect(describeSendOutcome({ kind: "cancelled", task: null } as SendOutcome)).toEqual({
      kind: "cancelled",
      state: null,
    });
  });
});

describe("a target, as the choosing UI may see it", () => {
  it("shows a device and a name, and no key material at all", () => {
    // A renderer holding a target's key could seal to it, which is the whole
    // thing this boundary exists to prevent.
    const view = describeTarget(
      {
        deviceID: "dev-2",
        key: { keyID: "k1", generation: 3, publicKey: "PUBLIC-KEY-BYTES", algorithm: "x25519" },
        inbox: {
          capabilities: ["inbox.receive.v3"],
          autoAccept: "ask",
          presence: "online",
          protocolVersion: 3,
          revoked: false,
        },
      },
      "A phone",
      null,
    );
    expect(view).toEqual({ deviceID: "dev-2", name: "A phone", eligible: true, refusal: null });
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("PUBLIC-KEY-BYTES");
    expect(serialised).not.toContain("k1");
    expect(serialised).not.toContain("x25519");
  });

  it("carries a closed refusal token for an ineligible device", () => {
    const view = describeTarget(
      {
        deviceID: "dev-3",
        key: { keyID: "k2", generation: 1, publicKey: "P", algorithm: "x25519" },
        inbox: {
          capabilities: [],
          autoAccept: "off",
          presence: "offline",
          protocolVersion: 3,
          revoked: true,
        },
      },
      "An old laptop",
      "auto_receive_disabled",
    );
    expect(view.eligible).toBe(false);
    expect(view.refusal).toBe("auto_receive_disabled");
  });
});
