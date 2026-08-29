// web/scripts/pages/maintained-frozen-split.test.mjs — the 2026-08-14 language
// freeze, asserted where it is actually visible: in the generated HTML.
//
// The decision has two halves that pull against each other, and the value of
// this file is that it pins BOTH, so satisfying one by breaking the other
// fails here rather than in production.
//
//   1. The product offers English and Simplified Chinese. Every language
//      selector, every hreflang cluster and every "also available in" line shows
//      exactly those two, in the app and in the ~450 generated pages alike.
//   2. The seven already-published translations stay public. They keep their
//      URLs, their `index, follow`, their sitemap entries and their internal
//      links — and each one says on the page that it is an archive and where its
//      current version is.
//
// site-graph.test.mjs owns the whole-graph half (no maintained page links into
// the archive; no archived page is a dead end). This file owns the per-template
// half: every family renders the notice, and none of them renders a selector
// that offers a language the product does not have.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAllPages } from "../gen-pages.mjs";
import {
  LANGS, MAINTAINED_LANGS, FROZEN_LANGS, isMaintained, isFrozen,
  BCP47, archiveNotice, ARCHIVE_COPY, ARCHIVE_STYLE, ctaHref, urlPath, landingUrl,
  PRICING_URL, pricingLabel,
} from "./shared.mjs";

const pages = buildAllPages();

/** The frozen locale a generated path belongs to, or null for a maintained one. */
function frozenLangOf(path) {
  return FROZEN_LANGS.find((l) => path === `${l}/index.html` || path.startsWith(`${l}/`)) ?? null;
}

/**
 * One rendered page per template family, in a frozen locale and in a maintained
 * one. Named after the templates rather than the URLs, because the thing that
 * can silently lose the notice is a template, not a page.
 */
const FAMILY = {
  landing: ["ja/index.html", "zh/index.html"],
  article: ["de/compare/snapdrop/index.html", "compare/snapdrop/index.html"],
  "guides-index": ["ko/guides/index.html", "guides/index.html"],
  "category-index": ["pt/how-to/index.html", "zh/how-to/index.html"],
  legal: ["ar/privacy/index.html", "privacy/index.html"],
  releases: ["es/releases/index.html", "releases/index.html"],
  mode: ["fr/cross-network/index.html", "zh/cross-network/index.html"],
};

const byPath = new Map(pages.map((p) => [p.path, p.html]));

describe("the two sets are disjoint, complete and agreed on by both builds", () => {
  it("partitions the nine generated languages into maintained and frozen", () => {
    expect([...MAINTAINED_LANGS, ...FROZEN_LANGS].sort()).toEqual([...LANGS].sort());
    expect(MAINTAINED_LANGS.filter((l) => FROZEN_LANGS.includes(l))).toEqual([]);
    for (const l of MAINTAINED_LANGS) {
      expect(isMaintained(l), l).toBe(true);
      expect(isFrozen(l), l).toBe(false);
    }
    for (const l of FROZEN_LANGS) {
      expect(isFrozen(l), l).toBe(true);
      expect(isMaintained(l), l).toBe(false);
    }
  });

  it("agrees with the app's own maintained set", () => {
    // Two builds, one decision. The generated pages read shared.mjs and the app
    // reads src/lib/i18n/types.ts; if they drift, the static page and the SPA
    // that replaces it after boot offer different languages at the same URL.
    // Read as source text because types.ts is app TypeScript and cannot be
    // imported into the vite-config program (the same reason shells.test.mjs
    // compares its titles as strings).
    const src = readFileSync(resolve(process.cwd(), "src/lib/i18n/types.ts"), "utf8");
    const union = /export type Lang = ([^;]+);/.exec(src)?.[1];
    expect(union, "Lang must stay greppable — this guard reads it").toBeTruthy();
    const appLangs = [...union.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort();
    expect(appLangs).toEqual([...MAINTAINED_LANGS].sort());

    const frozenType = /export type FrozenLang = ([^;]+);/.exec(src)?.[1];
    expect(frozenType, "FrozenLang must stay greppable").toBeTruthy();
    expect([...frozenType.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]).sort())
      .toEqual([...FROZEN_LANGS].sort());
  });
});

