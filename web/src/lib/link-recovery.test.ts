import { describe, expect, it } from "vitest";
import { LINK_RECOVERY_WINDOW_MS } from "./peer-link.svelte";
import { recoveryBlock, recoveryWindowMs } from "./link-recovery";

const NOW = 1_700_000_000_000;
/** A link established while the socket held identity "self-1", with no relay
 *  credential bounding it. Every case below changes exactly one thing. */
const healthy = {
  joined: true,
  selfId: "self-1",
  establishedSelfId: "self-1",
  rejoinRefused: false,
  peerPresent: true,
  credentialDeadlineAt: null as number | null,
  now: NOW,
};

describe("recoveryBlock", () => {
  it("allows recovery for a live socket on the same identity", () => {
    expect(recoveryBlock(healthy)).toBe("");
  });

  it.each([
    ["the socket dropped and has not rejoined", { joined: false, selfId: "" }],
    ["the roster identity is absent", { selfId: "" }],
    ["the rejoin issued a NEW identity", { selfId: "self-2" }],
    ["the room refused or expired the rejoin", { rejoinRefused: true }],
    // The symmetric case, and the one an established link is preserved through:
    // our own socket is perfectly fine, the PEER's is gone. Its id addresses
    // nothing now, so the offer has nowhere to go even though we could send it.
    ["the server said the peer's own socket left", { peerPresent: false }],
  ])("blocks recovery on signaling when %s", (_label, over) => {
    // Rebuilding a transport is an authenticated offer THROUGH signaling, and it
    // is addressed by peer id. Without an identity — or with a replacement one —
    // there is nothing to send it over and nobody it would reach.
    expect(recoveryBlock({ ...healthy, ...over })).toBe("signaling");
  });

  it("blocks recovery on the credential once the relay deadline has passed", () => {
    expect(recoveryBlock({ ...healthy, credentialDeadlineAt: NOW - 1 })).toBe("credential");
    expect(recoveryBlock({ ...healthy, credentialDeadlineAt: NOW })).toBe("credential");
  });

  it("still allows recovery before the relay deadline", () => {
    expect(recoveryBlock({ ...healthy, credentialDeadlineAt: NOW + 1 })).toBe("");
  });

  it("reports the credential first when both are gone", () => {
    // Both are terminal; naming the credential is the truthful instruction,
    // because reconnecting the socket would not buy this link a usable relay.
    expect(recoveryBlock({ ...healthy, joined: false, selfId: "", credentialDeadlineAt: NOW - 1 }))
      .toBe("credential");
  });
});

describe("recoveryWindowMs", () => {
  it("keeps the existing 90-second window with no credential deadline", () => {
    expect(recoveryWindowMs(null, NOW)).toBe(LINK_RECOVERY_WINDOW_MS);
  });

  it("keeps it when the credential outlives the window", () => {
    expect(recoveryWindowMs(NOW + 10 * 60_000, NOW)).toBe(LINK_RECOVERY_WINDOW_MS);
  });

  it("shortens it so recovery can never outlive the credential", () => {
    expect(recoveryWindowMs(NOW + 20_000, NOW)).toBe(20_000);
  });

  it("is zero at or past the deadline — never a stale-credential attempt", () => {
    expect(recoveryWindowMs(NOW, NOW)).toBe(0);
    expect(recoveryWindowMs(NOW - 60_000, NOW)).toBe(0);
  });
});
