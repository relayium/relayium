import { describe, it, expect } from "vitest";
import privacy from "./content/legal/privacy.mjs";
import terms from "./content/legal/terms.mjs";
import { buildLegalPages, buildSitemap, articleGroupsByLang, buildGuidesIndexPages } from "./build-pages.mjs";
import { landingUrl, landingPath, ctaHref, validateLangs, LANDING_LANGS, SPA_ONLY_EN_SLUGS, NO_LOCALIZED_TWIN_SLUGS, urlPath, LANGS, MAINTAINED_LANGS, FROZEN_LANGS } from "./shared.mjs";
import guidesIndex from "./content/guides-index.mjs";

const docs = [privacy, terms];

describe("buildLegalPages", () => {
  const pages = buildLegalPages(docs);

  it("produces 18 pages (2 docs × 9 langs)", () => {
    expect(pages.length).toBe(18);
  });

  it("uses pretty paths with en unprefixed and others lang-prefixed", () => {
    const paths = pages.map((p) => p.path);
    expect(paths).toContain("privacy/index.html");
    expect(paths).toContain("terms/index.html");
    expect(paths).toContain("zh/privacy/index.html");
    expect(paths).toContain("fr/terms/index.html");
  });

  it("renders localized titles into the HTML", () => {
    const zhPrivacy = pages.find((p) => p.path === "zh/privacy/index.html");
    expect(zhPrivacy.html).toContain("<h1>隐私政策</h1>");
  });
});

describe("buildSitemap", () => {
  const xml = buildSitemap(docs, { home: true });

  it("includes the homepage and all 18 legal URLs", () => {
    expect(xml).toContain("<loc>https://relayium.com/</loc>");
    expect(xml).toContain("<loc>https://relayium.com/privacy/</loc>");
    expect(xml).toContain("<loc>https://relayium.com/zh/terms/</loc>");
    expect((xml.match(/<loc>/g) || []).length).toBe(19);
  });
});

// Every <loc> in an emitted sitemap, mapped to the <lastmod> that follows it.
function lastmods(sitemapXml) {
  const out = new Map();
  for (const m of sitemapXml.matchAll(/<loc>([^<]*)<\/loc>\s*<lastmod>([^<]*)<\/lastmod>/g)) {
    out.set(m[1], m[2]);
  }
  return out;
}

// A <lastmod> is a per-URL claim, and this loop emitted English's date for all
// nine. That was invisible while the nine locales moved together and became a
// false statement the moment they stopped: the 2026-08-14 freeze left the seven
// archived privacy translations at 2026-08-13, and the maintained pair moved to
// 2026-08-30, so /ja/privacy/ was telling crawlers it had been revised on a day
// its prose did not change.
describe("localized legal URLs are dated from their own locale", () => {
  const dated = lastmods(buildSitemap([privacy], { home: false }));

  it("gives each locale the date its own document carries", () => {
    for (const lang of LANGS) {
      const url = `https://relayium.com${urlPath("privacy", lang)}`;
      expect(dated.get(url), `${lang} privacy lastmod`).toBe(privacy.langs[lang].updated);
    }
  });

  it("shows the maintained pair as revised and the frozen seven as archived", () => {
    // Spelled out as literals as well as derived above, because the derived
    // assertion alone would still pass if every locale collapsed onto one date.
    // These are the two dates that must actually appear, and the split between
    // them is the whole point of the fix.
    for (const lang of MAINTAINED_LANGS) {
      expect(dated.get(`https://relayium.com${urlPath("privacy", lang)}`), lang).toBe("2026-08-30");
    }
    for (const lang of FROZEN_LANGS) {
      expect(dated.get(`https://relayium.com${urlPath("privacy", lang)}`), lang).toBe("2026-08-13");
    }
  });

  it("does not copy English's date onto a single frozen legal URL", () => {
    // The regression this file exists to catch, stated as the fanout itself
    // rather than as a date: if English is ever re-revised, this keeps failing
    // for the right reason instead of needing a new literal.
    const en = privacy.langs.en.updated;
    const leaked = FROZEN_LANGS.filter(
      (lang) => dated.get(`https://relayium.com${urlPath("privacy", lang)}`) === en,
    );
    expect(
      leaked,
      `frozen locales given English's ${en}; a lastmod must describe the document at its own URL`,
    ).toEqual([]);
    // And the guard is only meaningful while the two dates actually differ.
    expect(privacy.langs.ja.updated).not.toBe(en);
  });

  it("still dates a doc whose nine locales agree with that one date", () => {
    // terms/ has not diverged, so the fix must be a no-op there — the change is
    // "read the locale's own value", not "make frozen locales older".
    const termsDated = lastmods(buildSitemap([terms], { home: false }));
    for (const lang of LANGS) {
      expect(termsDated.get(`https://relayium.com${urlPath("terms", lang)}`), lang).toBe(
        terms.langs.en.updated,
      );
    }
  });
});