describe("the archived-translation notice, per template family", () => {
  it.each(Object.keys(FAMILY))("%s renders it on the archived page", (family) => {
    const [frozenPath] = FAMILY[family];
    const html = byPath.get(frozenPath);
    expect(html, `${frozenPath} is not generated`).toBeTruthy();
    const lang = frozenLangOf(frozenPath);

    // The notice itself: one named complementary region, a label, the sentence,
    // and the two links. Asserted as structure rather than as a substring so a
    // half-rendered notice (label present, links dropped) cannot pass.
    const aside = /<aside class="archived" aria-label="([^"]+)">([\s\S]*?)<\/aside>/.exec(html);
    expect(aside, `${frozenPath} has no archive notice`).toBeTruthy();
    expect(aside[1].length, "the notice needs an accessible name").toBeGreaterThan(0);
    expect(aside[2], "the notice needs its own visible label").toContain('class="archived-label"');
    expect(aside[2]).toMatch(/<p>[^<]{40,}<\/p>/); // the disclosure sentence, not a stub

    // It is written in the reader's language, not in English. A German page with
    // an English notice is the failure this whole batch exists to avoid, one
    // level down.
    expect(aside[1], `${lang} notice is not localized`).not.toMatch(/^Archived translation$/);

    // Both maintained twins, each marked with the language it leads to.
    expect(aside[2]).toMatch(/<a href="\/[^"]*" lang="en" hreflang="en"><bdi>English<\/bdi><\/a>/);
    expect(aside[2]).toMatch(/<a href="\/zh\/[^"]*" lang="zh-Hans" hreflang="zh-Hans"><bdi>中文<\/bdi><\/a>/);

    // The pricing pointer, per family rather than per locale: what silently
    // loses it is a template that stopped calling archiveNotice for one of its
    // page kinds, and that is invisible to a locale-indexed check.
    const pricing = /<p class="[^"]*\barchived-pricing\b[^"]*">([\s\S]*?)<\/p>/.exec(aside[2]);
    expect(pricing, `${frozenPath} states no pricing pointer`).toBeTruthy();
    // Sentence, link, sentence — not a bare link, and not a sentence with the
    // link stripped out of it. Both degraded forms render without error.
    expect(pricing[1], `${lang} pricing pointer has no prose`).toMatch(/^[^<]{20,}/);
    expect(pricing[1], `${lang} pricing pointer misses the maintained target`)
      .toContain(`<a href="${PRICING_URL}">`);
    // In this locale's own words, using the label its own footer already uses.
    expect(pricing[1], `${lang} pricing pointer is not localized`)
      .toContain(`>${pricingLabel(lang)}</a>`);
    expect(pricing[1], `${lang} pricing pointer ends mid-sentence`).toMatch(/<\/a>[^<]+$/);

    // …and the stylesheet that draws it, emitted only where it is used.
    expect(html).toContain(ARCHIVE_STYLE.trim().split("\n")[0]);
  });

  it.each(Object.keys(FAMILY))("%s renders no notice on the maintained page", (family) => {
    const [, maintainedPath] = FAMILY[family];
    const html = byPath.get(maintainedPath);
    expect(html, `${maintainedPath} is not generated`).toBeTruthy();
    expect(html, "a maintained page is not an archive").not.toContain('class="archived"');
    expect(html, "and must not carry the archive stylesheet either")
      .not.toContain(ARCHIVE_STYLE.trim().split("\n")[0]);
  });

  it("points each notice at the same page, not at the homepage", () => {
    // The failure this catches is the cheap version of the fix: a notice that
    // links "English" to "/" from every archived page. That is a dead end with
    // extra steps — the reader wanted THIS page in a language they read.
    const missing = [];
    for (const [family, [frozenPath]] of Object.entries(FAMILY)) {
      const html = byPath.get(frozenPath);
      const lang = frozenLangOf(frozenPath);
      const rest = frozenPath.replace(new RegExp(`^${lang}/`), "").replace(/index\.html$/, "");
      const wantZh = `/zh/${rest}`;
      if (!html.includes(`<a href="${wantZh}" lang="zh-Hans"`)) missing.push(`${family}: want ${wantZh}`);
    }
    expect(missing).toEqual([]);
  });

  it("covers every template family that generates an archived page", () => {
    // Guards the guard. A seventh template added without a FAMILY entry would
    // ship archived pages with no notice and nothing would say so.
    const covered = new Set(Object.values(FAMILY).map(([frozen]) => frozen));
    const uncovered = pages
      .filter((p) => frozenLangOf(p.path) && !p.html.includes('class="archived"'))
      .map((p) => p.path);
    expect(uncovered, "every archived page must carry the notice").toEqual([]);
    expect(covered.size, "each family needs a representative").toBe(Object.keys(FAMILY).length);
  });
});

