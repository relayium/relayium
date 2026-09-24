#!/usr/bin/env node
// Migrated from web/scripts/pages/public-sas-copy.test.mjs with assertions preserved.
// Root documentation changes do not select web.yml; repo-hygiene.yml runs this
// dependency-free Node check on main pushes and through merge-gate on PRs. Inputs resolve from this module. Keep this as the sole owner of these tests.
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import en from "../../web/src/lib/i18n/en.ts";
import zh from "../../web/src/lib/i18n/zh.ts";
import { cli } from "../../web/scripts/pages/content/spa-pages.mjs";

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

// The `send / receive` mode's whole prose, lead plus boundary notes. It used to
// be one string (cliPage.mode2Body); reading the mode as a whole rather than one
// numbered note means moving a sentence between paragraphs cannot silently drop
// the SAS construction out of what this test checks.
const sendReceiveCopy = (m) =>
  [m.cliPage.modes.sendReceive.lead, ...m.cliPage.modes.sendReceive.notes].join("\n");

// Named, not indexed: the crawler shell now lists seven modes, and an index into
// that array would quietly start checking a different mode the next time the
// order changes.
const shellMode = (name) => cli.why.items.find((i) => i.title === name).desc;

describe("public SAS copy", () => {
  it("describes the CLI certificate-fingerprint SAS in every locale", () => {
    for (const [lang, messages] of Object.entries(locales)) {
      const copy = sendReceiveCopy(messages);
      for (const token of cliTokens[lang]) {
        assert.match(copy, token, `${lang}:${token}`);
      }
    }
  });

  it("describes the browser X25519 endpoint check in every locale", () => {
    for (const [lang, messages] of Object.entries(locales)) {
      const copy = messages.features.items[2].desc;
      for (const token of browserTokens[lang]) {
        assert.match(copy, token, `${lang}:${token}`);
      }
    }
  });

  it("keeps the crawler CLI copy protocol-specific", () => {
    const copy = shellMode("send / receive");
    assert.match(copy, /pinned TLS certificate fingerprints/i);
    assert.match(copy, /rendezvous service/i);
    assert.match(copy, /not every network hop/i);
  });

  it("keeps README browser and CLI SAS constructions separate", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    assert.match(readme, /X25519 endpoint public keys/);
    assert.match(readme, /pinned TLS certificate fingerprints/);
    assert.match(readme, /detects endpoint impersonation or key substitution/);
  });

  it("removes the old English path-wide guarantees and shared derivation", () => {
    const copy = [
      sendReceiveCopy(en),
      en.features.items[2].desc,
      shellMode("send / receive"),
      readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
    ].join("\n");
    assert.doesNotMatch(copy, /derived from the session keys/i);
    assert.doesNotMatch(copy, /rule out (?:an eavesdropping )?(?:a )?MITM|rule out a man-in-the-middle/i);
    assert.doesNotMatch(copy, /cannot MITM as long as users compare the SAS/i);
  });
});
