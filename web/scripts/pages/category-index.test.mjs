// web/scripts/pages/category-index.test.mjs — the /how-to/ and /compare/ roots.
//
// Before these pages existed, both segments answered a hard 404 in all nine
// languages while 24 published articles sat underneath them. The checks here are
// the ones that would have caught that, plus the ones that keep the new pages
// from repeating the two indexing defects this site has already had: a title
// shared by two indexable URLs, and a page that is in the sitemap but linked
// from nowhere.
import { describe, expect, it } from "vitest";
import { buildAllPages, buildSiteSitemap } from "../gen-pages.mjs";
import { CATEGORY_HUBS } from "./content/category-index.mjs";
import guidesIndex from "./content/guides-index.mjs";
import { LANGS } from "./shared.mjs";

const pages = buildAllPages();
const byPath = new Map(pages.map((p) => [p.path, p.html]));
const sitemap = buildSiteSitemap();

describe("category root pages", () => {
  it("exists for both categories in every language", () => {
    const missing = [];
    for (const hub of CATEGORY_HUBS) {
      for (const lang of LANGS) {
        const path = lang === "en" ? `${hub.slug}/index.html` : `${lang}/${hub.slug}/index.html`;
        if (!byPath.has(path)) missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });

  it("takes its heading from the label the Guides hub already ships", () => {
    // Not a style point: two indexes that name the same category differently is
    // the drift this shape exists to make impossible.
    for (const hub of CATEGORY_HUBS) {
      for (const lang of LANGS) {
        const path = lang === "en" ? `${hub.slug}/index.html` : `${lang}/${hub.slug}/index.html`;
        const label = guidesIndex.langs[lang].categories[hub.group];
        expect(byPath.get(path), `${lang}/${hub.slug}`).toContain(`<h1>${label}</h1>`);
      }
    }
  });

  it("lists its own category and no other", () => {
    const howTo = byPath.get("how-to/index.html");
    const compare = byPath.get("compare/index.html");
    expect(howTo).toContain('href="/how-to/send-a-folder/"');
    expect(howTo).not.toContain('href="/compare/');
    expect(howTo).not.toContain('href="/guides/self-host-relayium/"');
    expect(compare).toContain('href="/compare/airdrop/"');
    expect(compare).not.toContain('href="/how-to/');
  });

  it("canonicalises and hreflangs to itself, not to the Guides hub", () => {
    const zh = byPath.get("zh/compare/index.html");
    expect(zh).toContain('<link rel="canonical" href="https://relayium.com/zh/compare/" />');
    expect(zh).toContain('hreflang="ar" href="https://relayium.com/ar/compare/"');
    expect(zh).toContain('hreflang="x-default" href="https://relayium.com/compare/"');
  });

  it("links back up to the full index", () => {
    // A category root with no way up is a leaf, and a reader who truncated a URL
    // to get here has already shown they are looking for the level above.
    for (const lang of ["en", "ja", "pt"]) {
      const path = lang === "en" ? "how-to/index.html" : `${lang}/how-to/index.html`;
      const up = lang === "en" ? '/guides/' : `/${lang}/guides/`;
      expect(byPath.get(path), path).toContain(`href="${up}"`);
    }
  });

  it("is linked FROM the Guides hub, so it is not an orphan in the sitemap", () => {
    expect(byPath.get("guides/index.html")).toContain('<h2><a href="/how-to/">');
    expect(byPath.get("ko/guides/index.html")).toContain('<h2><a href="/ko/compare/">');
  });

  it("appears in the sitemap for every language", () => {
    for (const hub of CATEGORY_HUBS) {
      for (const lang of LANGS) {
        const url = lang === "en" ? `https://relayium.com/${hub.slug}/` : `https://relayium.com/${lang}/${hub.slug}/`;
        expect(sitemap, url).toContain(`<loc>${url}</loc>`);
      }
    }
  });

  it("gives every root a title no other page on the site shares", () => {
    // The German how-to LABEL is the English word "How-to", so the obvious title
    // would have shipped one string on two indexable URLs. site-graph.test.mjs
    // checks the whole site; this pins the specific pair that nearly collided.
    const titleOf = (p) => byPath.get(p).match(/<title>(.*?)<\/title>/s)[1];
    expect(titleOf("de/how-to/index.html")).not.toBe(titleOf("how-to/index.html"));
  });
});