describe("archiveNotice itself", () => {
  it("returns nothing for a maintained language", () => {
    for (const l of MAINTAINED_LANGS) {
      expect(archiveNotice(l, { en: "/x/", zh: "/zh/x/" }), l).toBe("");
    }
  });

  it("refuses to render half a notice", () => {
    // A notice with one link is worse than none: it reads as "your language is
    // gone, and here is the one language we decided you read".
    expect(() => archiveNotice("ja", { en: "/x/" })).toThrow(/both maintained twins/);
    expect(() => archiveNotice("ja", { zh: "/zh/x/" })).toThrow(/both maintained twins/);
    expect(() => archiveNotice("ja", undefined)).toThrow(/both maintained twins/);
  });

  it("refuses to render a notice whose pricing pointer is missing", () => {
    // Registry drift, fail-closed. A locale added to ARCHIVE_COPY with a label,
    // a body and a lead but no `pricing` entry would otherwise ship a notice
    // that says "details may differ" over a page quoting a retired free tier —
    // a half-disclosure on 50 pages that no template author would ever see.
    const { pricing, ...withoutPricing } = ARCHIVE_COPY.ja;
    const spliced = { ...ARCHIVE_COPY, ja: withoutPricing };
    // Mutate the module's own table rather than a copy: archiveNotice reads
    // ARCHIVE_COPY directly, so a guard applied to a clone proves nothing.
    ARCHIVE_COPY.ja = withoutPricing;
    try {
      expect(() => archiveNotice("ja", { en: "/x/", zh: "/zh/x/" })).toThrow(/pricing pointer/);
      for (const half of [{ before: "x" }, { after: "y" }, {}]) {
        ARCHIVE_COPY.ja = { ...withoutPricing, pricing: half };
        expect(() => archiveNotice("ja", { en: "/x/", zh: "/zh/x/" }), JSON.stringify(half))
          .toThrow(/pricing pointer/);
      }
    } finally {
      ARCHIVE_COPY.ja = { ...withoutPricing, pricing };
    }
    expect(Object.keys(spliced).sort()).toEqual([...FROZEN_LANGS].sort());
    expect(archiveNotice("ja", { en: "/x/", zh: "/zh/x/" }), "the table must be restored")
      .toContain(`<a href="${PRICING_URL}">`);
  });

  it("has copy for every frozen language and for no other", () => {
    for (const l of FROZEN_LANGS) {
      expect(archiveNotice(l, { en: "/", zh: "/zh/" }), l).toContain('<aside class="archived"');
    }
    expect(archiveNotice("klingon", { en: "/", zh: "/zh/" })).toBe("");
  });

  it("escapes the accessible name", () => {
    // aria-label is an attribute; an unescaped quote in one locale's label would
    // break out of it.
    const html = archiveNotice("fr", { en: '/x"/', zh: "/zh/x/" });
    expect(html.match(/aria-label="([^"]*)"/)[1]).not.toContain('"');
  });
});

