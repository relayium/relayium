// What the save-destination dialog asks, for a link that will be spent.
//
// The server deletes a burn-after-read object after one successful GET, so
// saving those files uses the link up — for everybody, including the person
// saving them. macOS says so on its facts screen (`download.burnNotice`).
// Windows has no facts screen; this dialog is where the write is authorised
// and the last moment anybody could be told, and it was saying nothing.
import { describe, expect, it } from "vitest";

import { EN, ZH_HANS, counter } from "../../src/main/l10n.js";
import { downloadPickTitleKey } from "../../src/main/download-title.js";

describe("which title the save dialog asks with", () => {
  it("changes only for a link that will be spent", () => {
    expect(downloadPickTitleKey(false)).toBe("native.download.pickTitle");
    expect(downloadPickTitleKey(true)).not.toBe(downloadPickTitleKey(false));
  });

  it("warns in both maintained languages", () => {
    for (const catalog of [EN, ZH_HANS]) {
      const ordinary = catalog[downloadPickTitleKey(false)];
      const burn = catalog[downloadPickTitleKey(true)];
      expect(burn).not.toBe(ordinary);
      expect(burn.length).toBeGreaterThan(ordinary.length);
    }
  });

  it("says the LINK is spent, not that files are deleted", () => {
    // Two different claims and only one is true: the files being saved are not
    // deleted. Getting this wrong would frighten somebody away from a download
    // that is about to succeed.
    const burn = EN[downloadPickTitleKey(true)];
    expect(burn.toLowerCase()).toContain("link");
    expect(burn.toLowerCase()).toContain("used up");
    expect(burn.toLowerCase()).not.toContain("delete");
  });

  it("still carries the count, through the one reviewed substitution", () => {
    // `CountedMessageKey` exists to keep the main process's interpolation at
    // exactly one variable. A burn flag folded in as a second template value
    // would have widened that surface; two complete sentences do not.
    for (const locale of ["en", "zh-Hans"] as const) {
      const tc = counter(locale);
      for (const burn of [false, true]) {
        const said = tc(downloadPickTitleKey(burn), 3);
        expect(said, `${locale}/${String(burn)}`).toContain("3");
        expect(said, `${locale}/${String(burn)}`).not.toContain("{count}");
      }
    }
  });
});
