// What the same-network screen says about who can be on the list.
//
// The screen used to say nothing. Its lede promised "a device on this network,
// with nothing going through a server" — and Relayium does not scan a network
// (it asks its rendezvous service who else arrives from the same public
// address), while whether a transfer runs directly or over a relay depends on
// the network, which this screen's OWN help panel already said.
//
// What these cases can check is coverage and interpolation. The placement and
// the wording judgement are review's, and are recorded as such in the ledger.
import { describe, expect, it } from "vitest";

import { en, zh } from "../../src/renderer/i18n/messages.js";
import { setLang, t } from "../../src/renderer/i18n/index.svelte.js";

describe("the same-network screen's honesty copy", () => {
  it("exists in both maintained languages", () => {
    for (const key of ["lanSafety", "lanNamesDisclaimer", "lanSubtitle"] as const) {
      expect(en[key], key).toBeTruthy();
      expect(zh[key], key).toBeTruthy();
      expect(zh[key], key).not.toBe(en[key]);
    }
  });

  it("names the setting rather than describing it", () => {
    // The disclaimer points at a real control. Interpolating the setting's own
    // label means a renamed setting cannot leave this sentence pointing at
    // something that is not on the Settings screen.
    // Through the real `t`, so this exercises the interpolation the page uses
    // rather than a re-implementation of it.
    for (const [code, cat] of [["en", en], ["zh", zh]] as const) {
      setLang(code);
      const filled = t("lanNamesDisclaimer", { setting: t("settingsVerify") });
      expect(filled, code).toContain(cat.settingsVerify);
      expect(filled, code).not.toContain("{setting}");
    }
    setLang("en");
  });

  it("does not promise the transfer avoids a server", () => {
    // The lede said "nothing going through a server" while `helpLanBoundary`
    // on the same screen said a Relayium relay may carry it and this PC cannot
    // tell which. One of the two had to go, and it was the promise.
    //
    // Asserted as an absence with the exact former phrase, which is narrow on
    // purpose: a general "says nothing about servers" check would forbid the
    // true sentence the boundary answer needs to keep.
    expect(en.lanSubtitle).not.toContain("nothing going through a server");
    expect(en.helpLanBoundary).toContain("relay");
  });

  it("says who else can be at the same address", () => {
    // The substance. Not asserted by wording: asserted by the three
    // circumstances macOS names, because those are the ones that put a
    // stranger on the list and each is a different situation a person may
    // recognise as theirs.
    for (const term of ["carrier", "VPN", "gateway"]) {
      expect(en.lanSafety, term).toContain(term);
    }
    for (const term of ["运营商", "VPN", "网关"]) {
      expect(zh.lanSafety, term).toContain(term);
    }
  });
});
