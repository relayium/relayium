import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import {
  pairingFacts,
  browserRelayFacts,
  browserCrossNetworkSection,
  cliDirectFacts,
} from "./content/realtime-facts.mjs";
import sameWifi from "./content/articles/howto-same-wifi.mjs";
import androidIphone from "./content/articles/howto-android-to-iphone.mjs";
import pcPhone from "./content/articles/howto-pc-to-phone-wirelessly.mjs";
import airdrop from "./content/articles/howto-airdrop-for-windows-android.mjs";
import macWindows from "./content/articles/howto-mac-to-windows.mjs";
import cliGettingStarted from "./content/articles/cli-getting-started.mjs";
import cliSendToSomeone from "./content/articles/cli-send-to-someone.mjs";
import p2pGuide from "./content/articles/guides-what-is-p2p-file-transfer.mjs";

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
const DIRECT = {
  en: /direct-only/i, zh: /只走.*直连/, ja: /直接接続専用/, ko: /직접 연결 전용/,
  de: /direct-only/i, fr: /direct-only/i, ar: /مباشر فقط/, es: /direct-only/i,
  pt: /direct-only/i,
};
const FAILS = {
  en: /session fails/i, zh: /会话会直接失败/, ja: /セッションは失敗/,
  ko: /세션이 실패/, de: /Sitzung fehl/, fr: /session échoue/, ar: /تفشل الجلسة/,
  es: /sesión falla/, pt: /sessão falha/,
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

  it("states one complete CLI direct-only boundary in every shipped language", () => {
    expect(Object.keys(cliDirectFacts)).toEqual(LANGS);
    for (const lang of LANGS) {
      expect(cliDirectFacts[lang]).toMatch(DIRECT[lang]);
      expect(cliDirectFacts[lang]).toMatch(/TURN/);
      expect(cliDirectFacts[lang]).toMatch(FAILS[lang]);
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

  it("renders the shared CLI fact in both tutorials and the P2P explainer", () => {
    for (const lang of LANGS) {
      // The chooser carries the fact verbatim, but not necessarily as a bullet
      // of its own: in the maintained languages it is the tail of the
      // send / receive bullet, because that section is a one-bullet-per-mode
      // chooser and a standalone eighth bullet read as an eighth mode. The
      // frozen chooser still lists it separately, and both satisfy the rule
      // that matters here — the exact shared sentence reaches the reader.
      expect(
        cliGettingStarted.langs[lang].sections[1].bullets.some((b) =>
          b.includes(cliDirectFacts[lang]),
        ),
        `${lang} chooser lost the shared direct-only fact`,
      ).toBe(true);
      expect(cliGettingStarted.langs[lang].sections[2].bullets).toContain(cliDirectFacts[lang]);
      expect(cliSendToSomeone.langs[lang].sections.some(
        (section) => section.body?.includes(cliDirectFacts[lang]),
      )).toBe(true);
      const p2pFacts = p2pGuide.langs[lang].sections
        .flatMap((section) => section.bullets ?? [])
        .filter((item) => item === cliDirectFacts[lang]);
      expect(p2pFacts).toHaveLength(2);
    }
  });

  it("keeps CLI article sources on references instead of copied direct-only facts", () => {
    const expected = new Map([
      ["cli-getting-started.mjs", 2],
      ["cli-send-to-someone.mjs", 1],
      ["guides-what-is-p2p-file-transfer.mjs", 2],
    ]);
    for (const [name, perLanguage] of expected) {
      const source = fs.readFileSync(
        path.join(process.cwd(), "scripts/pages/content/articles", name), "utf8");
      expect(source.match(/cliDirectFacts\.(en|zh|ja|ko|de|fr|ar|es|pt)/g))
        .toHaveLength(LANGS.length * perLanguage);
    }
  });
});
