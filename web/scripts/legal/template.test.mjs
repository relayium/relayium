import { describe, it, expect } from "vitest";
import { renderLegalPage } from "./template.mjs";
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

  it("emits an hreflang alternate for every language", () => {
    for (const [lang, code] of [["zh","zh-Hans"],["ja","ja"],["ko","ko"],["de","de"],["fr","fr"]]) {
      expect(html).toContain(`hreflang="${code}" href="${absUrl(urlPath("privacy", lang))}"`);
    }
  });

  it("renders headings, paragraphs, bullets and the last-updated line", () => {
    expect(html).toContain("<h1>Privacy Policy</h1>");
    expect(html).toContain("Last updated: 2026-06-29");
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
