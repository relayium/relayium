import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import en from "../../src/lib/i18n/en.ts";
import zh from "../../src/lib/i18n/zh.ts";
import { cli } from "./content/spa-pages.mjs";

const locales = { en, zh };

const cliTokens = {
  en: [/pinned TLS certificate fingerprints/i, /rendezvous service/i, /endpoints?/i, /network hop/i],
  zh: [/TLS 证书指纹/, /会合服务/, /端点/, /网络路径/],
  ja: [/TLS 証明書フィンガープリント/, /ランデブーサービス/, /エンドポイント/, /ネットワーク経路/],
  ko: [/TLS 인증서 지문/, /랑데부 서비스/, /끝점/, /네트워크 경로/],
  de: [/TLS-Zertifikatsfingerabdr/i, /Rendezvous-Dienst/i, /Endpunkte?/i, /Netzwerk-Hop/i],
  fr: [/certificats TLS/i, /service de rendez-vous/i, /extrémités/i, /saut réseau/i],
  ar: [/بصمات شهادات TLS/, /خدمة الالتقاء/, /الطرفين|أي طرف/u, /مسار الشبكة/],
  es: [/certificados TLS/i, /servicio de encuentro/i, /extremos/i, /ruta de red/i],
  pt: [/certificados TLS/i, /serviço de encontro/i, /pontas/i, /rota de rede/i],
};

const browserTokens = {
  en: [/X25519/, /endpoint public keys/i, /impersonating/i],
  zh: [/X25519/, /端点公钥/, /冒充/],
  ja: [/X25519/, /エンドポイント公開鍵/, /なりすまし/],
  ko: [/X25519/, /끝점 공개 키/, /사칭/],
  de: [/X25519/, /Endpunktschlüssel/i, /imitiert/i],
  fr: [/X25519/, /clés publiques/i, /usurpation/i],
  ar: [/X25519/, /مفاتيح.*العامة/u, /انتحال/u],
  es: [/X25519/, /claves públicas/i, /suplante/i],
  pt: [/X25519/, /chaves públicas/i, /passando/i],
};

describe("public SAS copy", () => {
  it("describes the CLI certificate-fingerprint SAS in every locale", () => {
    for (const [lang, messages] of Object.entries(locales)) {
      const copy = messages.cliPage.mode2Body;
      for (const token of cliTokens[lang]) {
        expect(copy, `${lang}:${token}`).toMatch(token);
      }
    }
  });

  it("describes the browser X25519 endpoint check in every locale", () => {
    for (const [lang, messages] of Object.entries(locales)) {
      const copy = messages.features.items[2].desc;
      for (const token of browserTokens[lang]) {
        expect(copy, `${lang}:${token}`).toMatch(token);
      }
    }
  });

  it("keeps the crawler CLI copy protocol-specific", () => {
    const copy = cli.why.items[1].desc;
    expect(copy).toMatch(/pinned TLS certificate fingerprints/i);
    expect(copy).toMatch(/rendezvous service/i);
    expect(copy).toMatch(/not every network hop/i);
  });

  it("keeps README browser and CLI SAS constructions separate", () => {
    const readme = readFileSync(resolve(process.cwd(), "../README.md"), "utf8");
    expect(readme).toMatch(/X25519 endpoint public keys/);
    expect(readme).toMatch(/pinned TLS certificate fingerprints/);
    expect(readme).toMatch(/detects endpoint impersonation or key substitution/);
  });

  it("removes the old English path-wide guarantees and shared derivation", () => {
    const copy = [
      en.cliPage.mode2Body,
      en.features.items[2].desc,
      cli.why.items[1].desc,
      readFileSync(resolve(process.cwd(), "../README.md"), "utf8"),
    ].join("\n");
    expect(copy).not.toMatch(/derived from the session keys/i);
    expect(copy).not.toMatch(/rule out (?:an eavesdropping )?(?:a )?MITM|rule out a man-in-the-middle/i);
    expect(copy).not.toMatch(/cannot MITM as long as users compare the SAS/i);
  });
});
