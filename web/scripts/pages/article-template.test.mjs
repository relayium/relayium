import { describe, it, expect } from "vitest";
import compareSnapdrop from "./content/articles/compare-snapdrop.mjs";
import privacy from "./content/legal/privacy.mjs";
import terms from "./content/legal/terms.mjs";
import { buildArticlePages, articleLinksByLang, buildSitemap } from "./build-pages.mjs";

describe("buildArticlePages", () => {
  const pages = buildArticlePages([compareSnapdrop]);

  it("produces 9 pages with en unprefixed", () => {
    const paths = pages.map((p) => p.path);
    expect(paths).toContain("compare/snapdrop/index.html");
    expect(paths).toContain("zh/compare/snapdrop/index.html");
    expect(paths).toContain("ar/compare/snapdrop/index.html");
    expect(paths).toContain("es/compare/snapdrop/index.html");
    expect(paths).toContain("pt/compare/snapdrop/index.html");
    expect(paths.length).toBe(9);
  });

  it("en page has canonical + full hreflang cluster + Article JSON-LD", () => {
    const en = pages.find((p) => p.path === "compare/snapdrop/index.html").html;
    expect(en).toContain('<link rel="canonical" href="https://relayium.com/compare/snapdrop/" />');
    expect(en).toContain('hreflang="zh-Hans" href="https://relayium.com/zh/compare/snapdrop/"');
    expect(en).toContain('hreflang="x-default" href="https://relayium.com/compare/snapdrop/"');
    expect(en).toContain('"@type":"Article"');
  });

  it("includes FAQPage JSON-LD when the doc has a faq", () => {
    const zh = pages.find((p) => p.path === "zh/compare/snapdrop/index.html").html;
    expect(zh).toContain('"@type":"FAQPage"');
  });

  it("CTA points at the SPA with language preset", () => {
    const fr = pages.find((p) => p.path === "fr/compare/snapdrop/index.html").html;
    expect(fr).toContain('href="/?lang=fr"');
  });

  it("articleLinksByLang exposes localized titles keyed by lang", () => {
    const links = articleLinksByLang([compareSnapdrop]);
    expect(links.zh[0].slug).toBe("compare/snapdrop");
    expect(links.zh[0].title).toBe(compareSnapdrop.langs.zh.title);
  });

  it("missing translation fails the build", () => {
    const broken = { slug: "x", updated: "2026-07-03", langs: { en: compareSnapdrop.langs.en } };
    expect(() => buildArticlePages([broken])).toThrow(/missing translations/);
  });

  it("carries share-card meta: og:image, twitter:card, OG-format og:locale", () => {
    const zh = pages.find((p) => p.path === "zh/compare/snapdrop/index.html").html;
    expect(zh).toContain('property="og:image" content="https://relayium.com/og-image.jpg"');
    expect(zh).toContain('name="twitter:card" content="summary_large_image"');
    expect(zh).toContain('property="og:locale" content="zh_CN"');
  });

  it("localizes the footer privacy label", () => {
    const zh = pages.find((p) => p.path === "zh/compare/snapdrop/index.html").html;
    expect(zh).toContain('<a href="/zh/privacy/">隐私政策</a>');
    const en = pages.find((p) => p.path === "compare/snapdrop/index.html").html;
    expect(en).toContain('<a href="/privacy/">Privacy</a>');
  });

  it("links the Guides hub in the footer", () => {
    const en = pages.find((p) => p.path === "compare/snapdrop/index.html").html;
    expect(en).toContain('href="/guides/">Guides<');
  });

  it("footer order: Relayium link, then Guides, then Privacy", () => {
    const en = pages.find((p) => p.path === "compare/snapdrop/index.html").html;
    const relayiumIdx = en.indexOf(">← Relayium<");
    const guidesIdx = en.indexOf('href="/guides/">Guides<');
    const privacyIdx = en.indexOf('href="/privacy/">Privacy<');
    expect(relayiumIdx).toBeGreaterThan(-1);
    expect(guidesIdx).toBeGreaterThan(-1);
    expect(privacyIdx).toBeGreaterThan(-1);
    expect(relayiumIdx).toBeLessThan(guidesIdx);
    expect(guidesIdx).toBeLessThan(privacyIdx);
  });
});

describe("buildSitemap homepage lastmod", () => {
  it("uses the newest date across legal docs, landing, and articles", () => {
    // legal docs are older (2026-07-01) than the article (2026-07-03)
    const xml = buildSitemap([privacy, terms], { home: true, articles: [compareSnapdrop] });
    const home = xml.slice(xml.indexOf("<loc>https://relayium.com/</loc>"));
    expect(home.slice(0, 200)).toContain(`<lastmod>${compareSnapdrop.updated}</lastmod>`);
  });
});
