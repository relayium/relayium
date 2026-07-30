import { describe, expect, it } from "vitest";
import crossNetwork from "./content/cross-network.mjs";
import { LANGS } from "./shared.mjs";

const TEXT = {
  en: /text/i, zh: /文本/, ja: /テキスト/, ko: /텍스트/, de: /Text/i,
  fr: /texte/i, ar: /نص/, es: /texto/i, pt: /texto/i,
};
const ONLINE = {
  en: /online/i, zh: /在线/, ja: /オンライン/, ko: /온라인/, de: /online/i,
  fr: /en ligne/i, ar: /متصل/, es: /en línea/i, pt: /online/i,
};
const NO_ACCOUNT = {
  en: /no account/i, zh: /无需账号/, ja: /アカウント(?:は)?不要/, ko: /계정이 필요 없/,
  de: /kein Konto/i, fr: /aucun compte/i, ar: /لا يحتاج.*حساب/,
  es: /no requiere cuenta/i, pt: /não exige conta/i,
};
const NO_STORE = {
  en: /stores? no message bodies/i, zh: /不存储消息正文/, ja: /本文を保存しません/,
  ko: /메시지 본문을 저장하지 않습니다/, de: /speichert keine Nachrichtentexte/i,
  fr: /ne stocke aucun corps de message/i, ar: /لا يخزن.*نصوص الرسائل/,
  es: /no almacena el cuerpo de los mensajes/i, pt: /não armazena o corpo das mensagens/i,
};
const RETAIN = {
  en: /copy or retain/i, zh: /复制或保留/, ja: /コピー・保持/,
  ko: /복사하거나 보관/, de: /kopieren oder behalten/i, fr: /copier ou conserver/i,
  ar: /نسخ.*الاحتفاظ/, es: /copiar o conservar/i, pt: /copiar ou guardar/i,
};

const flat = (value) => JSON.stringify(value);

describe("cross-network file and live text positioning", () => {
  it("keeps all nine locales structurally identical", () => {
    const shape = (doc) => [
      doc.how.steps.length,
      doc.why.items.length,
      doc.compare.items.length,
      doc.faq.items.length,
    ];
    expect(Object.keys(crossNetwork.langs).sort()).toEqual([...LANGS].sort());
    for (const lang of LANGS) {
      expect(shape(crossNetwork.langs[lang]), lang).toEqual([4, 6, 2, 5]);
    }
  });

  it("puts live text in every product-level section", () => {
    for (const lang of LANGS) {
      const doc = crossNetwork.langs[lang];
      for (const section of [doc.hero, doc.how, doc.why, doc.faq]) {
        expect(flat(section), lang).toMatch(TEXT[lang]);
      }
    }
  });

  it("pins the cross-network text and account boundaries in every locale", () => {
    for (const lang of LANGS) {
      const doc = crossNetwork.langs[lang];
      const all = flat(doc);
      expect(all, lang).toMatch(ONLINE[lang]);
      expect(all, lang).toContain("TURN");
      expect(all, lang).toMatch(NO_STORE[lang]);
      expect(all, lang).toMatch(RETAIN[lang]);
      expect(all, lang).toMatch(/65[,. ]536/);
      expect(doc.how.steps[1], lang).toMatch(NO_ACCOUNT[lang]);
      expect(flat(doc.faq), lang).toMatch(NO_ACCOUNT[lang]);
    }
  });
});
