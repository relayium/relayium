// Who bills a subscription is now a two-answer question: the web checkout is
// sold by Relayium and processed by Stripe, while an App Store build of the app
// — starting with the Mac App Store — is sold and billed by Apple. Terms and
// Support have to say both, in all nine languages, and must not fall back to
// either of the two claims that were true before Apple billing shipped: that
// Apple billing is an iOS-only thing, or that every subscription is managed and
// refunded through Relayium.
//
// The generated pages are checked alongside the source because they are what a
// user (and Apple's reviewer) actually reads: a corrected source with a stale
// public/ page is the same wrong answer, one build step later.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LANGS } from "../../shared.mjs";
import terms from "./terms.mjs";
import support from "./support.mjs";

const REVISED = "2026-08-13";

const REFUND = {
  en: /refund/i,
  zh: /退款/,
  ja: /返金/,
  ko: /환불/,
  de: /Erstattung|erstatten/i,
  fr: /rembours/i,
  ar: /استرداد/,
  es: /reembols/i,
  pt: /reembols/i,
};

// The Apple account a purchase is charged to. Three languages localize the
// identifier itself ("Apple-ID", "identifiant Apple", "مُعرِّف Apple"), so this
// cannot be one literal.
const APPLE_ACCOUNT = {
  en: /Apple ID/,
  zh: /Apple ID/,
  ja: /Apple ID/,
  ko: /Apple ID/,
  de: /Apple-ID/,
  fr: /identifiant Apple/,
  ar: /مُعرِّف Apple/,
  es: /Apple ID/,
  pt: /Apple ID/,
};

// "in your Apple account settings" — where an Apple-billed subscription lives.
const ACCOUNT_SETTINGS = {
  en: /account settings/i,
  zh: /账号设置/,
  ja: /アカウントの?設定/,
  ko: /계정 설정/,
  de: /Kontoeinstellungen/,
  fr: /paramètres de votre compte/i,
  ar: /إعدادات حساب/,
  es: /ajustes de tu cuenta/i,
  pt: /configurações da sua conta/i,
};

const WEB = {
  en: /web/i,
  zh: /网页/,
  ja: /ウェブ/,
  ko: /웹/,
  de: /Web/,
  fr: /web/i,
  ar: /الويب/,
  es: /web/i,
  pt: /web/i,
};

const blob = (value) => JSON.stringify(value);

/** The section that explains the web/Stripe side of billing. */
const stripeSection = (doc, lang) =>
  doc.langs[lang].sections.find((section) => blob(section).includes("Stripe"));

/** The Apple in-app purchase section: names the store, never names Stripe. */
const appleSection = (doc, lang) =>
  doc.langs[lang].sections.find(
    (section) => blob(section).includes("App Store") && !blob(section).includes("Stripe"),
  );

function generatedPage(slug, lang) {
  const dir = lang === "en" ? slug : `${lang}/${slug}`;
  return readFileSync(resolve(process.cwd(), `public/${dir}/index.html`), "utf8");
}

