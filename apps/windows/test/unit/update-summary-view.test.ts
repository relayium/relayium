// The update catalogue: whether this pane can say all eighteen things, in both
// languages, without saying anything false.
//
// The DOM harness proves the states RENDER distinctly. These are the copy
// invariants that can be checked without a renderer, and they are the ones
// where a wrong sentence is a wrong claim rather than a wrong layout.

import { describe, expect, it } from "vitest";
import { updateEn, updateZh, type UpdateMessageKey } from "../../src/renderer/update/messages.js";
import {
  UPDATE_ACTIONS,
  UPDATE_BLOCKED_REASONS,
  UPDATE_DISABLED_REASONS,
  UPDATE_STATE_KINDS,
  UPDATE_SUMMARY_LOADING,
  isUpdateAction,
  isUpdateExternalTarget,
} from "../../src/shared/update-summary.js";

describe("the contract enumerates the core's own set", () => {
  it("has eighteen kinds, in the core's order", () => {
    expect(UPDATE_STATE_KINDS.length).toBe(18);
    expect(UPDATE_STATE_KINDS[0]).toBe("disabled");
    expect(UPDATE_STATE_KINDS[UPDATE_STATE_KINDS.length - 1]).toBe("blocked");
    expect(new Set(UPDATE_STATE_KINDS).size).toBe(18);
  });

  it("keeps both reason pairs", () => {
    expect(UPDATE_DISABLED_REASONS).toEqual(["engineering-build", "no-pin"]);
    expect(UPDATE_BLOCKED_REASONS).toEqual(["unresolved-residue", "staging-unowned"]);
  });

  it("admits four actions and one external destination", () => {
    expect(UPDATE_ACTIONS).toEqual(["check", "download", "install", "reveal"]);
    for (const action of UPDATE_ACTIONS) expect(isUpdateAction(action)).toBe(true);
    expect(isUpdateAction("quit")).toBe(false);
    expect(isUpdateAction("")).toBe(false);
    expect(isUpdateExternalTarget("release-notes")).toBe(true);
    expect(isUpdateExternalTarget("https://evil.test")).toBe(false);
  });

  it("starts disabled, unread and frozen — today's shipped truth", () => {
    expect(UPDATE_SUMMARY_LOADING.state).toEqual({ kind: "disabled", reason: "no-pin" });
    expect(UPDATE_SUMMARY_LOADING.residue).toEqual({ kind: "unread" });
    expect(UPDATE_SUMMARY_LOADING.actions.canCheck).toBe(false);
    expect(Object.isFrozen(UPDATE_SUMMARY_LOADING)).toBe(true);
  });
});

describe("the catalogue covers both maintained languages", () => {
  const enKeys = Object.keys(updateEn).sort();

  it("has the same key set in both", () => {
    expect(Object.keys(updateZh).sort()).toEqual(enKeys);
  });

  it("has no empty string in either", () => {
    for (const key of enKeys as UpdateMessageKey[]) {
      expect(updateEn[key].length).toBeGreaterThan(0);
      expect(updateZh[key].length).toBeGreaterThan(0);
    }
  });

  it("uses the same placeholders in both", () => {
    const holders = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of enKeys as UpdateMessageKey[]) {
      expect({ key, h: holders(updateZh[key]) }).toEqual({ key, h: holders(updateEn[key]) });
    }
  });

  it("is really translated where it matters most", () => {
    for (const key of [
      "revealedBody",
      "readyUnsignedBody",
      "verifierUnavailableTitle",
      "feedUntrustedBody",
      "disabledNoPinBody",
      "residueFailed",
    ] as const) {
      expect(updateZh[key]).not.toBe(updateEn[key]);
      expect(updateZh[key]).toMatch(/[一-鿿]/);
    }
  });
});

describe("copy that must not claim an update happened", () => {
  it("revealed never says updated, in either language", () => {
    // The Windows unsigned path ends in a FILE. macOS's Sparkle flow ends in a
    // replaced application; reporting them the same way is the false parity
    // claim this assertion exists to prevent.
    expect(updateEn.revealedTitle.toLowerCase()).not.toContain("updated");
    expect(updateEn.revealedBody).toMatch(/has not been updated/i);
    expect(updateZh.revealedBody).toContain("尚未更新");
    expect(updateZh.revealedTitle).not.toContain("已更新");
    expect(updateZh.revealedBody).not.toMatch(/^.*已成功更新/);
  });

  it("installing does not claim completion either", () => {
    // The core never publishes a success state: the installer takes over and
    // the app exits, so this process does not survive to observe one.
    expect(updateEn.installingBody.toLowerCase()).not.toContain("has been updated");
    expect(updateZh.installingBody).not.toContain("已更新");
  });
});

