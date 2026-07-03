import { describe, it, expect } from "vitest";
import compareSnapdrop from "./content/articles/compare-snapdrop.mjs";
import { buildArticlePages, articleLinksByLang } from "./build-pages.mjs";

describe("buildArticlePages", () => {
  const pages = buildArticlePages([compareSnapdrop]);

  it("produces 6 pages with en unprefixed", () => {
    const paths = pages.map((p) => p.path);
    expect(paths).toContain("compare/snapdrop/index.html");
    expect(paths).toContain("zh/compare/snapdrop/index.html");
    expect(paths.length).toBe(6);
  });

  it("en page has canonical + full hreflang cluster + Article JSON-LD", () => {
    const en = pages.find((p) => p.path === "compare/snapdrop/index.html").html;
    expect(en).toContain('<link rel="canonical" href="https://relayium.com/compare/snapdrop" />');
    expect(en).toContain('hreflang="zh-Hans" href="https://relayium.com/zh/compare/snapdrop"');
    expect(en).toContain('hreflang="x-default" href="https://relayium.com/compare/snapdrop"');
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
});