describe("landing helpers", () => {
  it("landingUrl maps en to / and others to /<lang>/", () => {
    expect(landingUrl("en")).toBe("/");
    expect(landingUrl("zh")).toBe("/zh/");
  });
  it("landingPath rejects en and nests others", () => {
    expect(() => landingPath("en")).toThrow();
    expect(landingPath("ja")).toBe("ja/index.html");
  });
  it("ctaHref presets the SPA language", () => {
    expect(ctaHref("en")).toBe("/");
    expect(ctaHref("zh")).toBe("/?lang=zh");
  });
  it("validateLangs throws listing missing languages", () => {
    expect(() => validateLangs("x", { en: {}, zh: {} })).toThrow(/missing translations: ja, ko, de, fr/);
    expect(() => validateLangs("x", { zh: {}, ja: {}, ko: {}, de: {}, fr: {}, ar: {}, es: {}, pt: {} }, LANDING_LANGS)).not.toThrow();
  });
});

describe("buildSitemap lastmod", () => {
  it("uses each doc's updated date instead of a hardcoded one", () => {
    const xml = buildSitemap(docs, { home: true });
    expect(xml).toContain(`<lastmod>${privacy.langs.en.updated}</lastmod>`);
    expect(xml).not.toContain("2026-06-29");
  });
});

const fakeArticles = [
  { slug: "compare/snapdrop", updated: "2026-07-01", langs: Object.fromEntries(
      ["en","zh","ja","ko","de","fr","ar","es","pt"].map((l) => [l, { title: `snap-${l}` }])) },
  { slug: "how-to/x", updated: "2026-07-02", langs: Object.fromEntries(
      ["en","zh","ja","ko","de","fr","ar","es","pt"].map((l) => [l, { title: `howto-${l}` }])) },
  { slug: "guides/y", updated: "2026-07-03", langs: Object.fromEntries(
      ["en","zh","ja","ko","de","fr","ar","es","pt"].map((l) => [l, { title: `guide-${l}` }])) },
];

describe("articleGroupsByLang", () => {
  const groups = articleGroupsByLang(fakeArticles);

  it("has all nine languages", () => {
    expect(Object.keys(groups).sort()).toEqual(["ar","de","en","es","fr","ja","ko","pt","zh"]);
  });

  it("buckets each article by slug prefix into guides/howTo/compare", () => {
    expect(groups.en.compare.map((a) => a.slug)).toEqual(["compare/snapdrop"]);
    expect(groups.en.howTo.map((a) => a.slug)).toEqual(["how-to/x"]);
    expect(groups.en.guides.map((a) => a.slug)).toEqual(["guides/y"]);
  });

  it("uses the language-specific title", () => {
    expect(groups.zh.guides[0].title).toBe("guide-zh");
  });
});

describe("buildGuidesIndexPages", () => {
  const pages = buildGuidesIndexPages(guidesIndex, articleGroupsByLang(fakeArticles));

  it("produces one page per language at the guides path", () => {
    expect(pages.length).toBe(9);
    expect(pages.map((p) => p.path)).toContain("guides/index.html");
    expect(pages.map((p) => p.path)).toContain("zh/guides/index.html");
  });

  it("renders the localized H1 and links the grouped articles", () => {
    const zh = pages.find((p) => p.path === "zh/guides/index.html");
    expect(zh.html).toContain("<h1>使用指南</h1>");
    expect(zh.html).toContain('href="/zh/guides/y/"');
    expect(zh.html).toContain('href="/zh/compare/snapdrop/"');
  });
});

describe("buildSitemap with guidesIndex", () => {
  const xml = buildSitemap(docs, { home: true, guidesIndex });
  it("adds the six hub URLs", () => {
    expect(xml).toContain("<loc>https://relayium.com/guides/</loc>");
    expect(xml).toContain("<loc>https://relayium.com/fr/guides/</loc>");
  });
});

