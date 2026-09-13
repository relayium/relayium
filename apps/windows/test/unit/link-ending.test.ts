// What a link's ending says, and when the link counts as over.
//
// The decision is a module rather than a `{#if}` chain inside `LinkPane`
// specifically so these cases can call it: Svelte has no exhaustiveness
// checking, and nothing but a real mounted renderer executes one of its
// branches. macOS puts the same decision in `LinkWorkspaceCopy` for the same
// reason, and says so in its own doc.
import { describe, expect, it } from "vitest";

import { linkEndKey, linkIsTerminal, type LinkEndReason } from "../../src/renderer/rooms/link-ending.js";
import { en, zh } from "../../src/renderer/i18n/messages.js";

/** Every member of the union, listed HERE so a new one fails these cases. */
const REASONS: readonly LinkEndReason[] = ["", "relayExpired", "signalingLost"];

describe("what a named ending says", () => {
  it("answers every member of the union", () => {
    for (const reason of REASONS) {
      const key = linkEndKey(reason);
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
    }
  });

  it("gives the two named endings DIFFERENT sentences, in both languages", () => {
    // The whole point of the change. Both used to arrive as one unexplained
    // "Failed", and they need different actions: an expired relay means make
    // another code, a lost signalling socket means this link can never come
    // back at all.
    const relay = linkEndKey("relayExpired");
    const signaling = linkEndKey("signalingLost");
    expect(relay).not.toBe(signaling);
    expect(en[relay]).not.toBe(en[signaling]);
    expect(zh[relay]).not.toBe(zh[signaling]);
  });

  it("neither named ending reuses the bare status word", () => {
    // "Failed" beside a connection whose relay ran out is true and useless.
    for (const reason of ["relayExpired", "signalingLost"] as const) {
      expect(en[linkEndKey(reason)]).not.toBe(en.linkStatusFailed);
      expect(zh[linkEndKey(reason)]).not.toBe(zh.linkStatusFailed);
    }
  });

  it("says the least it honestly can when there is no named reason", () => {
    // `""` is a real member: the workspace names a reason for two endings only.
    expect(linkEndKey("")).toBe("linkStatusFailed");
  });

  it("every sentence it can return exists in BOTH maintained languages", () => {
    for (const reason of REASONS) {
      const key = linkEndKey(reason);
      expect(en[key]).toBeTruthy();
      expect(zh[key]).toBeTruthy();
      // Not the English string sitting in the Chinese catalogue.
      expect(zh[key]).not.toBe(en[key]);
    }
  });
});

describe("when the link counts as over", () => {
  it("a named reason is terminal whatever the status says", () => {
    // The status can still read `idle` at this point — which teardown path got
    // there first decides that — and a card that trusted it would show live
    // warnings for a connection that no longer exists.
    for (const reason of ["relayExpired", "signalingLost"] as const) {
      expect(linkIsTerminal(reason, "idle")).toBe(true);
      expect(linkIsTerminal(reason, "open")).toBe(true);
      expect(linkIsTerminal(reason, "connecting")).toBe(true);
    }
  });

  it("a plain failure is terminal too, with no reason to name", () => {
    expect(linkIsTerminal("", "failed")).toBe(true);
  });

  it("a live or connecting link is NOT terminal", () => {
    // Both warnings hang off this. Calling a live link terminal would hide the
    // relay-expiry warning at exactly the moment it is worth reading.
    for (const status of ["idle", "requesting", "connecting", "open", "interrupted"] as const) {
      expect(linkIsTerminal("", status)).toBe(false);
    }
  });
});
