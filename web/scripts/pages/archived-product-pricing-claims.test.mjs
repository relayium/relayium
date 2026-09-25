// web/scripts/pages/archived-product-pricing-claims.test.mjs — W-N47, the
// rest of the archive after archived-compare-pricing-claims.test.mjs.
//
// The frozen (ja ko de fr ar es pt) homepage and seven more articles answered
// "is it free?" with a totalizing yes: "no charge of any kind" on the homepage,
// "free, no paid tier" for the hosted service on the WeTransfer and Firefox Send
// comparisons, and "completely free, no paid tier, nothing to meter — every
// mode connects the two ends directly" for the CLI on the croc,
// magic-wormhole, scp, rsync and self-hosting pages. None of that is true of
// the product the maintained en/zh pages describe:
//
//   - hosted: same-network transfers are free, but cross-network relay and
//     stored links draw on a monthly traffic allowance, stored data has a
//     separate cap, and paid plans raise them;
//   - CLI: the direct modes are free and unmetered, but `up` stores under the
//     account and counts against the plan's storage limit — and "every mode is
//     direct" was an overstatement in the same sentence.
//
// Only those passages were corrected, each in its own language and from the
// maintained en/zh string at the same path; the free/open-source software fact,
// the free direct modes and the archive notice all stay. This file pins, for
// every case × frozen locale: the old claim is gone from the source string and
// from the generated page (visible FAQ and JSON-LD alike), the corrected facts
// are in the source string, the generated page carries that string, and the
// page still has its archive notice linking the maintained en/zh versions.
//
// The CLI getting-started guide made the same claim in its own words — "No.
// The CLI is completely free … nothing to meter or pay", with a "completely
// free" lead (ja/ko) and CTA — while maintained en/zh say up and down draw on
// four separate plan limits. Its FAQ answer, CTA and ja/ko lead are pinned here
// the same way.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FROZEN_LANGS } from "./shared.mjs";
import landing from "./content/landing.mjs";
import wetransfer from "./content/articles/compare-wetransfer.mjs";
import firefoxSend from "./content/articles/compare-firefox-send.mjs";
import croc from "./content/articles/compare-croc.mjs";
import wormhole from "./content/articles/compare-magic-wormhole.mjs";
import scp from "./content/articles/compare-scp.mjs";
import rsync from "./content/articles/compare-rsync.mjs";
import selfHost from "./content/articles/guides-self-host.mjs";
import cliStart from "./content/articles/cli-getting-started.mjs";

const publicDir = resolve(import.meta.dirname, "..", "..", "public");

const unesc = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const at = (obj, path) => path.split(".").reduce((o, k) => o?.[k], obj);

// ── the vocabulary of the corrected facts, one rendering per locale ──────────
const T = {
  allowance: { ja: "月間転送量の枠", ko: "월간 트래픽 허용량", de: "Datenkontingent", fr: "quota de trafic mensuel", ar: "حصة حركة البيانات الشهرية", es: "franquicia mensual de tráfico", pt: "cota mensal de tráfego" },
  storageCap: { ja: "ストレージ上限", ko: "저장 용량 한도", de: "Speicherlimit", fr: "limite de stockage", ar: "حدّ (ال)?تخزين", es: "límite de almacenamiento", pt: "limite de armazenamento" },
  separateCap: { ja: "別のストレージ上限", ko: "별도의 저장 용량 한도", de: "separate[sn] Speicherlimit", fr: "limite de stockage distincte", ar: "حدّ تخزين منفصل", es: "límite de almacenamiento aparte", pt: "limite de armazenamento separado" },
  paid: { ja: "有料プラン", ko: "유료 요금제", de: "bezahlte Tarife", fr: "offres payantes", ar: "الخطط المدفوعة", es: "planes de pago", pt: "planos pagos" },
  sameNet: { ja: "同じネットワーク内の", ko: "같은 네트워크 안의", de: "im selben Netz", fr: "même réseau", ar: "على نفس الشبكة", es: "misma red", pt: "mesma rede" },
  retention: { ja: "保存期間", ko: "보관 기간", de: "Aufbewahrungsdauer", fr: "durée de conservation", ar: "مدة (ال)?احتفاظ", es: "periodo de retención", pt: "período de retenção" },
  plan: { ja: "プラン", ko: "요금제", de: "Tarif", fr: "offre", ar: "خط(ت|ة)", es: "plan", pt: "plano" },
  unmetered: { ja: "計測", ko: "계량", de: "mess", fr: "mesur", ar: "قياس|يُقاس", es: "medi|mida", pt: "medi" },
  directModes: { ja: "直結", ko: "직접 연결", de: "direkt", fr: "direct", ar: "المباشرة", es: "direct", pt: "diret" },
  direct: { ja: "直接", ko: "직접", de: "direkte", fr: "direct", ar: "مباشر", es: "direct", pt: "diret" },
  hostedStorage: { ja: "ホスト型ストレージ", ko: "호스팅 저장소", de: "gehosteten Speicher", fr: "stockage hébergé", ar: "التخزين المُستضاف", es: "almacenamiento alojado", pt: "armazenamento hospedado" },
  up: { ja: "up", ko: "up", de: "up", fr: "up", ar: "up", es: "up", pt: "up" },
  selfServer: { ja: "relayium.com", ko: "relayium.com", de: "relayium.com", fr: "relayium.com", ar: "relayium.com", es: "relayium.com", pt: "relayium.com" },
  down: { ja: "down", ko: "down", de: "down", fr: "down", ar: "down", es: "down", pt: "down" },
  dailyUpload: { ja: "1日あたりのアップロード上限", ko: "일일 업로드 한도", de: "tägliches Upload-Limit", fr: "limite d'envoi quotidienne", ar: "حدّ رفع يومي", es: "límite de subida diario", pt: "limite diário de upload" },
  openSource: { ja: "オープンソース", ko: "오픈소스", de: "quelloffen", fr: "open source", ar: "مفتوح المصدر", es: "código abierto", pt: "código aberto" },
};
const HOSTED = ["allowance", "separateCap", "paid", "sameNet"];

