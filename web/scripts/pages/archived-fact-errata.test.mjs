// web/scripts/pages/archived-fact-errata.test.mjs — W-N50, W-N51, W-N52.
//
// Three factual errors survived the W-N47 pricing errata because they were not
// about price:
//
//   - W-N50, compare/croc (every locale, maintained en/zh included): the overlap
//     paragraph said both tools are open source "under a permissive license",
//     and the license/cost bullet said both are AGPL-3.0. croc is MIT
//     (github.com/schollz/croc LICENSE); the Relayium CLI lives in server/ and
//     is AGPL-3.0-only (root LICENSE index). Neither "both" is true.
//   - W-N51, guides/self-host-relayium (frozen locales): the TURN section said
//     the relay profile's Redis instance is there "for relay-byte metering".
//     server/main.go guardCoturnRedisMetering never starts that ingest, so
//     relayed bytes are not counted; maintained en/zh already say so.
//   - W-N52, guides/transfer-files-from-terminal (frozen locales): lead.1 said
//     bytes go direct "whichever way you use it", and the "do my files pass
//     through Relayium's servers?" answer opened with a bare "No. In every
//     mode…". up stores an encrypted copy under the account. The corrected text
//     scopes the claim to the direct modes and names up, as maintained en/zh do.
//     Maintained en/zh faq.items.3.a called up "the deliberate exception", but
//     the installable v0.26.0 CLI also ships `relayium inbox` — receive-only,
//     "There is no CLI sender for it" (run.go usage) — whose tasks central
//     holds as ciphertext until the device downloads them (internal/inbox).
//     That answer now names both server-held paths; it must not advertise the
//     source-only pair command or an inbox sender. The archived answers say
//     "up is different/not direct" (pinned by UP_NOT_DIRECT), never "the only".
//
// For each passage and locale this pins: the old claim is gone from the source
// string and from the generated page (visible text and JSON-LD alike), the
// corrected fact is in the source string, and the generated page carries it.
// Frozen pages must also keep their archive notice linking the en/zh versions.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FROZEN_LANGS, MAINTAINED_LANGS } from "./shared.mjs";
import croc from "./content/articles/compare-croc.mjs";
import selfHost from "./content/articles/guides-self-host.mjs";
import cliStart from "./content/articles/cli-getting-started.mjs";

const publicDir = resolve(import.meta.dirname, "..", "..", "public");
const unesc = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const at = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);
const pagePath = (slug, lang) => resolve(publicDir, lang === "en" ? "" : lang, slug, "index.html");

// ── W-N50: the old "both" claims, verbatim per locale ────────────────────────
const BOTH_PERMISSIVE = {
  en: ["under a permissive license so"], zh: ["都以宽松许可证开源"], ja: ["寛容なライセンスでオープンソース化"],
  ko: ["둘 다 관대한 라이선스로"], de: ["unter einer freizügigen Lizenz quelloffen"], fr: ["open source sous une licence permissive"],
  ar: ["مفتوح المصدر برخصة متساهلة"], es: ["abierto bajo una licencia permisiva"], pt: ["aberto sob uma licença permissiva"],
};
const BOTH_AGPL = {
  en: ["both AGPL-3.0-licensed"], zh: ["都是 AGPL-3.0 许可"], ja: ["どちらも AGPL-3.0 ライセンス"],
  ko: ["둘 다 AGPL-3.0 라이선스"], de: ["Beide AGPL-3.0-lizenziert"], fr: ["les deux sous licence AGPL-3.0"],
  ar: ["كلاهما مرخّص بـ AGPL-3.0"], es: ["ambas con licencia AGPL-3.0"], pt: ["ambas licenciadas sob AGPL-3.0"],
};
// The corrected passage attributes MIT to croc and AGPL-3.0 to Relayium, in
// that order, within the one sentence.
const LICENSE_FACT = /croc[^.。]*MIT[^.。]*Relayium[^.。]*AGPL-3\.0/;