describe("the unsigned copy", () => {
  it("names the missing publisher identity as a fact about Relayium", () => {
    expect(updateEn.readyUnsignedBody).toMatch(/no publisher identity/i);
    expect(updateEn.readyUnsignedBody).toMatch(/no code-signing certificate/i);
    expect(updateZh.readyUnsignedBody).toContain("没有代码签名证书");
  });

  it("promises nothing about how Windows will react", () => {
    // Reputation is not conferred by certificate type, and Smart App Control
    // can block an unsigned installer outright rather than warn. So the copy
    // describes what we verified and leaves the platform's decision alone.
    for (const text of [updateEn.readyUnsignedBody, updateEn.readyUnsignedTitle]) {
      expect(text).not.toMatch(/smartscreen|smart app control/i);
      expect(text).not.toMatch(/you may see a warning|will warn|click .?run anyway/i);
    }
  });

  it("never tells anyone to turn a protection off", () => {
    const forbidden = /disable|turn off|bypass|exclusion|allow ?list|关闭|禁用|排除/i;
    for (const key of ["readyUnsignedBody", "readyUnsignedTitle", "revealAction", "revealedBody"] as const) {
      expect(updateEn[key]).not.toMatch(forbidden);
      expect(updateZh[key]).not.toMatch(forbidden);
    }
  });

  it("is not the same sentence as a check that could not run", () => {
    // `verifier-unavailable` is NOT `unsigned`: one found no signature, the
    // other could not look.
    expect(updateEn.verifierUnavailableBody).not.toBe(updateEn.readyUnsignedBody);
    expect(updateEn.verifierUnavailableBody).toMatch(/not the same as/i);
    expect(updateZh.verifierUnavailableBody).not.toBe(updateZh.readyUnsignedBody);
  });
});

describe("copy for the states that offer nothing", () => {
  it("feed-untrusted says there is nothing to retry", () => {
    expect(updateEn.feedUntrustedBody).toMatch(/nothing to retry/i);
    expect(updateZh.feedUntrustedBody).toContain("没有可重试");
  });

  it("blocked explains without promising a fix", () => {
    for (const text of [updateEn.blockedResidueBody, updateEn.blockedStagingBody]) {
      expect(text).toMatch(/nothing was deleted|nothing is deleted/i);
    }
  });

  it("install-deferred does not read as a failed update", () => {
    expect(updateEn.installDeferredBody).toMatch(/nothing was changed/i);
    expect(updateEn.installDeferredBody.toLowerCase()).not.toContain("failed");
  });

  it("residue never says clean when it was not read", () => {
    expect(updateEn.residueUnread).toMatch(/has not checked/i);
    expect(updateEn.residueFailed).toMatch(/could not check/i);
    // The three sentences are genuinely different claims.
    expect(new Set([updateEn.residueUnread, updateEn.residueFailed, updateEn.residueClean]).size).toBe(3);
  });
});

describe("the states a person must be able to tell apart", () => {
  it("gives a distinct sentence to each pair that is easy to conflate", () => {
    // Not an arbitrary all-pairs uniqueness check: these are the specific
    // confusions that would mislead somebody about what was verified.
    const pairs: readonly (readonly [UpdateMessageKey, UpdateMessageKey])[] = [
      ["readyUnsignedTitle", "verifierUnavailableTitle"],
      ["readyUnsignedTitle", "publisherMismatchTitle"],
      ["verifierUnavailableTitle", "publisherMismatchTitle"],
      ["revealedTitle", "readyTitle"],
      ["revealedTitle", "upToDateTitle"],
      ["checkFailedTitle", "feedUntrustedTitle"],
      ["verifyFailedTitle", "feedUntrustedTitle"],
      ["disabledEngineeringTitle", "disabledNoPinTitle"],
      ["blockedResidueTitle", "blockedStagingTitle"],
      ["installDeferredTitle", "verifyFailedTitle"],
    ];
    for (const [a, b] of pairs) {
      expect(`${a}!=${b}: ${updateEn[a]}`).not.toBe(`${a}!=${b}: ${updateEn[b]}`);
      expect(updateEn[a]).not.toBe(updateEn[b]);
      expect(updateZh[a]).not.toBe(updateZh[b]);
    }
  });
});
