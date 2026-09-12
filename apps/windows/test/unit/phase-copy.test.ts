// The journal's phases and the page's copy for them, held against each other.
//
// Two independent declarations of the same fact: `TaskPhase` (which the page
// maps over, checked by the compiler) and `PHASES` (the runtime list the
// journal validates against, which the compiler only checks for membership —
// it cannot tell that one is MISSING). A phase added to the type and the map
// but forgotten in `PHASES` would be rejected by the journal at runtime while
// every type check passed.
//
// The page's fallback used to be `inboxReceiptBlocked` for anything
// unrecognised. That does not blank the row — it tells a person their delivery
// is blocked — so the cost of these two drifting apart is a false statement
// about somebody's files, not a cosmetic gap.
import { describe, expect, it } from "vitest";
import { PHASES } from "../../src/main/inbox/journal.js";
import { PHASE_KEY } from "../../src/renderer/inbox/phase-copy.js";
import { en, zh } from "../../src/renderer/i18n/messages.js";

describe("every journal phase has copy, and every copy has a phase", () => {
  it("covers exactly the same set", () => {
    expect([...PHASES].sort()).toEqual(Object.keys(PHASE_KEY).sort());
  });

  it("names keys that exist in both maintained languages", () => {
    for (const [phase, key] of Object.entries(PHASE_KEY)) {
      expect(en, `${phase} -> ${key} is missing from the English catalogue`).toHaveProperty(key);
      expect(zh, `${phase} -> ${key} is missing from the Chinese catalogue`).toHaveProperty(key);
      // Not merely present: a key whose value is empty renders a blank row.
      expect((en as Record<string, string>)[key]!.length).toBeGreaterThan(0);
      expect((zh as Record<string, string>)[key]!.length).toBeGreaterThan(0);
    }
  });

  it("says something different for a delivery that failed and one that saved", () => {
    // The two a person most needs told apart. A map that pointed both at one
    // key would satisfy every other assertion here.
    expect(PHASE_KEY.acked).not.toBe(PHASE_KEY.failed);
    expect(PHASE_KEY.partial).not.toBe(PHASE_KEY.acked);
  });
});
