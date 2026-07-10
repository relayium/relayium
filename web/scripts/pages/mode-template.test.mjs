import { describe, it, expect } from "vitest";
import { buildModePages } from "./build-pages.mjs";

const fixture = {
  updated: "2026-07-10",
  langs: Object.fromEntries(["zh", "ja", "ko", "de", "fr"].map((l) => [l, {
    title: `T-${l}`, description: `D-${l}`,
    hero: { h1: `H-${l}`, pitch: `P-${l}`, cta: `C-${l}` },
    how: { heading: `how-${l}`, steps: [`s1-${l}`] },
    why: { heading: `why-${l}`, items: [{ title: `wt-${l}`, desc: `wd-${l}` }] },
    compare: { heading: `cmp-${l}`, items: [{ title: `ct-${l}`, body: `cb-${l}` }] },
    faq: { heading: `faq-${l}`, items: [{ q: `q-${l}`, a: `a-${l}` }] },
    learnHeading: `learn-${l}`,
    footer: { privacy: "P", terms: "T", security: "S" },
  }])),
};

describe("buildModePages", () => {
  const pages = buildModePages(fixture, { slug: "cross-network" });

  it("emits 5 localized pages, NO english static page", () => {
    const paths = pages.map((p) => p.path).sort();
    expect(paths).toEqual([
      "de/cross-network/index.html", "fr/cross-network/index.html",
      "ja/cross-network/index.html", "ko/cross-network/index.html",
      "zh/cross-network/index.html",
    ]);
    expect(paths).not.toContain("cross-network/index.html"); // english is the SPA route
  });

  it("zh page: self-canonical + hreflang cluster incl english SPA route + x-default + JSON-LD", () => {
    const zh = pages.find((p) => p.path === "zh/cross-network/index.html").html;
    expect(zh).toContain('<link rel="canonical" href="https://relayium.com/zh/cross-network" />');
    expect(zh).toContain('hreflang="en" href="https://relayium.com/cross-network"');       // SPA route
    expect(zh).toContain('hreflang="x-default" href="https://relayium.com/cross-network"');
    expect(zh).toContain('hreflang="ja" href="https://relayium.com/ja/cross-network"');
    expect(zh).toContain('"@type":"FAQPage"');
    expect(zh).toContain('<html lang="zh"');
  });

  it("CTA links to the SPA mode route with language preset", () => {
    const de = pages.find((p) => p.path === "de/cross-network/index.html").html;
    expect(de).toContain('href="/cross-network?lang=de"');
  });
});
