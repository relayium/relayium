import { describe, it, expect } from "vitest";
import { renderLegalPage } from "./legal-template.mjs";
import { urlPath, absUrl } from "./shared.mjs";

const doc = {
  title: "Privacy Policy",
  description: "How Relayium handles data.",
  updatedLabel: "Last updated",
  updated: "2026-06-29",
  otherDocLabel: "Terms of Service",
  lead: ["Relayium is privacy-first."],
  sections: [{ heading: "What we never collect", body: ["No file contents."], bullets: ["File names", "Keys"] }],
};

describe("renderLegalPage", () => {
  const html = renderLegalPage({ slug: "privacy", lang: "en", doc });

  it("sets the document title and meta description", () => {
    expect(html).toContain("<title>Privacy Policy · Relayium</title>");
    expect(html).toContain('name="description" content="How Relayium handles data."');
  });

  it("uses the BCP-47 html lang for the language", () => {
    const zh = renderLegalPage({ slug: "privacy", lang: "zh", doc });
    expect(zh).toContain('<html lang="zh-Hans">');
  });

  it("emits a self-referencing canonical and an x-default alternate", () => {
    expect(html).toContain(`<link rel="canonical" href="${absUrl(urlPath("privacy", "en"))}" />`);
    expect(html).toContain(`hreflang="x-default" href="${absUrl(urlPath("privacy", "en"))}"`);
  });

  it("emits an hreflang alternate for each maintained language, and no others", () => {
    expect(html).toContain(`hreflang="zh-Hans" href="${absUrl(urlPath("privacy", "zh"))}"`);
    expect(html).toContain(`hreflang="en" href="${absUrl(urlPath("privacy", "en"))}"`);
    for (const [lang, code] of [["ja","ja"],["ko","ko"],["de","de"],["fr","fr"],["ar","ar"],["es","es"],["pt","pt"]]) {
      expect(html, `${lang} must not be in the maintained cluster`)
        .not.toContain(`hreflang="${code}"`);
      // …and the archived URL itself must not appear in the head at all: an
      // alternate is a claim about the current site, and this one is archived.
      expect(html, `${lang} URL must not be an alternate`)
        .not.toContain(absUrl(urlPath("privacy", lang)));
    }
  });

  it("renders headings, paragraphs, bullets and the last-updated line", () => {
    expect(html).toContain("<h1>Privacy Policy</h1>");
    // <bdi> around the date is load-bearing, not markup noise: see the comment
    // at the template's `class="updated"` line and the Arabic case in
    // rtl-head-isolation.test.mjs.
    expect(html).toContain("Last updated: <bdi>2026-06-29</bdi>");
    expect(html).toContain("<h2>What we never collect</h2>");
    expect(html).toContain("<li>File names</li>");
  });

  it("escapes user-visible text", () => {
    const evil = renderLegalPage({ slug: "privacy", lang: "en", doc: { ...doc, title: "A & B <x>" } });
    expect(evil).toContain("<title>A &amp; B &lt;x&gt; · Relayium</title>");
  });

  it("contains no 'draft' wording", () => {
    expect(html.toLowerCase()).not.toContain("draft");
  });
});

// The share card. Legal pages were the one generated template without it, so a
// pasted /privacy/ link unfurled as a bare URL. The block mirrors
// article-template.mjs — same tags, same order, same image — and every string
// in it is one the page already had: its own title and description.
describe("renderLegalPage share-card meta", () => {
  const zhDoc = { ...doc, title: "隐私政策", description: "Relayium 如何处理数据。" };
  const en = renderLegalPage({ slug: "privacy", lang: "en", doc });
  const zh = renderLegalPage({ slug: "privacy", lang: "zh", doc: zhDoc });

  /** Every <meta property|name="og:*|twitter:*"> in document order, as [key, content]. */
  function shareMeta(html) {
    return [...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)" \/>/g)]
      .map((m) => [m[1], m[2]]);
  }

  const expected = (lang, title, description, locale) => [
    ["og:type", "website"],
    ["og:site_name", "Relayium"],
    ["og:title", title],
    ["og:description", description],
    ["og:url", absUrl(urlPath("privacy", lang))],
    ["og:image", "https://relayium.com/og-image.jpg"],
    ["og:image:type", "image/jpeg"],
    ["og:image:width", "1200"],
    ["og:image:height", "630"],
    ["og:image:alt", "Relayium — end-to-end encrypted file and text transfer"],
    ["og:locale", locale],
    ["twitter:card", "summary_large_image"],
    ["twitter:title", title],
    ["twitter:description", description],
    ["twitter:image", "https://relayium.com/og-image.jpg"],
  ];

  it("emits the full block for en, in the sibling templates' order", () => {
    expect(shareMeta(en)).toEqual(expected("en", "Privacy Policy", "How Relayium handles data.", "en_US"));
  });

  it("emits the full block for zh-Hans, from the page's own title and description", () => {
    expect(shareMeta(zh)).toEqual(expected("zh", "隐私政策", "Relayium 如何处理数据。", "zh_CN"));
  });

  it("emits each share tag exactly once", () => {
    for (const html of [en, zh]) {
      const keys = shareMeta(html).map(([k]) => k);
      expect(keys.length).toBe(15);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("og:url is the canonical, and every URL in the block is absolute", () => {
    for (const [html, lang] of [[en, "en"], [zh, "zh"]]) {
      const canonical = html.match(/<link rel="canonical" href="([^"]+)" \/>/)[1];
      const meta = Object.fromEntries(shareMeta(html));
      expect(canonical).toBe(absUrl(urlPath("privacy", lang)));
      expect(meta["og:url"]).toBe(canonical);
      for (const key of ["og:url", "og:image", "twitter:image"]) {
        expect(meta[key], key).toMatch(/^https:\/\/relayium\.com\//);
      }
    }
  });

  it("advertises no other locale: no og:locale:alternate", () => {
    // The siblings emit none either. hreflang (tested above) is the only
    // language advertising in the head, and it is the maintained cluster only.
    expect(en).not.toContain("og:locale:alternate");
    expect(zh).not.toContain("og:locale:alternate");
  });

  it("escapes title and description for an attribute context", () => {
    const evil = renderLegalPage({
      slug: "privacy",
      lang: "en",
      doc: { ...doc, title: `A & B <x> "q" 'r'`, description: `"><script>alert(1)</script> & 'z'` },
    });
    const meta = Object.fromEntries(shareMeta(evil));
    const title = "A &amp; B &lt;x&gt; &quot;q&quot; &#39;r&#39;";
    const description = "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;z&#39;";
    expect(meta["og:title"]).toBe(title);
    expect(meta["twitter:title"]).toBe(title);
    expect(meta["og:description"]).toBe(description);
    expect(meta["twitter:description"]).toBe(description);
    // A quote that closed the attribute early would leave the block short or
    // inject an element: the count and the raw-markup check catch both.
    expect(shareMeta(evil).length).toBe(15);
    expect(evil).not.toContain("<script>alert(1)");
  });

  it("keeps the block inside <head>, before the structured data", () => {
    const head = en.slice(en.indexOf("<head>"), en.indexOf("</head>"));
    expect(shareMeta(head).length).toBe(15);
    expect(head.indexOf('name="twitter:image"')).toBeLessThan(head.indexOf("application/ld+json"));
    expect(head.indexOf('property="og:type"')).toBeGreaterThan(head.indexOf('name="theme-color"'));
  });
});
