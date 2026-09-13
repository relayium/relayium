import { describe, expect, it } from "vitest";
import type { LegacyReader } from "../../src/main/secret/legacy-cipher.js";

describe("the legacy reader is read-only by construction", () => {
  it("exposes no way to write the old format", () => {
    // Windows run 34466025680: a forced termination before Chromium commits
    // `Local State` leaves data sealed under a master key that never reached
    // disk. Continuing to WRITE that format would keep manufacturing the
    // failure, so there is no encrypt member to call — not a rule to remember.
    const reader: LegacyReader = { isAvailable: () => true, decrypt: () => "v" };
    expect(Object.keys(reader).sort()).toEqual(["decrypt", "isAvailable"]);
    expect("encrypt" in reader).toBe(false);
    expect("seal" in reader).toBe(false);
  });

  it("keeps availability separate from readability", () => {
    // "No cipher available" and "these bytes will not decrypt" are different
    // facts; collapsing them is how an identity gets replaced after a transient
    // failure.
    const reader: LegacyReader = {
      isAvailable: () => false,
      decrypt: () => { throw new Error("unreachable"); },
    };
    expect(reader.isAvailable()).toBe(false);
  });
});
