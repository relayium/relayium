import { describe, expect, it } from "vitest";
import article from "./content/articles/compare-wetransfer.mjs";
import { LANGS } from "./shared.mjs";

const TASHKEEL = /[ً-ْٰـ]/g;
const norm = (value) => value.replace(TASHKEEL, "");

const REQUIRED = {
  en: {
    lan: /same LAN.+connect directly/is,
    cannot: /cannot read or decrypt (?:the )?plaintext/i,
    creator: /whoever creates the pairing code signs in/i,
    joiner: /whoever joins.+needs no account/i,
  },
  zh: {
    lan: /同一局域网.+直连/s,
    cannot: /无法读取或解密明文/,
    creator: /创建配对码的一方登录/,
    joiner: /加入者无需账号/,
  },
  ja: {
    lan: /同一 LAN.+直接/s,
    cannot: /平文を読んだり復号したりできません/,
    creator: /ペアリングコードの作成者がサインイン/,
    joiner: /参加する側はアカウント不要/,
  },
  ko: {
    lan: /같은 LAN.+직접/s,
    cannot: /평문을 읽거나 복호화할 수 없습니다/,
    creator: /페어링 코드 생성자가 로그인/,
    joiner: /참가하는 쪽은 계정이 필요 없습니다/,
  },
  de: {
    lan: /selben LAN.+direkt/is,
    cannot: /weder lesen noch entschlüsseln/i,
    creator: /meldet sich.+Pairing-Code erstellt/is,
    joiner: /beitritt.+braucht kein Konto/is,
  },
  fr: {
    lan: /même LAN.+directement/is,
    cannot: /ni lire ni déchiffrer/i,
    creator: /crée le code d'appairage se connecte/i,
    joiner: /rejoint.+n'a pas besoin de compte/is,
  },
  ar: {
    lan: /شبكة LAN نفسها.+مباشرة/s,
    cannot: /لا يستطيع قراءة المحتوى الصريح أو فك تشفيره/,
    creator: /منشئ رمز الاقتران الدخول/,
    joiner: /لا يحتاج من ينضم.+إلى حساب/s,
  },
  es: {
    lan: /misma LAN.+directamente/is,
    cannot: /no puede leer ni descifrar/i,
    creator: /crea el código de emparejamiento inicia sesión/i,
    joiner: /se une.+no necesita cuenta/is,
  },
  pt: {
    lan: /mesma LAN.+diretamente/is,
    cannot: /não consegue ler nem descriptografar/i,
    creator: /cria o código de emparelhamento faz login/i,
    joiner: /participa.+não precisa de conta/is,
  },
};

const STALE = {
  en: /never (?:touch|land|park|put).{0,24}server|without the server/i,
  zh: /不经服务器|从不(?:经过|落到|停留在).{0,8}服务器|根本不把文件放到服务器/,
  ja: /サーバーを介さず|サーバーに一切触れない|サーバーに置かれることはない/,
  ko: /서버 없이|서버를 거치지 않는|서버에 전혀 닿지|서버에 놓이지/,
  de: /ohne Server(?:\s|$)|nie (?:auf|einen).{0,16}Server|überhaupt nicht auf einem Server/i,
  fr: /sans serveur|n'atterrissent jamais sur un serveur|ne touche jamais un serveur|ne met jamais le fichier sur un serveur/i,
  ar: /دون الخادم|لا تلمس خادما أبدا|لا تحط على خادم أبدا|لا يلمس خادما أبدا|لا يضع.+على خادم على الإطلاق/s,
  es: /sin el servidor|nunca (?:tocan|aterrizan|se aparcan|pone).{0,20}servidor/i,
  pt: /sem o servidor|nunca (?:tocam|pousam|são estacionados|coloca).{0,20}servidor/i,
};

function guardedFields(page) {
  return [
    page.title,
    page.description,
    page.lead[1],
    page.sections[1].body[1],
    page.sections[2].body[0],
    page.sections[2].body[1],
    page.sections[4].bullets[1],
    page.faq.items[0].a,
  ];
}

describe("WeTransfer comparison realtime paths", () => {
  it("distinguishes LAN direct from cross-network TURN in every locale", () => {
    for (const lang of LANGS) {
      const detail = norm(article.langs[lang].sections[2].body[1]);
      expect(detail, `${lang}: LAN direct`).toMatch(REQUIRED[lang].lan);
      expect(detail, `${lang}: TURN`).toMatch(/TURN/i);
      expect(detail, `${lang}: relay cannot read or decrypt`).toMatch(REQUIRED[lang].cannot);
      expect(detail, `${lang}: pairing-code creator signs in`).toMatch(REQUIRED[lang].creator);
      expect(detail, `${lang}: joiner needs no account`).toMatch(REQUIRED[lang].joiner);
    }
  });

  it("does not promise that every realtime route bypasses a server", () => {
    for (const lang of LANGS)
      for (const text of guardedFields(article.langs[lang]))
        expect(norm(text), `${lang}: ${text}`).not.toMatch(STALE[lang]);
  });
});
