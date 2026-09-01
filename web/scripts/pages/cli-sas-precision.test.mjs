import { describe, expect, it } from "vitest";

import send from "./content/articles/cli-send-to-someone.mjs";
import croc from "./content/articles/compare-croc.mjs";
import receive from "./content/articles/guides-receive-from-cli.mjs";

const locales = ["en", "zh", "ja", "ko", "de", "fr", "ar", "es", "pt"];
const articles = { send, croc, receive };

const localeTokens = {
  en: [/certificate fingerprints/i, /rendezvous service/i, /endpoints?/i, /network hop/i],
  zh: [/证书指纹/, /会合服务/, /端点/, /网络路径/],
  ja: [/証明書フィンガープリント/, /ランデブーサービス/, /エンドポイント/, /ネットワーク経路/],
  ko: [/인증서 지문/, /랑데부 서비스/, /끝점/, /네트워크 경로/],
  de: [/Zertifikatsfingerabdr/i, /Rendezvous-Dienst/i, /Endpunkte?/i, /Netzwerk-Hop/i],
  fr: [/certificats TLS/i, /service de rendez-vous/i, /extrémités/i, /saut réseau/i],
  ar: [/بصمات شهادات TLS/, /خدمة الالتقاء/, /الطرفين|أي طرف/, /مسار الشبكة/],
  es: [/certificados TLS/i, /servicio de encuentro/i, /extremos/i, /ruta de red/i],
  pt: [/certificados TLS/i, /serviço de encontro/i, /pontas/i, /rota de rede/i],
};

// The SAS pass dated all three 2026-07-31. `send` was then rebuilt as a runnable
// tutorial (cli-tutorial-structure.test.mjs) and re-dated for it; `receive` was
// factually rewritten later still, in the CLI-page batch, and carries that date
// (cli-mode-chooser.test.mjs). `croc` was touched by neither and keeps the
// original. Pinning them separately is the point — a single shared date would
// hide exactly that.
const REVISED = { send: "2026-08-07", croc: "2026-07-31", receive: "2026-09-01" };

describe("CLI article SAS precision", () => {
  it("keeps all three articles current and structurally complete in nine locales", () => {
    for (const [name, article] of Object.entries(articles)) {
      expect(article.updated, name).toBe(REVISED[name]);
      expect(Object.keys(article.langs), name).toEqual(expect.arrayContaining(locales));
      for (const locale of locales) {
        expect(article.langs[locale]?.sections?.length, `${name}:${locale}`).toBeGreaterThan(0);
      }
    }
  });

  it("describes certificate-fingerprint endpoint authentication in every locale", () => {
    for (const [name, article] of Object.entries(articles)) {
      for (const locale of locales) {
        const copy = JSON.stringify(article.langs[locale]);
        for (const token of localeTokens[locale]) {
          expect(copy, `${name}:${locale}:${token}`).toMatch(token);
        }
      }
    }
  });

  it("pins the English CLI semantics and preserves the direct-only path", () => {
    for (const [name, article] of Object.entries(articles)) {
      const copy = JSON.stringify(article.langs.en);
      expect(copy, name).toMatch(/pinned TLS certificate fingerprints/i);
      expect(copy, name).toMatch(/not (?:prove|every) (?:every )?network hop/i);
      expect(copy, name).toMatch(/direct-only|direct only/i);
      expect(copy, name).toMatch(/rather than (?:falling back|routing).*relay/i);
    }
  });

  it("removes session-key derivation and path-wide MITM guarantees", () => {
    const copy = JSON.stringify(articles);
    expect(copy).not.toMatch(/derived from the session keys|from the session keys/i);
    expect(copy).not.toMatch(/For a hard guarantee/i);
    expect(copy).not.toMatch(
      /nobody sat in the middle|there's no one in the middle|to be sure no one is in the middle/i,
    );
    expect(copy).not.toMatch(/会话密钥|セッション鍵|세션 키|Sitzungsschlüsseln|clés de session|مفاتيح الجلسة|claves de sesión|chaves de sessão/);
  });
});
