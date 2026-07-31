import { describe, expect, it } from "vitest";
import en from "./i18n/en";
import zh from "./i18n/zh";
import ja from "./i18n/ja";
import ko from "./i18n/ko";
import de from "./i18n/de";
import fr from "./i18n/fr";
import ar from "./i18n/ar";
import es from "./i18n/es";
import pt from "./i18n/pt";

const locales = { en, zh, ja, ko, de, fr, ar, es, pt };

describe("pairing-code expiry copy", () => {
  it("matches the server's five-minute code TTL in every locale", () => {
    for (const [lang, messages] of Object.entries(locales)) {
      const tag = messages.howItWorks.realtime.ways[1].tag;
      expect(tag, lang).toMatch(/5/);
      expect(tag, lang).not.toMatch(/15/);
    }
  });

  it("teaches the real post-join file-or-text flow in every locale", () => {
    const textTokens: Record<string, RegExp> = {
      en: /text/i,
      zh: /文本/,
      ja: /テキスト/,
      ko: /텍스트/,
      de: /Text/i,
      fr: /texte/i,
      ar: /نص/u,
      es: /texto/i,
      pt: /texto/i,
    };

    for (const [lang, messages] of Object.entries(locales)) {
      const [create, , choose] = messages.howItWorks.realtime.ways;
      expect(create.icon, `${lang}: create first`).toBe("🔗");
      expect(create.how, `${lang}: six-character code`).toMatch(/6/);
      expect(choose.how, `${lang}: batch cap`).toMatch(/1(?:[,\s. ]*)000/);
      expect(choose.how, `${lang}: text option`).toMatch(textTokens[lang]);
      expect(choose.how, `${lang}: SAS`).toMatch(/SAS/i);
      expect(choose.how, `${lang}: TURN`).toMatch(/TURN/i);
    }

    expect(en.howItWorks.realtime.ways[0].name).toBe("Create a pairing code");
    expect(en.howItWorks.realtime.ways[2].name).toBe("Choose files or text");
    expect(JSON.stringify(en.howItWorks.realtime.ways)).not.toMatch(
      /Pick files, get a code|Transfer starts on join|starts automatically/i,
    );
  });
});