describe("terms and support separate Stripe billing from Apple billing", () => {
  for (const lang of LANGS) {
    it(`terms.${lang} names both providers and covers the Mac App Store`, () => {
      const doc = terms.langs[lang];
      const stripe = stripeSection(terms, lang);
      const apple = appleSection(terms, lang);

      expect(doc.updated, `terms.${lang}.updated`).toBe(REVISED);
      expect(stripe, `terms.${lang}.stripeSection`).toBeDefined();
      expect(apple, `terms.${lang}.appleSection`).toBeDefined();

      // The section that carries the Stripe-shaped proration/refund bullets has
      // to say up front that Apple bills the App Store builds instead, so those
      // bullets are not read as covering every subscription.
      expect(blob(stripe)).toContain("Apple");
      expect(blob(stripe)).toContain("Mac App Store");
      expect(blob(stripe)).toMatch(WEB[lang]);

      // Apple's side: sold by Apple, managed in Apple's account settings,
      // refunded by Apple, and reachable for us only as a diagnosis.
      expect(blob(apple)).toContain("Mac App Store");
      expect(blob(apple)).toMatch(APPLE_ACCOUNT[lang]);
      expect(blob(apple)).toMatch(ACCOUNT_SETTINGS[lang]);
      expect(blob(apple)).toMatch(REFUND[lang]);
      expect(blob(apple)).toContain("support@relayium.com");
      expect(apple.bullets, `terms.${lang}.appleSection.bullets`).toHaveLength(4);
    });

    it(`support.${lang} routes each provider to the place that can act`, () => {
      const doc = support.langs[lang];
      const billing = doc.sections.find((section) => blob(section).includes("Stripe"));

      expect(doc.updated, `support.${lang}.updated`).toBe(REVISED);
      expect(billing, `support.${lang}.billing`).toBeDefined();
      expect(billing.body, `support.${lang}.billing.body`).toHaveLength(3);
      expect(billing.bullets, `support.${lang}.billing.bullets`).toHaveLength(3);

      const text = blob(billing);
      expect(text).toContain("Apple");
      expect(text).toContain("App Store");
      expect(text).toContain("Mac App Store");
      expect(text).toMatch(WEB[lang]);
      expect(text).toMatch(REFUND[lang]);
      expect(text).toMatch(ACCOUNT_SETTINGS[lang]);
      // Support can still be written to about an Apple purchase — it just
      // cannot cancel or refund one.
      expect(text).toContain("support@relayium.com");

      // One paragraph must be about Apple without being about Stripe: that is
      // the paragraph a user with an App Store subscription needs.
      const appleOnly = billing.body.filter((p) => p.includes("Apple") && !p.includes("Stripe"));
      expect(appleOnly.length, `support.${lang}.appleOnlyParagraph`).toBeGreaterThan(0);
      expect(appleOnly.join("\n")).toContain("App Store");
    });

    it(`generated terms and support pages for ${lang} carry the correction`, () => {
      for (const slug of ["terms", "support"]) {
        const html = generatedPage(slug, lang);
        expect(html, `${slug}.${lang}.updated`).toContain(REVISED);
        expect(html, `${slug}.${lang}.stripe`).toContain("Stripe");
        expect(html, `${slug}.${lang}.macAppStore`).toContain("Mac App Store");
        // Nothing in these two documents may describe Apple billing as an
        // iOS-only arrangement; distribution channel, not OS, decides who bills.
        expect(html, `${slug}.${lang}.iOS`).not.toContain("iOS");
      }
    });
  }

  it("no source locale reintroduces an iOS-only billing claim", () => {
    for (const doc of [terms, support]) {
      for (const lang of LANGS) {
        expect(blob(doc.langs[lang]), `${doc.slug}.${lang}`).not.toContain("iOS");
      }
    }
  });

  it("does not restore the pre-Mac-App-Store English claims", () => {
    const en = [blob(terms.langs.en), blob(support.langs.en)].join("\n");
    for (const stale of [
      "In the iOS app, subscriptions are sold and billed by Apple",
      "Subscriptions bought inside the iOS app",
      // Support used to describe every subscription as self-managed here and
      // refundable by us, which is false for an App Store purchase.
      "You can manage most of it yourself without writing to us.",
      "Upgrades take effect immediately and are prorated; downgrades take effect at the end of the current billing period",
    ]) {
      expect(en, stale).not.toContain(stale);
    }
  });

  it("states in English that Relayium cannot refund an App Store purchase", () => {
    expect(blob(terms.langs.en)).toContain(
      "Refunds for App Store purchases are requested from Apple and decided by Apple; we cannot issue them.",
    );
    expect(blob(support.langs.en)).toContain(
      "we cannot cancel or refund an App Store purchase for you",
    );
  });
});
