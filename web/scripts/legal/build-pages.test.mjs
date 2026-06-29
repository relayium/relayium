import { describe, it, expect } from "vitest";
import privacy from "./content/privacy.mjs";
import terms from "./content/terms.mjs";
import { buildAllPages, buildSitemap } from "./build-pages.mjs";

const docs = [privacy, terms];

describe("buildAllPages", () => {
  const pages = buildAllPages(docs);

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
