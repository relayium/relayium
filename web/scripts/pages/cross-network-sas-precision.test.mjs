import { describe, expect, it } from "vitest";
import crossNetwork from "./content/cross-network.mjs";

const TOKENS = {
  en: [/X25519/, /endpoint (?:public )?keys?/i, /impersonat/i, /network path/i, /ciphertext/i],
  zh: [/X25519/, /端点公钥/, /冒充/, /网络路径/, /密文/],
  ja: [/X25519/, /エンドポイント公開鍵/, /なりすまし/, /ネットワーク経路/, /暗号文/],
  ko: [/X25519/, /끝점 공개 키/, /사칭/, /네트워크 경로/, /암호문/],
  de: [/X25519/, /Endpunktschlüssel/i, /imitiert/i, /Netzwerkpfad/i, /Chiffretext/i],
  fr: [/X25519/, /clés publiques/i, /usurp/i, /chemin réseau/i, /texte chiffré/i],
  ar: [/X25519/, /مفاتيح.*العامة/u, /انتحال/u, /مسار الشبكة/u, /النص المشفر/u],
  es: [/X25519/, /claves públicas/i, /suplant/i, /ruta de red/i, /datos cifrados/i],
  pt: [/X25519/, /chaves públicas/i, /passa(?:ram|r)/i, /caminho de rede/i, /dados cifrados/i],
};

function sasSections(doc) {
  return [
    doc.how.steps[2],
    doc.why.items.find((item) => /SAS/i.test(item.title)).desc,
    doc.compare.items[1].body,
    doc.faq.items.find((item) => /end-to-end|端到端|エンドツーエンド|종단간|Ende-zu-Ende|bout en bout|الطرف إلى الطرف|extremo a extremo|ponta a ponta/i.test(item.q)).a,
  ];
}

describe("cross-network browser SAS precision", () => {
  it("describes endpoint-key authentication in every locale", () => {
    expect(Object.keys(crossNetwork.langs)).toEqual(Object.keys(TOKENS));

    for (const [lang, doc] of Object.entries(crossNetwork.langs)) {
      const sections = sasSections(doc);
      expect(sections, `${lang}: all SAS surfaces`).toHaveLength(4);

      const copy = sections.join(" ");
      for (const token of TOKENS[lang]) {
        expect(copy, `${lang}: ${token}`).toMatch(token);
      }

      for (const section of sections) {
        expect(section, `${lang}: TURN remains in the path`).toMatch(/TURN/i);
      }
    }
  });

  it("removes the old English path-wide guarantees", () => {
    const copy = sasSections(crossNetwork.langs.en).join(" ");

    expect(copy).not.toMatch(/rule out a man-in-the-middle/i);
    expect(copy).not.toMatch(/matching it defeats even/i);
    expect(copy).not.toMatch(/compromised relay or signaling server can't eavesdrop/i);
    expect(copy).toMatch(/does not prove TURN is absent from the network path/i);
    expect(copy).toMatch(/TURN (?:can still remain|still carries).*ciphertext/is);
  });
});
