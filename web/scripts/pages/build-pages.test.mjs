import { describe, it, expect } from "vitest";
import privacy from "./content/legal/privacy.mjs";
import terms from "./content/legal/terms.mjs";
import { buildLegalPages, buildSitemap, articleGroupsByLang, buildGuidesIndexPages } from "./build-pages.mjs";
import { landingUrl, landingPath, ctaHref, validateLangs, LANDING_LANGS, SPA_ONLY_EN_SLUGS, urlPath } from "./shared.mjs";
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
    ).toThrow(/SPA_ONLY_EN_SLUGS/);
  });
});
