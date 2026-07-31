import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import landing from "./content/landing.mjs";

const localeTokens = {
  zh: [/X25519/, /端点公钥/, /冒充端点/, /应用层端到端加密/, /TURN/],
  ja: [/X25519/, /エンドポイント公開鍵/, /なりすまし/, /アプリケーション層/, /TURN/],
  ko: [/X25519/, /끝점 공개 키/, /사칭/, /애플리케이션 계층/, /TURN/],
  de: [/X25519/, /Endpunktschlüssel/i, /imitiert/i, /Anwendung/i, /TURN/],
  fr: [/X25519/, /clés publiques/i, /usurp/i, /applicati/i, /TURN/],
  ar: [/X25519/, /مفاتيح.*العامة/u, /انتحال/u, /مستوى التطبيق/u, /TURN/],
  es: [/X25519/, /claves públicas/i, /suplant/i, /aplicación/i, /TURN/],
  pt: [/X25519/, /chaves públicas/i, /passando/i, /aplicação/i, /TURN/],
};

const oldAbsoluteClaims = [
  /确认一致以排除中间人|即可排除中间人窃听|无法对你发起中间人攻击|无法窃听或冒充/,
  /一致を確認して中間者を排除|中間者攻撃はできません|盗聴やなりすましができません/,
  /일치를 확인하고 중간자를 차단|중간자 공격을 할 수 없습니다|도청이나 위장을 할 수 없습니다/,
  /um einen Man-in-the-Middle auszuschließen|ist ein mithörender Man-in-the-Middle ausgeschlossen|kann keinen Man-in-the-Middle-Angriff durchführen|weder mithören noch sich ausgeben/,
  /pour écarter tout homme du milieu|tout intercepteur est écarté|ne peut pas monter d'attaque|ne peut ni écouter ni usurper/,
  /لاستبعاد أي هجوم وسيط|استُبعد أي متنصّت|لا يستطيع شنّ هجوم وسيط|لا يستطيع خادم إشارة مخترَق التنصّت/,
  /para descartar cualquier intermediario|se descarta cualquier interceptor|no puede montar un ataque de intermediario|no puede escuchar ni suplantar/,
  /para descartar qualquer intermediário|qualquer interceptador é descartado|não consegue montar um ataque de intermediário|não consegue espionar nem se passar/,
];

describe("static landing browser SAS precision", () => {
  it("describes endpoint authentication and the network-path limit in all 8 locales", () => {
    for (const [lang, tokens] of Object.entries(localeTokens)) {
      const doc = landing.langs[lang];
      const surfaces = [
        doc.how.steps[2],
        doc.why.items[2].desc,
        doc.compare.items[1].body,
        doc.faq.items[6].a,
      ];

      for (const [index, copy] of surfaces.entries()) {
        for (const token of tokens) {
          expect(copy, `${lang}:surface-${index}:${token}`).toMatch(token);
        }
      }
    }
  });

  it("removes the localized path-wide SAS guarantees", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/pages/content/landing.mjs"),
      "utf8",
    );
    for (const claim of oldAbsoluteClaims) expect(source).not.toMatch(claim);
  });

  it("keeps the English crawler page precise without rewriting accurate detect copy", () => {
    const index = readFileSync(resolve(process.cwd(), "index.html"), "utf8");

    expect(index).toMatch(/compare it out of band/i);
    expect(index).toMatch(/X25519 endpoint public-key substitution/i);
    expect(index).toMatch(/signaling server impersonating an endpoint/i);
    expect(index).toMatch(/terminating the application-layer end-to-end encryption/i);
    expect(index).toMatch(/does not prove that the network path contains no server or TURN relay/i);
    expect(index).not.toMatch(/compare it to rule out a man-in-the-middle/i);
    expect(index).toMatch(/cannot read or man-in-the-middle the transfer undetected/i);
  });
});
