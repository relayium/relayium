// web/scripts/pages/archived-pricing-pointer.test.mjs — the archived corpus
// quotes plans, quotas and retention windows that predate the paid tiers, so
// every archived page has to name the one surface that is current.
//
// The other two files own the neighbouring halves and are not duplicated here:
// pricing-label.test.mjs pins the LABEL against the app's own, and
// maintained-frozen-split.test.mjs pins that each template FAMILY renders a
// notice at all. What is left, and what this file owns, is the pointer itself —
// the sentence, its target, and the corpus-wide claim that it is on every page
// that needs it.
//
// Five failures must be impossible, and each has a test below:
//
//   1. one frozen locale silently missing its pointer;
//   2. the pointer aimed somewhere other than the maintained pricing page;
//   3. a notice that renders with the disclosure stripped out of it;
//   4. registry drift — a locale set that no longer matches FROZEN_LANGS;
//   5. a page making a totalizing price claim while carrying no pointer.
//
// (5) is the one that needs a corpus scan, and the scan is here rather than in
// a comment in shared.mjs for a reason: any count of "pages that talk about
// price" is a function of the pattern used, so the pattern has to be committed
// next to the number. PRICE_CLAIM below is that pattern, MEASURED is what it
// currently matches, and the test fails if either the coverage or the corpus
// itself collapses.
import { describe, expect, it } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildAllPages } from "../gen-pages.mjs";
import {
  FROZEN_LANGS, MAINTAINED_LANGS, LANGS, ARCHIVE_COPY, archiveNotice,
  PRICING_URL, PRICING_LABELS, pricingLabel, esc,
} from "./shared.mjs";

const pages = buildAllPages();
const TWINS = { en: "/x/", zh: "/zh/x/" };

/** The frozen locale a generated path belongs to, or null for a maintained one. */
function frozenLangOf(path) {
  return FROZEN_LANGS.find((l) => path === `${l}/index.html` || path.startsWith(`${l}/`)) ?? null;
}

/** The archive notice of a rendered page, or null. */
const asideOf = (html) => /<aside class="archived"[\s\S]*?<\/aside>/.exec(html)?.[0] ?? null;

