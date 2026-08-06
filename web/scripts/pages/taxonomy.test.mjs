// web/scripts/pages/taxonomy.test.mjs — the hub's five groups are a decision
// someone made, and this is what stops the next article from inheriting one.
//
// Before content/taxonomy.mjs the group came from `slug.split("/")[0]`, so the
// URL chose it and nobody chose anything. The table replaced that with an
// explicit assignment; without this file, a new article added tomorrow would
// silently fall back to the group its prefix implies and look exactly like a
// decision.
import { describe, it, expect } from "vitest";
import { GROUPS, TAXONOMY } from "./content/taxonomy.mjs";
import { articleGroupsByLang } from "./build-pages.mjs";
import { articles } from "../gen-pages.mjs";

describe("every article has a group, chosen rather than inherited", () => {
  it("assigns every published article exactly once", () => {
    const slugs = articles.map((a) => a.slug);
    const missing = slugs.filter((s) => !TAXONOMY[s]);
    expect(missing, "articles with no group — add them to content/taxonomy.mjs").toEqual([]);

    const stale = Object.keys(TAXONOMY).filter((s) => !slugs.includes(s));
    expect(stale, "taxonomy entries for articles that no longer exist").toEqual([]);
  });

  it("names only groups the hub can render", () => {
    const bad = Object.entries(TAXONOMY).filter(([, [g]]) => !GROUPS.includes(g));
    expect(bad.map(([s, [g]]) => `${s} → ${g}`)).toEqual([]);
    expect(GROUPS).toHaveLength(5);
  });

  it("gives each group a reading order with no ties", () => {
    // Ties mean the order falls back to import order for those two, which is the
    // thing the order field exists to stop.
    for (const g of GROUPS) {
      const orders = Object.values(TAXONOMY).filter(([grp]) => grp === g).map(([, o]) => o);
      expect(new Set(orders).size, `${g} has duplicate order values`).toBe(orders.length);
    }
  });

  it("puts the beginner entry points first in their groups", () => {
    // The concrete defect this replaced: what-is-p2p and is-it-safe sat below
    // every tutorial because imports happened to be in that order.
    expect(TAXONOMY["guides/what-is-peer-to-peer-file-transfer"][1])
      .toBeLessThan(TAXONOMY["guides/how-relayium-encrypts-your-files"][1]);
    expect(TAXONOMY["how-to/send-files-on-the-same-wifi"][1])
      .toBeLessThan(TAXONOMY["how-to/share-a-file-with-an-expiring-link"][1]);
    expect(TAXONOMY["guides/transfer-files-from-terminal"][1])
      .toBeLessThan(TAXONOMY["guides/push-to-cloud-pull-on-another-computer"][1]);
  });

  it("renders each article on the hub exactly once", () => {
    // `compare` is both a legacy bucket and a taxonomy group, and the first
    // version of the grouping pushed to each in turn — every comparison appeared
    // twice on the page.
    const groups = articleGroupsByLang(articles).en;
    const onHub = GROUPS.flatMap((g) => groups[g]).map((a) => a.slug);
    expect(onHub.length, "an article is listed twice on the hub").toBe(new Set(onHub).size);
    expect(new Set(onHub).size).toBe(articles.length);
  });

  it("keeps the CLI group together regardless of URL prefix", () => {
    // The point of separating group from prefix: six cli-* articles live under
    // /guides/ because "cli" was once a category that got merged and never
    // cleaned up, and one CLI article lives under /how-to/.
    const cli = Object.entries(TAXONOMY).filter(([, [g]]) => g === "cli").map(([s]) => s);
    expect(cli.some((s) => s.startsWith("guides/"))).toBe(true);
    expect(cli.some((s) => s.startsWith("how-to/"))).toBe(true);
  });
});
