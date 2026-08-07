import { describe, expect, it } from "vitest";
import article from "./content/articles/howto-airdrop-for-windows-android.mjs";
import { LANGS } from "./shared.mjs";

const TASHKEEL = /[ً-ْٰـ]/g;
const norm = (value) => value.normalize("NFC").replace(TASHKEEL, "");

const REQUIRED = {
  en: {
    key: /derived key was not replaced/i,
    endpoint: /server or a TURN relay has not impersonated either endpoint/i,
    e2ee: /terminated the application-layer end-to-end encryption/i,
    path: /TURN still remains in the data path, but it carries only ciphertext/i,
  },
  zh: {
    key: /协商出的密钥未被替换/,
    endpoint: /服务器或 TURN 中继没有冒充任一端点/,
    e2ee: /没有终止应用层端到端加密/,
    path: /TURN 仍在数据路径中，但只承载密文/,
  },
  ja: {
    key: /導出された鍵が置き換えられていない/,
    endpoint: /サーバーや TURN リレーがどちらかの端末になりすまし/,
    e2ee: /アプリケーション層のエンドツーエンド暗号化を終端したりしていない/,
    path: /TURN は引き続きデータ経路上にありますが、運ぶのは暗号文だけ/,
  },
  ko: {
    key: /도출된 키가 바뀌지 않았는지/,
    endpoint: /서버나 TURN 릴레이가 어느 한쪽 엔드포인트를 사칭/,
    e2ee: /애플리케이션 계층의 종단간 암호화를 종료하지 않았는지/,
    path: /TURN이 여전히 데이터 경로에 있지만 암호문만 운반/,
  },
  de: {
    key: /abgeleitete Schlüssel nicht ausgetauscht wurde/i,
    endpoint: /Server noch ein TURN-Relay hat sich als einer der Endpunkte ausgegeben/i,
    e2ee: /Ende-zu-Ende-Verschlüsselung der Anwendungsschicht beendet/i,
    path: /TURN im Datenpfad, transportiert aber nur Chiffretext/i,
  },
  fr: {
    key: /clé dérivée n'a pas été remplacée/i,
    endpoint: /serveur de signalisation ni un relais TURN ne s'est fait passer pour l'un des appareils/i,
    e2ee: /chiffrement de bout en bout de la couche applicative/i,
    path: /TURN reste bien sur le chemin des données, mais ne transporte que du texte chiffré/i,
  },
  ar: {
    key: /المفتاح المشتق لم يستبدل/,
    endpoint: /خادم الإشارات أو مرحل TURN شخصية أي من الطرفين/,
    e2ee: /التشفير من الطرف إلى الطرف في طبقة التطبيق/,
    path: /TURN ضمن مسار البيانات، لكنه لا يحمل سوى النص المشفر/,
  },
  es: {
    key: /clave derivada no se ha sustituido/i,
    endpoint: /servidor de señalización ni un retransmisor TURN han suplantado a ninguno de los extremos/i,
    e2ee: /cifrado de extremo a extremo de la capa de aplicación/i,
    path: /TURN sigue estando en la ruta de los datos, pero solo transporta texto cifrado/i,
  },
  pt: {
    key: /chave derivada não foi substituída/i,
    endpoint: /servidor de sinalização nem um retransmissor TURN se passaram por qualquer uma das pontas/i,
    e2ee: /criptografia de ponta a ponta da camada de aplicação/i,
    path: /TURN continua no caminho dos dados, mas só transporta texto cifrado/i,
  },
};

describe("AirDrop alternative SAS explanation", () => {
  it("defines what matching the SAS proves in every locale", () => {
    expect(Object.keys(article.langs)).toEqual(LANGS);

    for (const lang of LANGS) {
      const detail = norm(article.langs[lang].sections[3].body[0]);
      expect(detail, `${lang}: key was not replaced`).toMatch(
        REQUIRED[lang].key,
      );
      expect(detail, `${lang}: relay did not impersonate an endpoint`).toMatch(
        REQUIRED[lang].endpoint,
      );
      expect(detail, `${lang}: relay did not terminate app E2EE`).toMatch(
        REQUIRED[lang].e2ee,
      );
      expect(detail, `${lang}: TURN carries ciphertext`).toMatch(
        REQUIRED[lang].path,
      );
    }
  });

  it("removes the vague English middle-person claim", () => {
    expect(article.langs.en.sections[3].body[0]).not.toContain(
      "confirm no one is sitting in the middle",
    );
  });

  it("records the material revision date", () => {
    expect(article.updated).toBe("2026-08-07");
  });
});
