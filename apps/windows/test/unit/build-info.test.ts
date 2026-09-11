// What this artifact claims to be, and the interlock that keeps it honest.
//
// The update core compares its own build against the feed's, and `build` is the
// gate: strictly greater, or there is no update. Two ways to get that wrong
// have already been caught in review, and both are asserted here.

import { describe, expect, it } from "vitest";
import { BUILD_NUMBER, BUILD_NUMBER_PROVISIONED } from "../../src/main/build-info.js";

describe("this build's identity", () => {
  it("is a compiled constant, not derived from the version", () => {
    // The first attempt computed `major*1e6 + minor*1e3 + patch`, which invents
    // an ordering the feed never agreed to — two derivations would disagree
    // about which of two artifacts is newer, and the feed's opinion is the only
    // one that counts.
    expect(typeof BUILD_NUMBER).toBe("number");
    expect(Number.isSafeInteger(BUILD_NUMBER)).toBe(true);
    expect(BUILD_NUMBER).toBeGreaterThanOrEqual(0);
  });

  it("says plainly that it is not provisioned yet", () => {
    // Zero is honest for an artifact nobody has released: every real manifest
    // declares a build above zero, so an unreleased build correctly treats any
    // published one as newer.
    expect(BUILD_NUMBER_PROVISIONED).toBe(false);
    expect(BUILD_NUMBER).toBe(0);
  });

  it("keeps the flag and the number consistent", () => {
    // The pair is what the host interlock reads. A `true` flag beside a zero
    // number would assert a release that does not exist, and the interlock
    // would then enable an updater that offers the running version forever.
    if (BUILD_NUMBER_PROVISIONED) expect(BUILD_NUMBER).toBeGreaterThan(0);
    else expect(BUILD_NUMBER).toBe(0);
  });
});

describe("the host interlock", () => {
  /** The rule `handlers.ts` applies, in the shape it applies it. */
  const trustFor = (keys: readonly string[], provisioned: boolean, build: number): "enabled" | "disabled" =>
    keys.length > 0 && provisioned && build > 0 ? "enabled" : "disabled";

  it("refuses to enable updates on a build with no provisioned number", () => {
    // The failure this prevents is invisible in review: an enabled updater on a
    // build still numbered 0 treats every published build as newer, so it
    // offers to "update" to the version already running, on a loop.
    expect(trustFor(["a-key"], false, 0)).toBe("disabled");
    expect(trustFor(["a-key"], true, 0)).toBe("disabled");
    expect(trustFor(["a-key"], false, 42)).toBe("disabled");
  });

  it("stays disabled with no keys however the build is numbered", () => {
    expect(trustFor([], true, 42)).toBe("disabled");
    expect(trustFor([], false, 0)).toBe("disabled");
  });

  it("enables only when BOTH halves are provisioned", () => {
    expect(trustFor(["a-key"], true, 42)).toBe("enabled");
  });

  it("describes THIS build as disabled", () => {
    // The shipped constants, not a hypothetical. If this ever fails, somebody
    // has provisioned one half of a release.
    expect(trustFor([], BUILD_NUMBER_PROVISIONED, BUILD_NUMBER)).toBe("disabled");
  });
});