/** The pointer paragraph inside a notice, or null. */
const pointerOf = (aside) =>
  /<p class="[^"]*\barchived-pricing\b[^"]*">([\s\S]*?)<\/p>/.exec(aside ?? "")?.[1] ?? null;

describe("every frozen locale states the pointer, in its own words", () => {
  it("has a pricing sentence for exactly the frozen languages", () => {
    // (1) and (4) together. Set equality, not containment: a locale added to
    // ARCHIVE_COPY without a pointer, and a locale that left FROZEN_LANGS while
    // keeping its archive copy, are both drift and both fail here.
    expect(Object.keys(ARCHIVE_COPY).sort()).toEqual([...FROZEN_LANGS].sort());
    for (const lang of FROZEN_LANGS) {
      const { pricing } = ARCHIVE_COPY[lang];
      expect(pricing, `${lang} has no pricing pointer`).toBeTruthy();
      // Prose on both sides of the link. A pointer that is only a bare link is
      // the degraded form that still renders and still reads as decoration.
      expect(pricing.before.trim().length, `${lang} pointer opens with nothing`).toBeGreaterThan(15);
      expect(pricing.after.trim().length, `${lang} pointer ends mid-sentence`).toBeGreaterThan(0);
    }
    for (const lang of MAINTAINED_LANGS) {
      expect(ARCHIVE_COPY[lang], `${lang} is maintained and needs no archive copy`).toBeUndefined();
    }
  });

  it("renders sentence, link and sentence for every frozen locale", () => {
    // (3). Asserted as an ordered structure rather than as three independent
    // substrings, because "the label is somewhere in the notice" is exactly what
    // a stripped disclosure with an intact footer would also satisfy.
    for (const lang of FROZEN_LANGS) {
      const pointer = pointerOf(archiveNotice(lang, TWINS));
      expect(pointer, `${lang} renders no pointer`).toBeTruthy();
      const shape = new RegExp(
        `^([^<]{15,})<a href="${PRICING_URL}">([^<]+)</a>([^<]*)$`,
      ).exec(pointer);
      expect(shape, `${lang} pointer is not prose-link-prose: ${pointer}`).toBeTruthy();
      expect(shape[1]).toBe(esc(ARCHIVE_COPY[lang].pricing.before));
      expect(shape[2], `${lang} does not use its own footer's word`).toBe(esc(pricingLabel(lang)));
      expect(shape[3]).toBe(esc(ARCHIVE_COPY[lang].pricing.after));
    }
  });

  it("points at the maintained pricing route the app actually serves", () => {
    // (2). Not `expect(PRICING_URL).toBe("/pricing")`, which only restates the
    // constant. The app owns the route; if PRICING_PATH moves and this pointer
    // does not, all 350 archived pages send readers to a 404 for the one detail
    // they were told to go and check.
    const router = readFileSync(resolve(process.cwd(), "src/lib/router.svelte.ts"), "utf8");
    const path = /export const PRICING_PATH = "([^"]+)";/.exec(router)?.[1];
    expect(path, "PRICING_PATH must stay greppable — this guard reads it").toBeTruthy();
    expect(PRICING_URL, "the archive pointer and the SPA route are one destination").toBe(path);
    // …and it is the maintained page, not an archived twin of it. A pointer to
    // /ja/pricing/ would be a stale page citing a stale page.
    for (const lang of FROZEN_LANGS) {
      expect(archiveNotice(lang, TWINS)).not.toContain(`href="/${lang}/pricing`);
    }
  });

  it("points rather than restates", () => {
    // The fix must not become the defect. Repeating today's tiers in seven
    // frozen languages would create seven more copies to go stale, so the
    // sentence carries no number, currency or tier name at all.
    for (const lang of FROZEN_LANGS) {
      const { before, after } = ARCHIVE_COPY[lang].pricing;
      const text = before + after;
      expect(text, `${lang} pointer quotes a figure`).not.toMatch(/[0-9٠-٩]/);
      expect(text, `${lang} pointer quotes a currency`).not.toMatch(/[$€£¥₩]|USD|EUR|CNY/i);
      expect(text, `${lang} pointer names a tier`).not.toMatch(/\b(free|plus|pro|max|team)\b/i);
    }
  });

  it("writes French with the no-break space its typography requires", () => {
    // shared.mjs sits outside register-glossary.test.mjs's corpus (that file
    // reads content/**), so the one register rule this new copy can break has
    // to be checked where the copy lives. A plain space before ";" lets the
    // mark wrap alone onto the next line.
    const { before, after } = ARCHIVE_COPY.fr.pricing;
    expect(before + after, "fr: missing no-break space before ; ! ?")
      .not.toMatch(/[^ ][;!?](\s|$)/);
  });
});

// ── (5) the corpus half ──────────────────────────────────────────────────────
//
// Per-locale patterns for a TOTALIZING price claim: prose asserting the product
// as a whole is free, or naming a plan/quota/retention window in the present
// tense. Deliberately the narrow reading — "free", not every "GB" — because a
// pattern that matches a byte count matches nearly every page and would make
// the coverage assertion below vacuous.
const PRICE_CLAIM = {
  ja: /完全に無料|完全無料|すべて無料|無料で/,
  ko: /완전히 무료|완전 무료|모두 무료|무료로/,
  de: /völlig kostenlos|vollständig kostenlos|komplett kostenlos|kostenlos/,
  fr: /entièrement gratuit|totalement gratuit|gratuitement|gratuit/,
  ar: /مجاني تمامًا|مجانًا تمامًا|مجاني بالكامل|مجان/,
  es: /totalmente gratis|completamente gratis|gratis|gratuito/,
  pt: /totalmente grátis|completamente grátis|grátis|gratuito/,
};

/**
 * What PRICE_CLAIM matched when it was last run, per locale, over the generated
 * pages with the notice itself removed.
 *
 * This is not decoration and it is not a target. It is the executable answer to
 * "how much of the archive is this pointer for", and it is pinned as a FLOOR so
 * that a content change, a broken glob or a locale that stopped generating
 * cannot turn the coverage assertion below into a test over zero pages. The
 * numbers move only when someone re-runs the scan and says why.
 *
 * Last re-run in this batch: 156 of the 350 archived pages match, i.e. under
 * half the corpus, not most of it. That figure is a property of PRICE_CLAIM
 * above and of nothing else — it is recorded because a bare per-locale table
 * invites a reader to round it up, and the pointer's justification does not
 * depend on the number being large. The unconditional coverage the notice
 * actually ships is asserted by "carries it on every OTHER archived page too".
 */
const MEASURED = { ja: 22, ko: 11, de: 24, fr: 26, ar: 28, es: 25, pt: 20 };

