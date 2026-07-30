import { describe, expect, it } from "vitest";
import article from "./content/articles/guides-self-host.mjs";
import { LANGS } from "./shared.mjs";

const NO_LOGIN = {
  en: /no login/i,
  zh: /无需登录/,
  ja: /ログイン不要/,
  ko: /로그인이 필요 없/,
  de: /keine Anmeldung/i,
  fr: /aucune connexion/i,
  ar: /لا تحتاج إلى تسجيل دخول/,
  es: /no (?:necesitan|requieren) iniciar sesión/i,
  pt: /não (?:precisam de|exigem) login/i,
};

const NEVER_STORED = {
  en: /never stored/i,
  zh: /绝不存储/,
  ja: /保存されません/,
  ko: /저장되지 않습니다/,
  de: /nie gespeichert/i,
  fr: /jamais stockés/i,
  ar: /لا تُخزَّن أبدًا/,
  es: /nunca se almacenan/i,
  pt: /nunca são armazenadas/i,
};

const ONLINE = {
  en: /stay online/i,
  zh: /同时在线/,
  ja: /同時にオンライン/,
  ko: /동시에 온라인/,
  de: /gleichzeitig online/i,
  fr: /rester en ligne/i,
  ar: /متصلين/,
  es: /permanecer en línea/i,
  pt: /permanecer online/i,
};

const NO_TURN = {
  en: /does not use/i,
  zh: /不使用/,
  ja: /使いません/,
  ko: /사용하지 않습니다/,
  de: /nutzt nicht/i,
  fr: /n'utilise pas/i,
  ar: /لا يستخدم/,
  es: /no usa/i,
  pt: /não usa/i,
};

const TEXT_WORD = {
  en: /\btext\b/i,
  zh: /文本/,
  ja: /テキスト/,
  ko: /텍스트/,
  de: /Text/,
  fr: /texte/i,
  ar: /(?<!م)نص/,
  es: /texto/i,
  pt: /texto/i,
};

describe("self-hosting guide documents CLI text against a custom server", () => {
  for (const lang of LANGS) {
    it(`${lang}: gives both copy-ready text commands and preserves the protocol facts`, () => {
      const doc = article.langs[lang];
      expect(doc.title).toMatch(TEXT_WORD[lang]);
      expect(doc.description).toMatch(TEXT_WORD[lang]);
      const section = doc.sections.find((candidate) =>
        candidate.code?.includes("relayium text --server https://your-domain"),
      );
      expect(section, `${lang} has no self-hosted text section`).toBeTruthy();
      expect(section.code).toContain("relayium text K7M4XR --server https://your-domain");

      const prose = [...section.body, ...section.bullets].join(" ");
      expect(prose).toContain("relayium login --server https://your-domain");
      expect(prose).toMatch(/P2P|peer-to-peer/i);
      expect(prose).toContain("TURN");
      expect(prose).toMatch(NO_LOGIN[lang]);
      expect(prose).toMatch(NEVER_STORED[lang]);
      expect(prose).toMatch(ONLINE[lang]);
      expect(prose).toMatch(NO_TURN[lang]);

      const faq = doc.faq.items.map((item) => item.a).join(" ");
      expect(faq).toContain("text");
      expect(faq).toMatch(NO_LOGIN[lang]);
    });
  }

  it("carries the current article update date", () => {
    expect(article.updated).toBe("2026-07-30");
  });
});
