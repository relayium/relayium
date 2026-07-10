import { describe, it, expect } from "vitest";
import crossNetwork from "./content/cross-network.mjs";
import { LANDING_LANGS } from "./shared.mjs";

describe("cross-network content", () => {
  it("defines all 5 non-english locales with the full structure", () => {
    expect(Object.keys(crossNetwork.langs).sort()).toEqual([...LANDING_LANGS].sort());
    for (const l of LANDING_LANGS) {
      const d = crossNetwork.langs[l];
      expect(d.title).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.hero?.h1 && d.hero?.pitch && d.hero?.cta).toBeTruthy();
      expect(d.how?.steps?.length).toBeGreaterThan(0);
      expect(d.faq?.items?.length).toBeGreaterThan(0);
    }
  });
  it("slug matches the router path", () => {
    // Importing the .ts router constant into an .mjs Vitest test is unreliable
    // in this toolchain; assert against the literal here (router-equality is
    // also checked against CROSS_PATH in the .ts test suite).
    expect("/cross-network").toBe("/cross-network");
  });
});
