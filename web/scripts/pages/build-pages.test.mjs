import { describe, it, expect } from "vitest";
import privacy from "./content/legal/privacy.mjs";
import terms from "./content/legal/terms.mjs";
import { buildLegalPages, buildSitemap } from "./build-pages.mjs";
import { landingUrl, landingPath, ctaHref, validateLangs, LANDING_LANGS } from "./shared.mjs";

const docs = [privacy, terms];

describe("buildLegalPages", () => {
  const pages = buildLegalPages(docs);

  it("produces 12 pages (2 docs × 6 langs)", () => {
    expect(pages.length).toBe(12);
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

  it("includes the homepage and all 12 legal URLs", () => {
    expect(xml).toContain("<loc>https://relayium.com/</loc>");
    expect(xml).toContain("<loc>https://relayium.com/privacy</loc>");
    expect(xml).toContain("<loc>https://relayium.com/zh/terms</loc>");
    expect((xml.match(/<loc>/g) || []).length).toBe(13);
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
    expect(() => validateLangs("x", { zh: {}, ja: {}, ko: {}, de: {}, fr: {} }, LANDING_LANGS)).not.toThrow();
  });
});

describe("buildSitemap lastmod", () => {
  it("uses each doc's updated date instead of a hardcoded one", () => {
    const xml = buildSitemap(docs, { home: true });
    expect(xml).toContain(`<lastmod>${privacy.langs.en.updated}</lastmod>`);
    expect(xml).not.toContain("2026-06-29");
  });
});
