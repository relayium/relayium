import { describe, it, expect } from "vitest";
import landing from "./content/landing.mjs";
import { buildLandingPages } from "./build-pages.mjs";
import { renderLandingPage } from "./landing-template.mjs";

describe("buildLandingPages", () => {
  const pages = buildLandingPages(landing);

  it("produces 5 pages at <lang>/index.html", () => {
    expect(pages.map((p) => p.path).sort()).toEqual(
      ["de/index.html", "fr/index.html", "ja/index.html", "ko/index.html", "zh/index.html"]
    );
  });

  it("zh page has localized h1, canonical, and full hreflang cluster", () => {
    const zh = pages.find((p) => p.path === "zh/index.html").html;
    expect(zh).toContain('<html lang="zh-Hans">');
    expect(zh).toContain('<link rel="canonical" href="https://relayium.com/zh/" />');
    expect(zh).toContain('hreflang="en" href="https://relayium.com/"');
    expect(zh).toContain('hreflang="ja" href="https://relayium.com/ja/"');
    expect(zh).toContain('hreflang="x-default" href="https://relayium.com/"');
    expect(zh).toContain("<h1>");
  });

  it("CTA opens the SPA with the language preset", () => {
    const ja = pages.find((p) => p.path === "ja/index.html").html;
    expect(ja).toContain('href="/?lang=ja"');
  });

  it("embeds WebApplication + FAQPage JSON-LD in the page language", () => {
    const de = pages.find((p) => p.path === "de/index.html").html;
    expect(de).toContain('"@type":"FAQPage"');
    expect(de).toContain('"inLanguage":"de"');
  });

  it("renders article links when provided", () => {
    const html = renderLandingPage({
      lang: "zh",
      doc: landing.langs.zh,
      articleLinks: [{ slug: "compare/snapdrop", title: "对比 Snapdrop" }],
    });
    expect(html).toContain('href="/zh/compare/snapdrop"');
  });
});
