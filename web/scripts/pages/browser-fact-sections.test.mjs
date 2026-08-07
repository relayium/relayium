import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import {
  pairingFacts,
  browserRelayFacts,
  browserCrossNetworkSection,
} from "./content/browser-fact-sections.mjs";
import sameWifi from "./content/articles/howto-same-wifi.mjs";
import androidIphone from "./content/articles/howto-android-to-iphone.mjs";
import pcPhone from "./content/articles/howto-pc-to-phone-wirelessly.mjs";
import airdrop from "./content/articles/howto-airdrop-for-windows-android.mjs";
import macWindows from "./content/articles/howto-mac-to-windows.mjs";

const articles = { sameWifi, androidIphone, pcPhone, airdrop, macWindows };
const DECIMAL = {
  en: /six decimal digits.*0–9.*leading zero/i,
  zh: /6 位十进制数字.*0–9.*0 开头/,
  ja: /6桁の10進数字.*0〜9.*先頭の0/,
  ko: /6자리 십진수.*0–9.*맨 앞의 0/,
  de: /sechs Dezimalziffern.*0–9.*führender Null/i,
  fr: /six chiffres décimaux.*0–9.*zéro initial/i,
  ar: /ستة أرقام عشرية.*0 إلى 9.*بصفر/,
  es: /seis dígitos decimales.*0–9.*cero inicial/i,
  pt: /seis dígitos decimais.*0–9.*zero à esquerda/i,
};
const FIVE = {
  en: /five minutes/i, zh: /5 分钟/, ja: /5分間/, ko: /5분/,
  de: /fünf Minuten/i, fr: /cinq minutes/i, ar: /خمس دقائق/,
  es: /cinco minutos/i, pt: /cinco minutos/i,
};

describe("shared browser protocol facts", () => {
  it("has one complete composition in every shipped language", () => {
    expect(Object.keys(pairingFacts)).toEqual(LANGS);
    expect(Object.keys(browserRelayFacts)).toEqual(LANGS);
    expect(Object.keys(browserCrossNetworkSection)).toEqual(LANGS);
    for (const lang of LANGS) {
      expect(pairingFacts[lang]).toMatch(DECIMAL[lang]);
      expect(pairingFacts[lang]).toMatch(FIVE[lang]);
      expect(browserRelayFacts[lang]).toMatch(/TURN/);
      expect(browserCrossNetworkSection[lang].body).toEqual([
        pairingFacts[lang], browserRelayFacts[lang],
      ]);
    }
  });

  it("states browser relay-only behavior without direct-first or fallback wording", () => {
    for (const lang of LANGS) {
      const fact = browserRelayFacts[lang];
      expect(fact).toMatch(/TURN/);
      if (lang === "en") {
        expect(fact).toMatch(/by design/i);
        expect(fact).toMatch(/rather than trying a direct path first/i);
        expect(fact).not.toMatch(/fallback|falls? back/i);
      }
    }
  });

  it("is the actual section object rendered by all five first-batch tutorials", () => {
    for (const [name, article] of Object.entries(articles)) {
      for (const lang of LANGS) {
        expect(article.langs[lang].sections, `${name}:${lang}`)
          .toContain(browserCrossNetworkSection[lang]);
      }
    }
  });

  it("keeps each article source as references, not nine copied fact sections", () => {
    const files = [
      "howto-same-wifi.mjs", "howto-android-to-iphone.mjs",
      "howto-pc-to-phone-wirelessly.mjs", "howto-airdrop-for-windows-android.mjs",
      "howto-mac-to-windows.mjs",
    ];
    for (const name of files) {
      const source = fs.readFileSync(
        path.join(process.cwd(), "scripts/pages/content/articles", name), "utf8");
      expect(source.match(/browserCrossNetworkSection\.(en|zh|ja|ko|de|fr|ar|es|pt)/g))
        .toHaveLength(LANGS.length);
    }
  });
});
