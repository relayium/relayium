// web/scripts/pages/pricing-label.test.mjs — /pricing IS translated, so nothing
// linking to it may claim otherwise.
//
// This file used to assert the opposite. An earlier pass added "(in English)" to
// every non-English /pricing label, on the premise that the page had no
// localized twin. The premise was wrong. /pricing is a client-rendered SPA route
// whose copy comes from the i18n tables, and every one of the nine locales
// carries a full pricingPage block — the same field count as English. Fetching
// /pricing with curl shows English because that is the shell the SPA boots from,
// not because that is what a reader sees.
//
// The result was worse than the problem it was invented for: a Chinese reader
// was told, in Chinese, that a page written in Chinese was in English. The owner
// reported it from the live site.
//
// So the properties are inverted. What stays from the original is the one that
// earned its place: the static pages and the app must show the SAME label, which
// is what caught 价格 in the generated footers against 定价 in the app.
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

/** The words a label would use to disclaim its own language. */
const CLAIMS_ENGLISH = /英文|英語|영문|englisch|en anglais|بالإنجليزية|en inglés|em inglês|in English/i;

describe("the /pricing page is localized, and its labels say nothing else", () => {
  it("carries a full pricingPage block in every locale", () => {
    // The fact the removed warning got wrong. If a locale ever ships a stub —
    // or the page stops being translated — this fails first, and only then is
    // there anything for a label to warn about.
    const enFields = Object.keys(en.pricingPage).length;
    expect(enFields).toBeGreaterThan(20);
    for (const lang of LANGS) {
      const table = APP_TABLES[lang];
      expect(table.pricingPage, lang).toBeTruthy();
      expect(Object.keys(table.pricingPage).length, lang).toBe(enFields);
    }
  });

  it("never tells a reader their own translated page is in another language", () => {
    for (const lang of LANGS) {
      expect(pricingLabel(lang), `${lang} static label`).not.toMatch(CLAIMS_ENGLISH);
      expect(APP_TABLES[lang].pricingPage.navLink, `${lang} app nav link`).not.toMatch(CLAIMS_ENGLISH);
    }
  });

  it("shows the same label in the generated pages as in the app", () => {
    // The property worth keeping. One link, two implementations: the app called
    // it 定价 while ~400 generated footers called it 价格, and nothing noticed
    // until this assertion existed.
    for (const lang of LANGS) {
      expect(pricingLabel(lang), lang).toBe(APP_TABLES[lang].pricingPage.navLink);
    }
  });

  it("renders that label on every generated page that links to /pricing", () => {
    // Checked against built HTML rather than the template, so a new template
    // that hardcodes its own label cannot bypass pricingLabel().
    const bad = [];
    for (const page of buildAllPages()) {
      if (!page.html.includes('href="/pricing"')) continue;
      const lang = LANGS.find((l) => page.path === `${l}/index.html` || page.path.startsWith(`${l}/`)) ?? DEFAULT_LANG;
      if (!page.html.includes(pricingLabel(lang))) bad.push(`${page.path}: no ${pricingLabel(lang)}`);
      if (CLAIMS_ENGLISH.test(page.html.match(/href="\/pricing"[^>]*>([^<]*)</)?.[1] ?? "")) {
        bad.push(`${page.path}: the /pricing link disclaims its own language`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps the bare noun as the whole label", () => {
    for (const lang of LANGS) expect(pricingLabel(lang), lang).toBe(PRICING_LABELS[lang]);
  });
});
