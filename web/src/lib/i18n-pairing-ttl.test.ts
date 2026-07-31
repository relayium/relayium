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
});
