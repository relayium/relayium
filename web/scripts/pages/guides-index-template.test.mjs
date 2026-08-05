import { describe, it, expect } from "vitest";
import { renderGuidesIndexPage } from "./guides-index-template.mjs";
import guidesIndex from "./content/guides-index.mjs";

const TEXT_WORD = {
  en: /\btext\b/i, zh: /文本/, ja: /テキスト/, ko: /텍스트/, de: /Text/,
  fr: /texte/i, ar: /(?<!م)نص/, es: /texto/i, pt: /texto/i,
};

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
    // The Guides group is the hub's own content and stays plain text; the two
    // category groups link to their roots, which is the only inbound link those
    // roots have and the difference between indexed and "Discovered - currently
    // not indexed".
    expect(en).toContain(">Guides</h2>");
    expect(en).toContain('<h2><a href="/how-to/">How-to</a></h2>');
    expect(en).toContain('<h2><a href="/compare/">Comparisons</a></h2>');
    expect(zh).toContain('<h2><a href="/zh/how-to/">操作指南</a></h2>');
  });

  it("links every article with the language-correct URL", () => {
    expect(en).toContain('href="/guides/y/"');
    expect(en).toContain('href="/how-to/x/"');
    expect(en).toContain('href="/compare/snapdrop/"');
    expect(zh).toContain('href="/zh/guides/y/"');
  });

  it("sets canonical + hreflang for the hub", () => {
    expect(en).toContain('<link rel="canonical" href="https://relayium.com/guides/" />');
    expect(en).toContain('href="https://relayium.com/zh/guides/"');
  });

  it("positions the guides hub as files plus online-only ephemeral text in every language", () => {
    for (const [lang, doc] of Object.entries(guidesIndex.langs)) {
      expect(doc.description, `${lang} description`).toMatch(TEXT_WORD[lang]);
      expect(doc.intro, `${lang} intro`).toMatch(TEXT_WORD[lang]);
    }
    expect(guidesIndex.langs.en.description).toMatch(/both devices are online/i);
  });

  it("skips an empty category", () => {
    const html = renderGuidesIndexPage({
      lang: "en", doc: guidesIndex.langs.en,
      groups: { guides: [], howTo: [{ slug: "how-to/x", title: "Howto X" }], compare: [] },
    });
    expect(html).not.toContain(">Guides</h2>");
    expect(html).not.toContain('href="/compare/"');
    expect(html).not.toContain(">Comparisons</h2>");
    expect(html).toContain('<h2><a href="/how-to/">How-to</a></h2>');
  });
});
