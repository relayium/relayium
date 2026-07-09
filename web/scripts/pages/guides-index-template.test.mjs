import { describe, it, expect } from "vitest";
import { renderGuidesIndexPage } from "./guides-index-template.mjs";
import guidesIndex from "./content/guides-index.mjs";

const groups = {
  guides: [{ slug: "guides/y", title: "Guide Y" }],
  howTo: [{ slug: "how-to/x", title: "Howto X" }],
  compare: [{ slug: "compare/snapdrop", title: "vs Snapdrop" }],
};

describe("renderGuidesIndexPage", () => {
  const en = renderGuidesIndexPage({ lang: "en", doc: guidesIndex.langs.en, groups });
  const zh = renderGuidesIndexPage({ lang: "zh", doc: guidesIndex.langs.zh, groups });

  it("renders the H1 heading and the three category headings", () => {
    expect(en).toContain("<h1>Guides</h1>");
    expect(en).toContain(">Guides</h2>");
    expect(en).toContain(">How-to</h2>");
    expect(en).toContain(">Comparisons</h2>");
  });

  it("links every article with the language-correct URL", () => {
    expect(en).toContain('href="/guides/y"');
    expect(en).toContain('href="/how-to/x"');
    expect(en).toContain('href="/compare/snapdrop"');
    expect(zh).toContain('href="/zh/guides/y"');
  });

  it("sets canonical + hreflang for the hub", () => {
    expect(en).toContain('<link rel="canonical" href="https://relayium.com/guides" />');
    expect(en).toContain('href="https://relayium.com/zh/guides"');
  });

  it("skips an empty category", () => {
    const html = renderGuidesIndexPage({
      lang: "en", doc: guidesIndex.langs.en,
      groups: { guides: [], howTo: [{ slug: "how-to/x", title: "Howto X" }], compare: [] },
    });
    expect(html).not.toContain(">Guides</h2>");
    expect(html).not.toContain(">Comparisons</h2>");
    expect(html).toContain(">How-to</h2>");
  });
});
