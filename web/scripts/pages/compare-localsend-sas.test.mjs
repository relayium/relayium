import { describe, expect, it } from "vitest";
import { LANGS } from "./shared.mjs";
import localSend from "./content/articles/compare-localsend.mjs";

const CLAIMS = {
  en: {
    outOfBand: /out of band/i,
    keys: /endpoint public keys were not replaced/i,
    impersonation: /signaling service or TURN relay impersonating an endpoint/i,
    path: /does not prove that TURN is absent from the network path/i,
    ciphertext: /relay still carries only ciphertext/i,
  },
  zh: {
    outOfBand: /带外方式/,
    keys: /端点公钥未被替换/,
    impersonation: /冒充端点的信令服务或 TURN 端点/i,
    path: /不能证明 TURN 不在网络路径上/i,
    ciphertext: /中继只承载密文/,
  },
  ja: {
    outOfBand: /帯域外/,
    keys: /エンドポイントの公開鍵が置き換えられていない/,
    impersonation: /シグナリングサービスや TURN エンドポイントによるなりすまし/i,
    path: /TURN がネットワーク経路上にないことを証明するものではありません/i,
    ciphertext: /リレーが運ぶのは暗号文だけ/,
  },
  ko: {
    outOfBand: /대역 외/,
    keys: /엔드포인트 공개 키가 바뀌지 않았음/,
    impersonation: /시그널링 서비스나 TURN 엔드포인트를 탐지/i,
    path: /TURN이 네트워크 경로에 없다는 사실을 증명하지 않습니다/i,
    ciphertext: /릴레이는 암호문만 전달/,
  },
  de: {
    outOfBand: /separaten Kanal/i,
    keys: /öffentlichen Schlüssel der Endpunkte nicht ersetzt/i,
    impersonation: /Signalisierungsdienst oder TURN-Endpunkt/i,
    path: /beweist nicht, dass TURN außerhalb des Netzwerkpfads liegt/i,
    ciphertext: /Relay weiterhin ausschließlich Chiffretext/i,
  },
  fr: {
    outOfBand: /hors bande/i,
    keys: /clés publiques des terminaux n'ont pas été remplacées/i,
    impersonation: /service de signalisation ou un terminal TURN/i,
    path: /ne prouve pas que TURN est absent du trajet réseau/i,
    ciphertext: /relais continue de ne transporter que du texte chiffré/i,
  },
  ar: {
    outOfBand: /عبر قناة خارجية/u,
    keys: /المفاتيح العامة للطرفين لم تُستبدل/u,
    impersonation: /خدمة إشارات أو نقطة نهاية TURN/u,
    path: /لا يثبت تحقق SAS أن TURN غير موجود في مسار الشبكة/u,
    ciphertext: /المُرحِّل يحمل النص المُشفَّر فقط/u,
  },
  es: {
    outOfBand: /fuera de banda/i,
    keys: /claves públicas de los extremos no fueron sustituidas/i,
    impersonation: /servicio de señalización o extremo TURN/i,
    path: /no demuestra que TURN esté fuera de la ruta de red/i,
    ciphertext: /retransmisor sigue transportando solo texto cifrado/i,
  },
  pt: {
    outOfBand: /fora de banda/i,
    keys: /chaves públicas dos endpoints não foram substituídas/i,
    impersonation: /serviço de sinalização ou endpoint TURN/i,
    path: /não prova que o TURN esteja fora do caminho da rede/i,
    ciphertext: /retransmissor continua transportando apenas texto cifrado/i,
  },
};

describe("LocalSend comparison SAS claims", () => {
  it("defines what out-of-band SAS verifies without hiding the TURN path in all locales", () => {
    for (const lang of LANGS) {
      const paragraph = localSend.langs[lang].sections[2].body[1];
      for (const [claim, pattern] of Object.entries(CLAIMS[lang]))
        expect(paragraph, `${lang} must preserve the ${claim} boundary`).toMatch(pattern);
    }

    expect(localSend.updated).toBe("2026-07-31");
  });
});
