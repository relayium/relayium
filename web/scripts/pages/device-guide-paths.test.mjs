import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import androidIphone from "./content/articles/howto-android-to-iphone.mjs";
import macWindows from "./content/articles/howto-mac-to-windows.mjs";

const ARTICLES = { androidIphone, macWindows };

const FACTS = {
  en: [/LAN/i, /TURN/i, /cannot read or decrypt/i, /no realtime content copy or history/i, /creator signs in/i, /joining never needs an account/i],
  zh: [/局域网/, /TURN/i, /无法读取或解密/, /不保留实时内容副本或历史/, /创建者登录/, /加入者始终无需账号/],
  ja: [/LAN/i, /TURN/i, /読取りも復号もできない/, /コピーや履歴を残しません/, /作成者がサインイン/, /参加者にはアカウントが不要/],
  ko: [/LAN/i, /TURN/i, /읽거나 복호화할 수 없는/, /사본이나 기록을 남기지 않습니다/, /생성자가 로그인/, /참가자는 계정이 필요 없습니다/],
  de: [/LAN/i, /TURN/i, /weder lesen noch entschlüsseln/i, /weder Echtzeitinhalte noch einen Verlauf/i, /Ersteller an/i, /beitretende Person braucht nie ein Konto/i],
  fr: [/LAN/i, /TURN/i, /ni lire ni déchiffrer/i, /sans conserver de copie ni d'historique/i, /créateur se connecte/i, /rejoint n'a jamais besoin de compte/i],
  ar: [/LAN/i, /TURN/i, /لا يستطيع قراءته أو فك تشفيره/u, /لا يحتفظ بنسخة أو سجل/u, /منشئ الاقتران/u, /المنضم إلى حساب/u],
  es: [/LAN/i, /TURN/i, /no puede leer ni descifrar/i, /no conserva copia ni historial/i, /creador/i, /se une nunca necesita cuenta/i],
  pt: [/LAN/i, /TURN/i, /não consegue ler nem descriptografar/i, /não mantém cópia nem histórico/i, /criador faz login/i, /entra nunca precisa de conta/i],
};

/**
 * The SAS copy of the same-network section, whichever field carries it.
 *
 * These guides became runnable tutorials (browser-howto-tutorial.test.mjs), so
 * the procedure that used to be `bullets` is now `steps`. The claim this file
 * polices did not move — only the field it sits in — and reading both keeps the
 * rule pointed at the sentence rather than at a shape.
 */
const sasCopy = (article, lang) => {
  const section = article.langs[lang].sections[1];
  return [...(section.bullets || []), ...(section.steps || []).map((s) => s.text)].join(" ");
};

describe("device guide realtime paths", () => {
  it("states the complete path, privacy, and account boundary in every localized lead", () => {
    for (const [name, article] of Object.entries(ARTICLES)) {
      expect(article.updated, name).toBe("2026-08-07");
      for (const lang of LANGS) {
        const lead = article.langs[lang].lead[1];
        for (const fact of FACTS[lang]) expect(lead, `${name} [${lang}] ${fact}`).toMatch(fact);
      }
    }
  });

  it("describes the verification code as session authentication, not path proof", () => {
    for (const [name, article] of Object.entries(ARTICLES))
      for (const lang of LANGS) {
        const sas = sasCopy(article, lang);
        expect(sas, `${name} [${lang}]`).not.toMatch(
          /proves? no server|confirms? .*direct|没有服务器|证明.*直连|サーバーが入り込んでいない|직접적이며 중간|kein Server dazwischen|connexion est directe|خادم بينكما|conexión es directa|conexão é direta/i,
        );
      }
  });

  it("removes the old English direct-only lead and SAS claims", () => {
    const copy = Object.values(ARTICLES)
      .map((article) => `${article.langs.en.lead[1]} ${sasCopy(article, "en")}`)
      .join(" ");
    expect(copy).not.toMatch(/files travel directly between them/i);
    expect(copy).not.toMatch(/proves no server|confirms the connection is direct/i);
  });
});
