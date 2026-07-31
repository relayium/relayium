import { describe, expect, it } from "vitest";
import article from "./content/articles/compare-airdrop.mjs";
import { LANGS } from "./shared.mjs";

const TASHKEEL = /[ً-ْٰـ]/g;
const norm = (value) => value.normalize("NFC").replace(TASHKEEL, "");

const REQUIRED = {
  en: {
    key: /X25519 endpoint public keys were not replaced/i,
    endpoint: /signaling service or a TURN relay impersonated either endpoint/i,
    limitation: /does not prove that TURN is absent from the network path/i,
    path: /TURN remains in the data path but carries only ciphertext/i,
  },
  zh: {
    key: /X25519 端点公钥未被替换/,
    endpoint: /信令服务或 TURN 中继是否冒充任一端点/,
    limitation: /并不证明 TURN 不在网络路径中/,
    path: /TURN 仍在数据路径中，但只承载密文/,
  },
  ja: {
    key: /X25519 の端末公開鍵が置き換えられていない/,
    endpoint: /シグナリングサービスや TURN リレーによる端末のなりすまし/,
    limitation: /TURN がネットワーク経路に存在しないことを証明するものではありません/,
    path: /TURN は引き続きデータ経路上にあり、運ぶのは暗号文だけ/,
  },
  ko: {
    key: /X25519 엔드포인트 공개 키가 바뀌지 않았음/,
    endpoint: /시그널링 서비스나 TURN 릴레이가 어느 한쪽 엔드포인트를 사칭/,
    limitation: /TURN이 네트워크 경로에 없음을 증명하지 않습니다/,
    path: /TURN은 여전히 데이터 경로에 있지만 암호문만 운반/,
  },
  de: {
    key: /öffentlichen X25519-Schlüssel der Endpunkte nicht ausgetauscht wurden/i,
    endpoint: /Signalisierungsdienst oder ein TURN-Relay einen Endpunkt imitiert hat/i,
    limitation: /beweist nicht, dass TURN außerhalb des Netzwerkpfads liegt/i,
    path: /TURN im Datenpfad, transportiert aber nur Chiffretext/i,
  },
  fr: {
    key: /clés publiques X25519 des appareils n'ont pas été remplacées/i,
    endpoint: /service de signalisation ou un relais TURN s'est fait passer pour l'un des appareils/i,
    limitation: /ne prouve pas que TURN est absent du chemin réseau/i,
    path: /TURN reste bien sur le chemin des données, mais ne transporte que du texte chiffré/i,
  },
  ar: {
    key: /المفاتيح العامة لطرفي X25519 لم تستبدل/,
    endpoint: /خادم الإشارات أو مرحل TURN قد انتحل شخصية أي من الطرفين/,
    limitation: /لا يثبت ذلك غياب TURN عن مسار الشبكة/,
    path: /TURN ضمن مسار البيانات، لكنه لا يحمل سوى النص المشفر/,
  },
  es: {
    key: /claves públicas X25519 de los extremos no se han sustituido/i,
    endpoint: /servidor de señalización o un retransmisor TURN ha suplantado a alguno de los extremos/i,
    limitation: /no demuestra que TURN esté fuera de la ruta de red/i,
    path: /TURN sigue estando en la ruta de los datos, pero solo transporta texto cifrado/i,
  },
  pt: {
    key: /chaves públicas X25519 das pontas não foram substituídas/i,
    endpoint: /servidor de sinalização ou um retransmissor TURN se passou por qualquer uma das pontas/i,
    limitation: /não prova que TURN esteja fora do caminho da rede/i,
    path: /TURN continua no caminho dos dados, mas só transporta texto cifrado/i,
  },
};

describe("AirDrop comparison SAS explanation", () => {
  it("states precisely what out-of-band SAS matching proves in every locale", () => {
    expect(Object.keys(article.langs)).toEqual(LANGS);

    for (const lang of LANGS) {
      const detail = norm(article.langs[lang].sections[2].body[1]);
      expect(detail, `${lang}: endpoint public keys`).toMatch(REQUIRED[lang].key);
      expect(detail, `${lang}: endpoint impersonation`).toMatch(
        REQUIRED[lang].endpoint,
      );
      expect(detail, `${lang}: does not prove the network path`).toMatch(
        REQUIRED[lang].limitation,
      );
      expect(detail, `${lang}: TURN carries ciphertext`).toMatch(
        REQUIRED[lang].path,
      );
    }
  });

  it("removes the vague English key-exchange claim", () => {
    expect(article.langs.en.sections[2].body[1]).not.toContain(
      "nobody tampered with that key exchange",
    );
  });

  it("records the material revision date", () => {
    expect(article.updated).toBe("2026-07-31");
  });
});