// A whole-product "is it free?" answer must not open with a bare yes: that is
// the claim, whatever the rest of the paragraph goes on to qualify.
const YES = { ja: ["無料です", "はい"], ko: ["무료입니다", "네"], de: ["Ja"], fr: ["Oui"], ar: ["نعم"], es: ["Sí"], pt: ["Sim"] };
// Likewise a "does the CLI cost anything?" answer must not open with a bare no.
const NO = { ja: ["いいえ"], ko: ["아니요"], de: ["Nein"], fr: ["Non"], ar: ["لا."], es: ["No."], pt: ["Não"] };
// The hosted-service "Yes. Relayium is free and open source" opening, verbatim.
const YES_FREE = {
  ja: ["はい。Relayium は AGPL-3.0 ライセンスの無料オープンソース"], ko: ["네. Relayium은 AGPL-3.0 라이선스의 무료 오픈소스"],
  de: ["Ja. Relayium ist kostenlos und quelloffen"], fr: ["Oui. Relayium est gratuit et open source"],
  ar: ["نعم. Relayium مجاني ومفتوح المصدر"], es: ["Sí. Relayium es gratis y de código abierto"], pt: ["Sim. O Relayium é gratuito e de código aberto"],
};
// The CLI answer's "no paid tier, nothing to meter, every mode is direct".
const CLI_TOTAL = {
  ja: ["完全に無料です。有料プランはなく", "有料プランはなく", "どのモードでも両端が直接つながり"],
  ko: ["네, 완전히 무료입니다", "유료 등급이 없고", "모든 모드가 양쪽을 직접 연결"],
  de: ["keine bezahlte Stufe", "jeder Modus verbindet die beiden Enden direkt"],
  fr: ["aucun palier payant", "chaque mode connecte directement"],
  ar: ["لا فئة مدفوعة", "لا توجد فئة مدفوعة", "كل وضع يوصل الطرفين", "كل وضع يصل الطرفين"],
  es: ["No hay ningún nivel de pago", "No hay un nivel de pago", "sin nivel de pago", "cada modo conecta"],
  pt: ["Não há nível pago", "sem nível pago", "cada modo conecta"],
};

