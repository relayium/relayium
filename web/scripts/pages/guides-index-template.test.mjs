import { describe, it, expect } from "vitest";
import { renderGuidesIndexPage } from "./guides-index-template.mjs";
import guidesIndex from "./content/guides-index.mjs";

const TEXT_WORD = {
  en: /\btext\b/i, zh: /文本/, ja: /テキスト/, ko: /텍스트/, de: /Text/,
  fr: /texte/i, ar: /(?<!م)نص/, es: /texto/i, pt: /texto/i,
};

// Keyed by the five taxonomy groups the hub renders (content/taxonomy.mjs), not
// by URL prefix — the prefix is an address, the group is a reading order.
const groups = {
  scenario: [{ slug: "how-to/x", title: "Howto X" }],
  cli: [{ slug: "guides/y", title: "Guide Y" }],
  selfhost: [{ slug: "guides/z", title: "Guide Z" }],
  concept: [{ slug: "guides/w", title: "Guide W" }],
  compare: [{ slug: "compare/snapdrop", title: "vs Snapdrop" }],
};

describe("renderGuidesIndexPage", () => {
  const en = renderGuidesIndexPage({ lang: "en", doc: guidesIndex.langs.en, groups });
  const zh = renderGuidesIndexPage({ lang: "zh", doc: guidesIndex.langs.zh, groups });

  it("renders the H1 and all five group headings", () => {
    expect(en).toContain("<h1>Guides</h1>");
    // Three groups are headings only. The two that have a page of their own link
    // to it, which is the only inbound link those roots have and the difference
    // between indexed and "Discovered - currently not indexed".
    for (const h of ["Command line", "Self-hosting &amp; operations", "How it works &amp; safety"]) {
      expect(en, h).toContain(`<h2>${h}</h2>`);
    }
    expect(en).toContain('<h2><a href="/how-to/">Everyday transfers</a></h2>');
    expect(en).toContain('<h2><a href="/compare/">Comparisons</a></h2>');
    // And the labels are distinguishable in Chinese, which is the defect that
    // prompted the regrouping: 教程 and 操作指南 were synonyms.
    expect(zh).toContain('<h2><a href="/zh/how-to/">场景教程</a></h2>');
    expect(zh).toContain("<h2>命令行</h2>");
  });

  it("links every article with the language-correct URL", () => {
    expect(en).toContain('href="/guides/y/"');
    expect(en).toContain('href="/guides/z/"');
    expect(en).toContain('href="/guides/w/"');
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
      groups: { scenario: [{ slug: "how-to/x", title: "Howto X" }], cli: [], selfhost: [], concept: [], compare: [] },
    });
    expect(html).not.toContain(">Command line</h2>");
    expect(html).not.toContain('href="/compare/"');
    expect(html).not.toContain(">Comparisons</h2>");
    expect(html).toContain('<h2><a href="/how-to/">Everyday transfers</a></h2>');
  });
});