/** A page's prose with the archive notice removed, so it cannot match itself. */
const withoutNotice = (html) =>
  html
    .replace(/<aside class="archived"[\s\S]*?<\/aside>/g, "")
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "");

describe("no archived page makes a price claim without the pointer", () => {
  const claiming = {};
  for (const lang of FROZEN_LANGS) claiming[lang] = [];
  for (const p of pages) {
    const lang = frozenLangOf(p.path);
    if (lang && PRICE_CLAIM[lang].test(withoutNotice(p.html))) claiming[lang].push(p);
  }

  it("still finds the claims the pointer exists for", () => {
    // The anti-vacuity guard. Every assertion in this describe is over
    // `claiming`; if that goes empty the suite would pass while the archive
    // quoted retired free tiers on every page.
    for (const lang of FROZEN_LANGS) {
      expect(PRICE_CLAIM[lang], `${lang} has no price-claim pattern`).toBeTruthy();
      expect(claiming[lang].length, `${lang}: PRICE_CLAIM now matches fewer pages than measured`)
        .toBeGreaterThanOrEqual(MEASURED[lang]);
    }
  });

  it("carries the pointer on every one of them", () => {
    const naked = [];
    for (const lang of FROZEN_LANGS) {
      for (const p of claiming[lang]) {
        const pointer = pointerOf(asideOf(p.html));
        if (!pointer) naked.push(`${p.path}: price claim, no pointer`);
        else if (!pointer.includes(`<a href="${PRICING_URL}">`)) {
          naked.push(`${p.path}: pointer does not reach ${PRICING_URL}`);
        }
      }
    }
    expect(naked).toEqual([]);
  });

  it("carries it on every OTHER archived page too", () => {
    // The stronger property, stated separately so the previous test keeps its
    // narrow meaning. A page whose price claim is phrased in words PRICE_CLAIM
    // does not know is still an archived page, and the notice is unconditional.
    const naked = pages
      .filter((p) => frozenLangOf(p.path))
      .filter((p) => !pointerOf(asideOf(p.html))?.includes(`<a href="${PRICING_URL}">`))
      .map((p) => p.path);
    expect(naked).toEqual([]);
  });

  it("puts it on no maintained page", () => {
    const wrong = pages
      .filter((p) => !frozenLangOf(p.path) && p.html.includes("archived-pricing"))
      .map((p) => p.path);
    expect(wrong).toEqual([]);
  });
});

describe("the committed pages carry what the generator renders", () => {
  // The generated pages are committed artifacts: a reader without JavaScript, a
  // crawler and an answer engine all fetch public/<lang>/**/index.html, not the
  // output of buildAllPages(). apps-committed-download.test.mjs exists because
  // exactly that gap shipped a stale download link for seven locales; the same
  // gap would ship the notice without the pointer.
  const committed = globSync(`public/{${FROZEN_LANGS.join(",")}}/**/index.html`, {
    cwd: process.cwd(),
  }).sort();

  it("finds the whole archived corpus on disk", () => {
    expect(committed.length, "archived outputs on disk").toBe(
      pages.filter((p) => frozenLangOf(p.path)).length,
    );
    const perLang = {};
    for (const path of committed) perLang[path.split("/")[1]] = (perLang[path.split("/")[1]] ?? 0) + 1;
    expect(Object.keys(perLang).sort()).toEqual([...FROZEN_LANGS].sort());
  });

  it("shows the pointer, localized, in every committed file", () => {
    const bad = [];
    for (const path of committed) {
      const lang = path.split("/")[1];
      const pointer = pointerOf(asideOf(readFileSync(resolve(process.cwd(), path), "utf8")));
      if (!pointer) bad.push(`${path}: no pointer`);
      else if (!pointer.includes(`<a href="${PRICING_URL}">${esc(PRICING_LABELS[lang])}</a>`)) {
        bad.push(`${path}: pointer is not ${lang}'s`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("changes nothing about the languages the product offers", () => {
    // The whole point of the batch: the archive stays reachable, and staying
    // reachable is not support. Nine generated languages, two maintained.
    expect(LANGS.length).toBe(9);
    expect([...MAINTAINED_LANGS].sort()).toEqual(["en", "zh"]);
    for (const path of committed) {
      expect(readFileSync(resolve(process.cwd(), path), "utf8"), `${path} gained a selector`)
        .not.toContain('class="langbar"');
    }
  });
});
