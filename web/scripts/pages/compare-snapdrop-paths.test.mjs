import { describe, expect, it } from "vitest";
import article from "./content/articles/compare-snapdrop.mjs";
import { LANGS } from "./shared.mjs";

const TOKENS = {
  en: {
    lanDirect: /connect directly.+same LAN/is,
    ciphertext: /ciphertext/i,
    unreadable: /cannot read or decrypt/i,
    retention: /no server-side copy or history/i,
  },
  zh: {
    lanDirect: /同一局域网内直接连接/,
    ciphertext: /密文/,
    unreadable: /无法读取或解密/,
    retention: /不会在服务器端保留实时内容副本或历史/,
  },
  ja: {
    lanDirect: /同じ LAN 内なら直接接続/,
    ciphertext: /暗号文/,
    unreadable: /読み取りも復号もできない/,
    retention: /サーバー側コピーや履歴を残しません/,
  },
  ko: {
    lanDirect: /같은 LAN에서 직접 연결/,
    ciphertext: /암호문/,
    unreadable: /읽거나 복호화할 수 없는/,
    retention: /서버 측 사본이나 기록을 남기지 않습니다/,
  },
  de: {
    lanDirect: /selben LAN direkt/is,
    ciphertext: /Chiffretext/i,
    unreadable: /weder lesen noch entschlüsseln/i,
    retention: /keine serverseitige Kopie oder Historie/i,
  },
  fr: {
    lanDirect: /directement sur le même LAN/i,
    ciphertext: /texte chiffré/i,
    unreadable: /ni lire ni déchiffrer/i,
    retention: /aucune copie ni aucun historique.+côté serveur/is,
  },
  ar: {
    lanDirect: /مباشرةً على شبكة LAN نفسها/u,
    ciphertext: /نص مُشفَّر/u,
    unreadable: /لا يستطيع قراءته أو فك تشفيره/u,
    retention: /لا يحتفظ.+بنسخة أو سجل.+على الخادم/us,
  },
  es: {
    lanDirect: /directamente en la misma LAN/i,
    ciphertext: /texto cifrado/i,
    unreadable: /no puede leer ni descifrar/i,
    retention: /no conserva copia ni historial.+en el servidor/is,
  },
  pt: {
    lanDirect: /diretamente na mesma LAN/i,
    ciphertext: /texto cifrado/i,
    unreadable: /não consegue ler nem descriptografar/i,
    retention: /não mantém cópia nem histórico.+no servidor/is,
  },
};

describe("Snapdrop comparison realtime paths", () => {
  it("distinguishes LAN direct from cross-network TURN in every locale", () => {
    for (const lang of LANGS) {
      const detail = article.langs[lang].sections[3].body.join(" ");
      const token = TOKENS[lang];

      expect(detail, `${lang}: LAN direct scope`).toMatch(token.lanDirect);
      expect(detail, `${lang}: TURN by design`).toMatch(/TURN/i);
      expect(detail, `${lang}: ciphertext`).toMatch(token.ciphertext);
      expect(detail, `${lang}: relay cannot read or decrypt`).toMatch(token.unreadable);
      expect(detail, `${lang}: no realtime content copy or history`).toMatch(token.retention);
    }
  });

  it("does not equate cross-network relay performance with a direct path", () => {
    const performance = article.langs.en.faq.items[2].a;
    const encryption = article.langs.en.sections[2].body.join(" ");

    expect(performance).toMatch(/same LAN.+direct WebRTC path/is);
    expect(performance).toMatch(/Across networks.+TURN by design/is);
    expect(performance).toMatch(/relay location and capacity can affect latency and throughput/i);
    expect(performance).not.toMatch(/no meaningful one/i);
    expect(performance).not.toMatch(/All three make a direct WebRTC connection/i);
    expect(encryption).not.toMatch(/no server sits between you/i);
    expect(encryption).toMatch(/no server has impersonated either endpoint/i);
  });

  it("carries the current material-update date", () => {
    expect(article.updated).toBe("2026-07-31");
  });
});