describe("no generated page offers a language the product does not have", () => {
  it("renders language bars with exactly the maintained languages", () => {
    const bars = pages.flatMap((p) =>
      [...p.html.matchAll(/<nav class="langbar"[^>]*>([\s\S]*?)<\/nav>/g)].map((m) => [p.path, m[1]]),
    );
    // Every maintained page except the three mode pages, which have never had a
    // bar (their English twin is the SPA route), and 404.html, which is not a
    // page in a language. Pinned as a count, not a floor: "some page still has a
    // selector" would pass with one.
    const noBar = new Set([
      "zh/cross-network/index.html", "zh/offline-transfer/index.html", "zh/apps/index.html",
      "404.html",
    ]);
    const maintainedPages = pages.filter((p) => !frozenLangOf(p.path) && !noBar.has(p.path));
    expect(bars.length, "every maintained non-mode page keeps its selector").toBe(maintainedPages.length);
    const wrong = bars
      .map(([path, bar]) => [path, [...bar.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])])
      .filter(([, hrefs]) => hrefs.length !== MAINTAINED_LANGS.length);
    expect(wrong.map(([path, hrefs]) => `${path}: ${hrefs.join(" ")}`)).toEqual([]);
  });

  it("puts no language bar on an archived page", () => {
    // The archived page's selector is the notice. A langbar as well would offer
    // a reader the choice of two languages while they are standing in a third.
    const withBar = pages
      .filter((p) => frozenLangOf(p.path) && p.html.includes('class="langbar"'))
      .map((p) => p.path);
    expect(withBar).toEqual([]);
  });

  it("declares an hreflang cluster of exactly en + zh + x-default, or none", () => {
    const wrong = [];
    for (const p of pages) {
      const codes = [...p.html.matchAll(/<link rel="alternate" hreflang="([^"]+)"/g)].map((m) => m[1]);
      if (frozenLangOf(p.path)) {
        if (codes.length) wrong.push(`${p.path}: archived page declares ${codes.join(",")}`);
      } else if (codes.length && codes.join(",") !== `${BCP47.en},${BCP47.zh},x-default`) {
        wrong.push(`${p.path}: ${codes.join(",")}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("keeps the SPA's own head in step with the generated pages", () => {
    // index.html ships one cluster and page-meta.ts rewrites it after boot. Two
    // answers at one URL is the exact drift the /device-inbox status constant
    // produced in 2026-08-11; this pins all three copies to one set.
    const index = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
    const codes = [...index.matchAll(/<link rel="alternate" hreflang="([^"]+)"/g)].map((m) => m[1]);
    expect(codes).toEqual([BCP47.en, BCP47.zh, "x-default"]);
    const ogAlts = [...index.matchAll(/og:locale:alternate" content="([^"]+)"/g)].map((m) => m[1]);
    expect(ogAlts).toEqual(["zh_CN"]);

    const meta = readFileSync(resolve(process.cwd(), "src/lib/page-meta.ts"), "utf8");
    const prefixes = /const HREFLANG_PREFIX: \[string, string\]\[\] = \[([\s\S]*?)\];/.exec(meta)?.[1];
    expect(prefixes, "HREFLANG_PREFIX must stay greppable").toBeTruthy();
    expect([...prefixes.matchAll(/\["([^"]+)",/g)].map((m) => m[1]))
      .toEqual([BCP47.en, BCP47.zh, "x-default"]);
  });
});

describe("archived pages stay reachable and stop promising a localized app", () => {
  it("keeps every archived page indexable and self-canonical", () => {
    const bad = [];
    for (const p of pages) {
      const lang = frozenLangOf(p.path);
      if (!lang) continue;
      if (!p.html.includes('content="index, follow"')) bad.push(`${p.path}: not indexable`);
      const canonical = /<link rel="canonical" href="https:\/\/relayium\.com([^"]*)"/.exec(p.html)?.[1];
      const want = "/" + p.path.replace(/index\.html$/, "");
      if (canonical !== want) bad.push(`${p.path}: canonical ${canonical} ≠ ${want}`);
    }
    expect(bad).toEqual([]);
  });

  it("sends an archived page's app CTA to the plain SPA, with no lang preset", () => {
    for (const l of FROZEN_LANGS) expect(ctaHref(l), l).toBe("/");
    for (const l of MAINTAINED_LANGS) {
      expect(ctaHref(l), l).toBe(l === "en" ? "/" : `/?lang=${l}`);
    }
    const withPreset = pages
      .filter((p) => frozenLangOf(p.path) && /href="[^"]*\?lang=/.test(p.html))
      .map((p) => p.path);
    expect(withPreset).toEqual([]);
  });

  it("still declares each archived page in its own language", () => {
    // The archive is an archive, not a redirect: the document keeps its own
    // `lang` (and Arabic keeps its `dir`), or a screen reader reads Japanese
    // prose with an English voice.
    for (const [family, [frozenPath]] of Object.entries(FAMILY)) {
      const lang = frozenLangOf(frozenPath);
      expect(byPath.get(frozenPath), `${family} lost its lang attribute`)
        .toContain(`<html lang="${BCP47[lang]}"`);
    }
    expect(byPath.get("ar/privacy/index.html"), "Arabic keeps its direction").toContain('dir="rtl"');
  });

  it("still generates all nine languages", () => {
    // The freeze is not a deletion. If a future change stops generating the
    // seven, ~250 indexed URLs 404 and every assertion above passes vacuously.
    const langs = new Set(pages.map((p) => frozenLangOf(p.path)).filter(Boolean));
    expect([...langs].sort()).toEqual([...FROZEN_LANGS].sort());
    expect(pages.length).toBeGreaterThan(400);
  });
});

describe("the twin URLs the notice links are the ones that are served", () => {
  it("resolves every notice link to a generated page or an English SPA route", () => {
    const served = new Set([
      ...pages.map((p) => "/" + p.path.replace(/index\.html$/, "")),
      // The English SPA routes, which are served but never generated. PRICING_URL
      // rather than the literal "/pricing": the notice's pricing pointer is the
      // third destination in the aside, and a constant that moved without this
      // set moving with it is exactly the dead link this test exists to catch.
      "/", "/apps", "/cross-network", "/offline-transfer", PRICING_URL,
    ]);
    const dead = [];
    for (const p of pages) {
      const aside = /<aside class="archived"[\s\S]*?<\/aside>/.exec(p.html)?.[0];
      if (!aside) continue;
      for (const m of aside.matchAll(/<a href="([^"]+)"/g)) {
        if (!served.has(m[1])) dead.push(`${p.path} → ${m[1]}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it("builds those URLs from the same helpers the rest of the site uses", () => {
    // Not a second URL shape. urlPath/landingUrl own the trailing-slash rule
    // that keeps ~390 URLs out of Search Console's "Page with redirect" bucket.
    expect(urlPath("privacy", "zh")).toBe("/zh/privacy/");
    expect(urlPath("apps", "en")).toBe("/apps");
    expect(landingUrl("en")).toBe("/");
    expect(landingUrl("zh")).toBe("/zh/");
  });
});
