import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import encryptionGuide from "./content/articles/guides-how-encryption-works.mjs";

const preciseSasTokens = {
  en: [/public keys weren't swapped/i, /did not impersonate either endpoint/i, /application-layer end-to-end encryption/i],
  zh: [/公钥没有被调包/, /没有冒充任一端点/, /应用层端到端加密/],
  ja: [/公開鍵はすり替えられておらず/, /エンドポイントになりすましたり/, /アプリケーション層のエンドツーエンド暗号化/],
  ko: [/공개 키가 바뀌지 않았으며/, /어느 엔드포인트도 사칭하지 않았고/, /애플리케이션 계층의 종단 간 암호화/],
  de: [/öffentlichen Schlüssel nicht ausgetauscht/i, /als einer der Endpunkte ausgegeben/i, /Ende-zu-Ende-Verschlüsselung auf Anwendungsebene/i],
  fr: [/clés publiques n'ont pas été substituées/i, /usurpé aucun des deux terminaux/i, /chiffrement de bout en bout au niveau applicatif/i],
  ar: [/المفاتيح العامة لم تُستبدَل/u, /ينتحل شخصية أيٍّ من الطرفين/u, /التشفير من طرف إلى طرف في طبقة التطبيق/u],
  es: [/claves públicas no se sustituyeron/i, /no suplantó a ninguno de los extremos/i, /cifrado de extremo a extremo de la capa de aplicación/i],
  pt: [/chaves públicas não foram substituídas/i, /não se passou por nenhum dos endpoints/i, /criptografia de ponta a ponta da camada de aplicação/i],
};

describe("encryption guide SAS semantics", () => {
  it("authenticates endpoint keys without claiming a relay-free path in every locale", () => {
    for (const lang of LANGS) {
      const sasCopy = encryptionGuide.langs[lang].sections[1].body.join(" ");
      for (const token of preciseSasTokens[lang]) {
        expect(sasCopy, `${lang}: endpoint-key authentication`).toMatch(token);
      }
      expect(sasCopy, `${lang}: TURN remains on the ciphertext path`).toMatch(/TURN/i);
    }
  });

  it("removes the old English claim that matching means nobody is in the middle", () => {
    const sasCopy = encryptionGuide.langs.en.sections[1].body.join(" ");
    expect(sasCopy).not.toContain("If the codes match, the keys weren't swapped, and no one is in the middle.");
  });

  it("publishes the current revision date", () => {
    // Moved by the guides batch, which turned the code-comparison section into a
    // verification procedure with its own expected result and troubleshooting.
    expect(encryptionGuide.updated).toBe("2026-08-06");
  });
});