// ── SEO URL-form invariants ───────────────────────────────────────────────────
// Generated pages are written to <slug>/index.html and the origin 301s the
// slash-less form to the slashed one. When canonical/hreflang/sitemap emitted the
// slash-less form, every one of them pointed at a redirect — ~390 URLs landed in
// Search Console's "Page with redirect" bucket and the canonical tags pointed at
// URLs that 301'd away. These tests pin the two halves of the rule so the
// convention can't drift back silently.
describe("SEO URL forms", () => {
  const crossNetwork = { updated: "2026-01-01", langs: Object.fromEntries(LANDING_LANGS.map((l) => [l, {}])) };
  const xml = buildSitemap(docs, {
    home: true,
    guidesIndex,
    modes: [{ def: crossNetwork, slug: "cross-network" }],
  });
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  it("every sitemap URL ends in a slash except the English SPA-only routes", () => {
    const slashless = locs.filter((u) => !u.endsWith("/"));
    expect(slashless).toEqual(["https://relayium.com/cross-network"]);
  });

  it("keeps English SPA-only routes slash-less (they have no directory to 301 to)", () => {
    for (const slug of SPA_ONLY_EN_SLUGS) {
      expect(urlPath(slug, "en")).toBe(`/${slug}`);
    }
  });

  // Only the mode slugs have a localized static twin. Asserting the zh form for
  // every SPA_ONLY_EN_SLUGS member would bless /zh/pricing/ — a 404 — as the
  // right answer; see the NO_LOCALIZED_TWIN_SLUGS case below.
  it("gives the mode routes a slashed localized twin", () => {
    for (const slug of SPA_ONLY_EN_SLUGS) {
      if (NO_LOCALIZED_TWIN_SLUGS.has(slug)) continue;
      expect(urlPath(slug, "zh")).toBe(`/zh/${slug}/`);
    }
  });

  it("gives every directory-backed page a trailing slash in both languages", () => {
    expect(urlPath("compare/croc", "en")).toBe("/compare/croc/");
    expect(urlPath("compare/croc", "de")).toBe("/de/compare/croc/");
    expect(urlPath("privacy", "en")).toBe("/privacy/");
    expect(urlPath("guides", "ja")).toBe("/ja/guides/");
  });

  it("fails the build when a new mode slug is not registered as SPA-only", () => {
    expect(() =>
      buildSitemap(docs, { modes: [{ def: crossNetwork, slug: "brand-new-mode" }] })
    ).toThrow(/add to MODE_SLUGS/);
  });
});

// ── The slash-less English SPA pages (/pricing, /cli, /device-inbox) ──────────
// These are served slash-less by the origin, exactly like the mode routes, but
// they were never registered in SPA_ONLY_EN_SLUGS. urlPath() therefore claimed
// they lived at /pricing/ — a URL that 301s away — and the sitemap only avoided
// emitting it because gen-pages.mjs passed a hardcoded literal path that
// bypassed urlPath() entirely. Two sources of truth, one of them wrong: the
// exact shape of the regression that moved ~390 URLs into "Page with redirect".
// These tests collapse them to one and keep the guard honest.
describe("English SPA pages are registered, not special-cased", () => {
  const SPA_PAGE_SLUGS = ["pricing", "cli", "device-inbox"];

  it("registers every slash-less SPA page so urlPath() reports its real URL", () => {
    for (const slug of SPA_PAGE_SLUGS) {
      expect(SPA_ONLY_EN_SLUGS.has(slug)).toBe(true);
      expect(urlPath(slug, "en")).toBe(`/${slug}`);
    }
  });

  it("derives the sitemap entry from urlPath() instead of a literal path", () => {
    const xml = buildSitemap([], { home: false, spaPages: SPA_PAGE_SLUGS.map((slug) => ({ slug })) });
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual(SPA_PAGE_SLUGS.map((s) => `https://relayium.com/${s}`));
  });

  it("fails the build when a new SPA page slug is not registered as SPA-only", () => {
    expect(() =>
      buildSitemap(docs, { spaPages: [{ slug: "brand-new-spa-page" }] })
    ).toThrow(/add to NO_LOCALIZED_TWIN_SLUGS/);
  });

  // A caller left on the pre-2026-08-10 { path } shape yields undefined slugs.
  // It must fail loudly AND name what it choked on, or the migration error is
  // an empty list.
  it("names the offending entry when a caller still passes the old { path } shape", () => {
    expect(() => buildSitemap(docs, { spaPages: [{ path: "/pricing" }] })).toThrow(
      /undefined \(add to NO_LOCALIZED_TWIN_SLUGS\)/
    );
  });

  it("refuses to invent a localized URL for a page with no localized twin", () => {
    for (const slug of NO_LOCALIZED_TWIN_SLUGS) {
      expect(() => urlPath(slug, "zh")).toThrow(/no localized static page/);
      expect(urlPath(slug, "en")).toBe(`/${slug}`);
    }
  });
});