// Each case: a page, the one string that made the claim, the exact old phrases
// that must be gone (page-wide once generated), and the facts it must now state.
const CASES = [
  {
    name: "landing faq 'is it free?'", page: landing, slug: "", path: "faq.items.0.a", wholeProduct: true,
    old: { ja: ["料金は一切かかりません", "無料です。Relayium"], ko: ["비용은 전혀 들지 않습니다", "무료입니다. Relayium"], de: ["ohne jede Gebühr nutzbar", "Ja. Relayium ist Open Source"], fr: ["sans aucun frais", "Oui. Relayium est open source"], ar: ["دون أي رسوم", "نعم. Relayium مفتوح"], es: ["sin coste alguno", "Sí. Relayium es de código abierto"], pt: ["sem custo algum", "Sim. O Relayium é de código aberto"] },
    facts: [...HOSTED, "retention"],
  },
  {
    name: "wetransfer cost bullet", page: wetransfer, slug: "compare/wetransfer", path: "sections.4.bullets.5",
    old: { ja: ["Relayium は無料で AGPL-3.0"], ko: ["Relayium은 무료이며 AGPL-3.0"], de: ["Relayium ist kostenlos und AGPL-3.0-lizenziert"], fr: ["Relayium est gratuit et sous licence"], ar: ["Relayium مجاني ومرخّص"], es: ["Relayium es gratis y está bajo licencia"], pt: ["o Relayium é gratuito e licenciado"] },
    facts: HOSTED,
  },
  {
    name: "wetransfer faq 'is Relayium free?'", page: wetransfer, slug: "compare/wetransfer", path: "faq.items.2.a", wholeProduct: true,
    old: { ja: ["より大きなリアルタイム転送を解放する有料プランはありません", ...YES_FREE.ja], ko: ["더 큰 실시간 전송을 여는 유료 등급은 없습니다", ...YES_FREE.ko], de: ["Es gibt keinen Bezahltarif", ...YES_FREE.de], fr: ["Il n'y a pas d'offre payante", ...YES_FREE.fr], ar: ["لا فئة مدفوعة لفتح", ...YES_FREE.ar], es: ["No hay nivel de pago para desbloquear", ...YES_FREE.es], pt: ["Não há nível pago para desbloquear", ...YES_FREE.pt] },
    facts: HOSTED,
  },
  {
    name: "firefox-send faq 'is Relayium free?'", page: firefoxSend, slug: "compare/firefox-send", path: "faq.items.3.a", wholeProduct: true,
    old: YES_FREE,
    facts: ["storageCap", "retention", "paid", "sameNet"],
  },
  {
    name: "croc overlap body", page: croc, slug: "compare/croc", path: "sections.0.body.0",
    old: { ja: ["完全無料で有料プランはなく"], ko: ["유료 등급 없이 완전히 무료"], de: ["völlig kostenlos ohne bezahlte Stufe"], fr: ["entièrement gratuits sans palier payant"], ar: ["مجاني تمامًا بلا فئة مدفوعة"], es: ["completamente gratis sin ningún nivel de pago"], pt: ["completamente gratuitas sem nenhum nível pago"] },
    facts: ["direct"],
  },
  {
    name: "croc cost bullet", page: croc, slug: "compare/croc", path: "sections.5.bullets.5",
    old: { ja: ["AGPL-3.0 ライセンスで完全に無料"], ko: ["둘 다 완전 무료"], de: ["beide völlig kostenlos"], fr: ["tous deux entièrement gratuits"], ar: ["وكلاهما مجاني تمامًا"], es: ["ambas completamente gratis"], pt: ["ambas completamente gratuitas"] },
    facts: ["direct"],
  },
  { name: "croc faq 'is the CLI free?'", page: croc, slug: "compare/croc", path: "faq.items.0.a", old: CLI_TOTAL, facts: ["directModes", "unmetered", "up", "storageCap", "plan"] },
  { name: "magic-wormhole faq 'is the CLI free?'", page: wormhole, slug: "compare/magic-wormhole", path: "faq.items.0.a", old: CLI_TOTAL, facts: ["directModes", "unmetered", "up", "storageCap", "plan"] },
  {
    name: "scp faq 'is the CLI free?'", page: scp, slug: "compare/scp", path: "faq.items.4.a",
    old: { ...CLI_TOTAL, ja: [...CLI_TOTAL.ja, "はい、完全に無料です"], de: [...CLI_TOTAL.de, "Ja, vollständig"], fr: [...CLI_TOTAL.fr, "Oui, entièrement"], ar: [...CLI_TOTAL.ar, "نعم، بالكامل"], es: [...CLI_TOTAL.es, "Sí, por completo"], pt: [...CLI_TOTAL.pt, "Sim, totalmente"] },
    facts: ["unmetered", "up", "plan", "hostedStorage"],
  },
  {
    name: "rsync 'where sync wins' bullet", page: rsync, slug: "compare/rsync", path: "sections.5.bullets.3",
    old: { ja: ["どの転送モードも無料"], ko: ["어떤 전송 모드든 무료"], de: ["für jeden Übertragungsmodus kostenlos"], fr: ["gratuit pour n'importe quel mode de transfert"], ar: ["مجاني لأي وضع نقل"], es: ["gratis para cualquier modo de transferencia"], pt: ["gratuito para qualquer modo de transferência"] },
    facts: ["directModes", "unmetered"],
  },
  {
    name: "rsync faq 'is it free?'", page: rsync, slug: "compare/rsync", path: "faq.items.4.a",
    old: { ja: ["Relayium CLI は完全に無料です"], ko: ["Relayium CLI는 완전히 무료입니다"], de: ["Die Relayium-CLI ist vollständig kostenlos"], fr: ["La CLI Relayium est entièrement gratuite"], ar: ["إن CLI في Relayium مجاني تمامًا"], es: ["La CLI de Relayium es completamente gratis"], pt: ["A CLI do Relayium é completamente gratuita"] },
    facts: ["unmetered", "up", "storageCap", "plan"],
  },
  {
    name: "self-host --server bullet", page: selfHost, slug: "guides/self-host-relayium", path: "sections.4.bullets.0",
    old: {}, // an omission, not a phrase: the facts below are the whole assertion
    facts: ["up", "selfServer", "plan", "hostedStorage"],
  },
  {
    name: "self-host faq 'still free if I self-host?'", page: selfHost, slug: "guides/self-host-relayium", path: "faq.items.1.a",
    old: { ja: ["CLI は完全無料です"], ko: ["CLI는 완전히 무료입니다"], de: ["Die CLI bleibt mit relayium.com wie mit deinem eigenen Server kostenlos"], fr: ["La CLI reste gratuite avec relayium.com comme avec votre serveur"], ar: ["يبقى الـ CLI مجانيًا مع relayium.com أو خادمك"], es: ["La CLI sigue siendo gratis con relayium.com o con tu servidor"], pt: ["A CLI continua gratuita com relayium.com ou com o seu servidor"] },
    facts: ["unmetered", "up", "storageCap", "plan"],
  },
  {
    name: "cli-getting-started faq 'does the CLI cost anything?'", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "faq.items.0.a", noOpener: true,
    old: { ja: ["完全に無料", "支払うものもありません"], ko: ["완전히 무료", "지불할 것도"], de: ["völlig kostenlos", "und nichts zu bezahlen"], fr: ["entièrement gratuit", "rien à mesurer ni à payer"], ar: ["مجاني تمامًا", "ولا شيء لدفعه"], es: ["completamente gratis", "nada que medir ni pagar"], pt: ["totalmente gratuit", "nada a medir nem pagar"] },
    facts: ["openSource", "directModes", "unmetered", "up", "down", "allowance", "storageCap", "retention", "dailyUpload", "paid"],
  },
  {
    name: "cli-getting-started cta", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "cta.text",
    old: { ja: ["完全無料"], ko: ["완전 무료"], de: ["völlig kostenlos"], fr: ["entièrement gratuit"], ar: ["مجاني تمامًا"], es: ["completamente gratis"], pt: ["totalmente gratuit"] },
    facts: ["openSource", "direct"],
  },
  {
    name: "cli-getting-started lead", page: cliStart, slug: "guides/transfer-files-from-terminal", path: "lead.0", langs: ["ja", "ko"],
    old: { ja: ["完全無料"], ko: ["완전 무료"] },
    facts: ["openSource"],
  },
];

