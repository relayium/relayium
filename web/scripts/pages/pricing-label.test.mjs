// web/scripts/pages/pricing-label.test.mjs — /pricing is English-only, and the
// eight localized footers that link to it have to say so.
//
// The page has no localized twin on purpose: the plan tiers come from the
// billing API, and a hardcoded price in nine languages is the next "1,000 vs
// 10" waiting to happen (see content/spa-pages.mjs). But that decision was only
// visible in the code — on the site, a reader saw `Tarifs` / `料金` / `Preços`
// in their own language and landed on an English page. The label promised a
// localization that does not exist.
//
// So every localized label carries the warning in the reader's own language,
// and this file holds the three properties that make that true and keep it true.
import { describe, expect, it } from "vitest";
import { LANGS, DEFAULT_LANG, PRICING_LABELS, pricingLabel } from "./shared.mjs";
import { buildAllPages } from "../gen-pages.mjs";

import en from "../../src/lib/i18n/en.ts";
import zh from "../../src/lib/i18n/zh.ts";
import ja from "../../src/lib/i18n/ja.ts";
import ko from "../../src/lib/i18n/ko.ts";
import de from "../../src/lib/i18n/de.ts";
import fr from "../../src/lib/i18n/fr.ts";
import ar from "../../src/lib/i18n/ar.ts";
import es from "../../src/lib/i18n/es.ts";
import pt from "../../src/lib/i18n/pt.ts";

const APP_TABLES = { en, zh, ja, ko, de, fr, ar, es, pt };

describe("the /pricing link says the page is in English", () => {
  it("warns in every language except English", () => {
    for (const lang of LANGS) {
      const label = pricingLabel(lang);
      if (lang === DEFAULT_LANG) {
        // Nothing to warn an English reader about, and a suffix here would be
        // noise on the one page that IS in the reader's language.
        expect(label).toBe("Pricing");
      } else {
        // Strictly more than the bare noun, and parenthesised — the warning is
        // an aside on the label, not a second link.
        expect(label, lang).not.toBe(PRICING_LABELS[lang]);
        expect(label.startsWith(PRICING_LABELS[lang]), lang).toBe(true);
        expect(label, lang).toMatch(/[（(].+[）)]$/);
      }
    }
  });

  it("uses the same label in the static pages and in the app", () => {
    // Four SPA surfaces render `pricingPage.navLink` and five static templates
    // render `pricingLabel()`; they point at the same page, so they have to
    // agree. They did not before this landed — Chinese said 定价 in the app and
    // 价格 on every generated page.
    for (const lang of LANGS) {
      expect(APP_TABLES[lang].pricingPage.navLink, lang).toBe(pricingLabel(lang));
    }
  });

  it("reaches every generated page that links to /pricing", () => {
    // The warning is only worth anything where the link actually is. Five
    // templates render it; this checks the built HTML rather than the templates,
    // so a sixth template added later without the helper is caught.
    const bad = [];
    for (const page of buildAllPages()) {
      if (!page.html.includes('href="/pricing"')) continue;
      const lang = page.path.match(/^([a-z]{2})\//)?.[1];
      if (!lang || !LANGS.includes(lang)) continue; // English pages: no warning wanted
      const label = page.html.match(/href="\/pricing">([^<]*)</)?.[1];
      if (label !== pricingLabel(lang)) bad.push(`${page.path}: ${label}`);
    }
    expect(bad).toEqual([]);
  });
});
