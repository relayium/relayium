import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import article from "./content/articles/compare-dropbox.mjs";

function shape(value) {
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shape(child)]));
  return typeof value;
}

const TOKENS = {
  en: {
    lan: /LAN/i, cipher: /ciphertext/i, unreadable: /cannot read or decrypt/i,
    retention: /server-side (?:content copy or history|realtime content history)/i,
    creator: /creator/i, joiner: /joining/i,
  },
  zh: {
    lan: /局域网/, cipher: /密文/, unreadable: /无法读取或解密/,
    retention: /不保留服务器端内容副本或历史/,
    creator: /创建者/, joiner: /加入/,
  },
  ja: {
    lan: /LAN/i, cipher: /暗号文/, unreadable: /読み取りも復号もでき/,
    retention: /サーバー側の内容コピーや履歴を残しません/,
    creator: /作成者/, joiner: /参加/,
  },
  ko: {
    lan: /LAN/i, cipher: /암호문/, unreadable: /읽거나 복호화할 수 없/,
    retention: /서버 측 내용 복사본이나 기록을 남기지 않습니다/,
    creator: /생성자/, joiner: /참가/,
  },
  de: {
    lan: /LAN/i, cipher: /Chiffretext/i, unreadable: /weder lesen noch entschlüsseln/i,
    retention: /keine serverseitige Inhaltskopie oder Historie/i,
    creator: /erstellt/i, joiner: /beitritt/i,
  },
  fr: {
    lan: /LAN/i, cipher: /texte chiffré/i, unreadable: /ni lire ni déchiffrer/i,
    retention: /aucune copie ni aucun historique de contenu côté serveur/i,
    creator: /crée/i, joiner: /rejoint/i,
  },
  ar: {
    lan: /LAN/i, cipher: /نصًا مشفّرًا/u, unreadable: /قراءته أو فك تشفيره/u,
    retention: /لا يترك .*نسخة محتوى أو سجلًا على الخادم/u,
    creator: /منشئ/u, joiner: /المنضم/u,
  },
  es: {
    lan: /LAN/i, cipher: /texto cifrado/i, unreadable: /no puede leer ni descifrar/i,
    retention: /no deja copia ni historial de contenido del lado del servidor/i,
    creator: /crea/i, joiner: /se une/i,
  },
  pt: {
    lan: /LAN/i, cipher: /texto cifrado/i, unreadable: /não consegue ler nem descriptografar/i,
    retention: /não deixa cópia nem histórico de conteúdo no servidor/i,
    creator: /cria/i, joiner: /participa/i,
  },
};

describe("Dropbox comparison path claims", () => {
  it("keeps all nine locales structurally aligned", () => {
    for (const lang of LANGS)
      expect(shape(article.langs[lang]), lang).toEqual(shape(article.langs.en));
  });

  it("states the realtime path and account boundaries in every locale", () => {
    for (const lang of LANGS) {
      const copy = [
        article.langs[lang].sections[1].body[1],
        ...article.langs[lang].sections[2].body,
      ].join(" ");
      const account = article.langs[lang].faq.items[1].a;
      const token = TOKENS[lang];

      expect(copy, `${lang}: LAN direct scope`).toMatch(token.lan);
      expect(copy, `${lang}: TURN by design`).toMatch(/TURN/i);
      expect(copy, `${lang}: ciphertext`).toMatch(token.cipher);
      expect(copy, `${lang}: relay cannot read or decrypt`).toMatch(token.unreadable);
      expect(copy, `${lang}: no server-side realtime retention`).toMatch(token.retention);
      expect(account, `${lang}: creator signs in`).toMatch(token.creator);
      expect(account, `${lang}: joiner needs no account`).toMatch(token.joiner);
    }
  });

  it("preserves the Dropbox and zero-knowledge stored-link comparison", () => {
    const copy = JSON.stringify(article.langs.en);
    expect(copy).toMatch(/Dropbox can technically read files in your account/i);
    expect(copy).toMatch(/AES-256-GCM/);
    expect(copy).toMatch(/URL fragment/i);
    expect(copy).toMatch(/zero-knowledge ciphertext/i);
    expect(copy).toMatch(/expires? or burns? after the first download/i);
  });

  it("does not promise a direct route in the English title or CTA", () => {
    expect(article.langs.en.title).not.toMatch(/\bdirect/i);
    expect(article.langs.en.cta.text).not.toMatch(/\bdirect/i);

    const copy = JSON.stringify(article.langs.en);
    expect(copy).not.toMatch(/realtime direct transfer/i);
    expect(copy).not.toMatch(/moves directly between devices/i);
    expect(copy).not.toMatch(/realtime P2P/i);
  });
});