const hasFact = (s, key, lang) => new RegExp(T[key][lang]).test(s);
const pagePath = (slug, lang) => resolve(publicDir, lang, slug, "index.html");

describe.each(FROZEN_LANGS)("archived %s product pricing claims", (lang) => {
  it("has a vocabulary entry for this locale", () => {
    for (const key of Object.keys(T)) expect(T[key][lang], `${key}`).toBeTruthy();
  });

  const cases = CASES.filter((c) => !c.langs || c.langs.includes(lang)).map((c) => [c.name, c]);

  it.each(cases)("source %s: old claim gone, facts stated", (_n, c) => {
    const s = at(c.page.langs[lang], c.path);
    expect(typeof s, c.path).toBe("string");
    for (const old of c.old[lang] ?? []) expect(s, `old: ${old}`).not.toContain(old);
    for (const key of c.facts) expect(hasFact(s, key, lang), `fact ${key}: ${T[key][lang]}`).toBe(true);
    if (c.wholeProduct) {
      expect(s, "whole-product answer still states the AGPL software fact").toContain("AGPL-3.0");
      for (const y of YES[lang]) expect(s.startsWith(y), `opens with a bare "${y}"`).toBe(false);
    }
    if (c.noOpener) for (const n of NO[lang]) expect(s.startsWith(n), `opens with a bare "${n}"`).toBe(false);
  });

  it.each(cases)("generated %s: corrected, archived, linked to the maintained versions", (_n, c) => {
    const html = readFileSync(pagePath(c.slug, lang), "utf8");
    const text = unesc(html);
    expect(text, "generated page carries the corrected source string").toContain(at(c.page.langs[lang], c.path));
    for (const old of c.old[lang] ?? []) expect(text, `old: ${old}`).not.toContain(old);
    expect(html).toMatch(/<aside class="archived"/);
    expect(html).toMatch(/<p class="archived-links archived-pricing">[^<]+<a href="\/pricing">/);
    const twin = c.slug ? `${c.slug}/` : "";
    expect(html).toContain(`<a href="/${twin}" lang="en"`);
    expect(html).toContain(`<a href="/zh/${twin}" lang="zh-Hans"`);
  });
});