// ── W-N51: the old metering claim and the corrected "disabled" fact ─────────
const REDIS_OLD = {
  ja: ["リレーバイト計測用の小さな Redis"], ko: ["릴레이 바이트 계량용 소형 Redis"], de: ["Redis-Instanz für die Zählung der Relay-Bytes"],
  fr: ["Redis pour la mesure des octets relayés"], ar: ["Redis صغيرة لقياس بايتات الترحيل"],
  es: ["Redis para la medición de bytes retransmitidos"], pt: ["Redis para a medição de bytes retransmitidos"],
};
const DISABLED = {
  en: /currently disabled/, zh: /目前已停用/, ja: /現在無効/, ko: /현재 비활성화/, de: /derzeit deaktiviert/,
  fr: /actuellement désactivée/, ar: /معطَّل حاليًا/, es: /desactivada actualmente/, pt: /desativada no momento/,
};
const NOT_COUNTED = {
  en: /not counted/, zh: /不会被计入/, ja: /計上されません/, ko: /집계되지 않습니다/, de: /nicht gezählt/,
  fr: /ne sont pas comptés/, ar: /لا تُحتسب/, es: /no se contabilizan/, pt: /não são contabilizados/,
};

// ── W-N52: the old totalizing transport claims and the scoped replacement ───
const EVERY_WAY = {
  ja: ["どの方法を使っても"], ko: ["어떤 방식을 쓰든"], de: ["Egal welchen Weg du nutzt"], fr: ["Quelle que soit la méthode utilisée"],
  ar: ["أيًا كانت الطريقة التي تستخدمها بها"], es: ["Sea cual sea la forma en que la uses"], pt: ["Seja qual for a forma que você usar"],
};
const EVERY_MODE = {
  ja: ["どのモードでも"], ko: ["어떤 모드에서든"], de: ["In jedem Modus"], fr: ["Dans tous les modes"],
  ar: ["في كل وضع"], es: ["En todos los modos"], pt: ["Em todos os modos"],
};
const BARE_NO = { ja: "いいえ", ko: "아니요", de: "Nein", fr: "Non", ar: "لا.", es: "No.", pt: "Não." };
const DIRECT_MODES = {
  ja: /直結モード/, ko: /직접 연결 모드/, de: /direkten Modi/, fr: /modes directs/, ar: /الأوضاع المباشرة/, es: /modos directos/, pt: /modos diretos/,
};
const UP_NOT_DIRECT = {
  ja: /up は(直結ではありません|異なります)/, ko: /up은 (직접 연결이 아닙니다|다릅니다)/, de: /up ist (nicht direkt|anders)/,
  fr: /up (n'est pas direct|est différent)/, ar: /up (فليس مباشرًا|فمختلف)/, es: /up (no es directo|es distinto)/, pt: /O up (não é direto|é diferente)/,
};
const ENCRYPTED = { ja: /暗号化/, ko: /암호화/, de: /verschlüsselte/, fr: /chiffrée/, ar: /مُشفَّرة/, es: /cifrada/, pt: /criptografada/ };
// Commands or features that are not in the installable v0.26.0 CLI (or whose
// released shape differs) must not be introduced by this errata.
const NOT_RELEASED = /\b(pair|inbox)\b|Inbox|收件箱|受信箱|수신함|Posteingang|boîte de réception|صندوق الوارد|bandeja de entrada|caixa de entrada/;

// Maintained en/zh FAQ: both server-held paths named, no sole-exception claim,
// and nothing that only exists after v0.26.0.
const SOLE_EXCEPTION = {
  en: ["up is the deliberate exception", "the only exception", "sole exception"],
  zh: ["up 是有意为之的例外", "唯一的例外", "唯一例外"],
};
const TWO_EXCEPTIONS = {
  en: [/Two modes are the deliberate exceptions/, /server holds only ciphertext it cannot read/,
    /up uploads an encrypted copy to your account's storage/,
    /Device Inbox — receive-only in the CLI, through relayium inbox — queues an encrypted copy/],
  zh: [/有两种模式是有意为之的例外/, /只保存无法读取的密文/, /up 会把加密副本上传到你账号的存储里/,
    /设备收件箱（在 CLI 中只有接收侧，即 relayium inbox）/, /加密副本排队存着/],
};
const POST_V026 = /\bpair\b|配对会话|inbox send|CLI (sender|command that sends)|SSH transfers are (currently )?disabled|SSH 传输/;

const CASES = [
  ...["sections.0.body.0", "sections.5.bullets.5"].map((path) => ({
    task: "W-N50", page: croc, slug: "compare/croc", path, langs: [...MAINTAINED_LANGS, ...FROZEN_LANGS],
    old: (l) => [...BOTH_PERMISSIVE[l], ...BOTH_AGPL[l]],
    facts: () => [LICENSE_FACT],
  })),
  {
    task: "W-N51", page: selfHost, slug: "guides/self-host-relayium", path: "sections.2.body.1", langs: [...MAINTAINED_LANGS, ...FROZEN_LANGS],
    old: (l) => REDIS_OLD[l] ?? [],
    facts: (l) => [/Redis/, DISABLED[l], NOT_COUNTED[l]],
  },
  {
    task: "W-N52", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "lead.1", langs: FROZEN_LANGS,
    old: (l) => EVERY_WAY[l],
    facts: (l) => [DIRECT_MODES[l], UP_NOT_DIRECT[l], ENCRYPTED[l]],
    notReleased: true,
  },
  {
    task: "W-N52", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "faq.items.3.a", langs: FROZEN_LANGS,
    old: (l) => EVERY_MODE[l],
    facts: (l) => [DIRECT_MODES[l], UP_NOT_DIRECT[l], ENCRYPTED[l]],
    bareNo: true, notReleased: true,
  },
  {
    task: "W-N52", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "faq.items.3.a", langs: MAINTAINED_LANGS,
    old: (l) => SOLE_EXCEPTION[l],
    facts: (l) => [/push、pull|push, pull/, ...TWO_EXCEPTIONS[l]],
    postV026: true,
  },
];

const rows = CASES.flatMap((c) => c.langs.map((lang) => [`${c.task} ${c.slug} ${c.path} ${lang}`, c, lang]));

describe("archived factual errata (W-N50/W-N51/W-N52)", () => {
  it.each(rows)("source %s: old claim gone, corrected fact stated", (_n, c, lang) => {
    const s = at(c.page.langs[lang], c.path);
    expect(typeof s, c.path).toBe("string");
    for (const old of c.old(lang)) expect(s, `old: ${old}`).not.toContain(old);
    for (const re of c.facts(lang)) expect(s, `fact ${re}`).toMatch(re);
    if (c.bareNo) expect(s.startsWith(BARE_NO[lang]), `opens with a bare "${BARE_NO[lang]}"`).toBe(false);
    if (c.notReleased) expect(s).not.toMatch(NOT_RELEASED);
    if (c.postV026) expect(s).not.toMatch(POST_V026);
  });

  it.each(rows)("generated %s: carries the corrected string, not the old one", (_n, c, lang) => {
    const html = readFileSync(pagePath(c.slug, lang), "utf8");
    const text = unesc(html);
    expect(text, "generated page carries the corrected source string").toContain(at(c.page.langs[lang], c.path));
    for (const old of c.old(lang)) expect(text, `old: ${old}`).not.toContain(old);
    if (FROZEN_LANGS.includes(lang)) {
      expect(html).toMatch(/<aside class="archived"/);
      expect(html).toContain(`<a href="/${c.slug}/" lang="en"`);
      expect(html).toContain(`<a href="/zh/${c.slug}/" lang="zh-Hans"`);
    } else {
      expect(html).not.toMatch(/<aside class="archived"/);
    }
  });
});
