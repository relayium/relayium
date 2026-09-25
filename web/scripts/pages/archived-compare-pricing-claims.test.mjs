// web/scripts/pages/archived-compare-pricing-claims.test.mjs — W-N47. The
// archived (frozen) translations of the Dropbox, Google Drive and Nextcloud
// comparisons used to answer "is Relayium free?" with a flat yes and "no paid
// tier", and their cost bullet called Relayium free outright. The hosted
// service is not: cross-network relay and stored links draw on a monthly
// traffic allowance, stored data has a separate cap, and paid plans raise both
// (the maintained en/zh passages of the same articles say so).
//
// Only the cost bullet and that FAQ answer were corrected, in their own
// languages, keeping the free/open-source software fact and the honest
// Nextcloud comparison. This file pins that for all 21 page/locale pairs: the
// old claims are gone from source and generated page, the allowance, storage
// cap, paid-plan and same-network facts are present in both, and each page
// still carries its archive notice linking the maintained versions.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FROZEN_LANGS } from "./shared.mjs";
import dropbox from "./content/articles/compare-dropbox.mjs";
import drive from "./content/articles/compare-google-drive.mjs";
import nextcloud from "./content/articles/compare-nextcloud.mjs";

const publicDir = resolve(import.meta.dirname, "..", "..", "public");

const unesc = (s) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Each article: its cost bullet (sections[4].bullets[5]) and the FAQ answer to
// "is it free?" — the only two passages that make a price claim.
const PAGES = [
  { slug: "compare/dropbox", article: dropbox, faq: 3 },
  { slug: "compare/google-drive", article: drive, faq: 3 },
  { slug: "compare/nextcloud", article: nextcloud, faq: 4 },
];
const passages = (page, lang) => {
  const l = page.article.langs[lang];
  return { bullet: l.sections[4].bullets[5], faq: l.faq.items[page.faq].a };
};

// The claims as they were published, one exact phrase each.
const OLD = {
  ja: ["より大きく、より速い転送を解放する有料プランはありません", "有料プランはありません", "Relayium は無料で AGPL-3.0"],
  ko: ["더 크거나 빠른 전송을 여는 유료 등급은 없습니다", "유료 등급이 없습니다", "Relayium은 무료이며 AGPL-3.0"],
  de: ["kein Bezahltarif", "ohne bezahlten Tarif", "Relayium ist kostenlos und AGPL-3.0-lizenziert"],
  fr: ["aucune offre payante", "sans offre payante", "Relayium est gratuit et sous licence"],
  ar: ["لا فئة مدفوعة", "دون طبقة مدفوعة", "بلا فئة مدفوعة", "Relayium مجاني ومرخّص", "Relayium مجاني ومرخَّص"],
  es: ["ningún nivel de pago", "no hay un plan de pago", "sin nivel de pago", "Relayium es gratis y con licencia", "Relayium es gratis y está bajo licencia"],
  pt: ["não há nível pago", "sem plano pago", "sem nível pago", "o Relayium é gratuito e licenciado"],
};

// A flat "yes" to "is it free?" is itself the old claim.
const YES = { ja: "はい", ko: "네", de: "Ja", fr: "Oui", ar: "نعم", es: "Sí", pt: "Sim" };

// The corrected facts: monthly allowance, separate storage cap, paid plans
// raise both, same-network transfers free.
const FACTS = {
  ja: ["月間転送量の枠", "別のストレージ上限", "有料プランではその両方が引き上げられます", "同じネットワーク内の"],
  ko: ["월간 트래픽 허용량", "별도의 저장 용량 한도", "유료 요금제는 둘 다 높여", "같은 네트워크 안의"],
  de: ["Datenkontingent", "Speicherlimit", "Tarife erhöhen beides", "im selben Netz"],
  fr: ["quota de trafic mensuel", "limite de stockage distincte", "offres payantes relèvent", "même réseau"],
  ar: ["حصة حركة البيانات الشهرية", "حدّ تخزين منفصل", "والخطط المدفوعة ترفع كليهما", "على نفس الشبكة"],
  es: ["franquicia mensual de tráfico", "límite de almacenamiento aparte", "planes de pago amplían ambos", "misma red"],
  pt: ["cota mensal de tráfego", "limite de armazenamento separado", "planos pagos aumentam ambos", "mesma rede"],
};
// The software fact that stays true.
const OPEN_SOURCE = ["AGPL-3.0"];

const count = (hay, needle) => hay.split(needle).length - 1;

describe.each(FROZEN_LANGS)("archived %s compare pricing claims", (lang) => {
  it("has old-claim and fact lists for this locale", () => {
    expect(OLD[lang]?.length).toBeGreaterThanOrEqual(3);
    expect(FACTS[lang]).toHaveLength(4);
    expect(YES[lang]).toBeTruthy();
  });

  it.each(PAGES.map((p) => [p.slug, p]))("source %s: old claims gone, facts stated", (_slug, page) => {
    const { bullet, faq } = passages(page, lang);
    for (const [where, s] of [["bullet", bullet], ["faq", faq]]) {
      for (const old of OLD[lang]) expect(s, `${where}: ${old}`).not.toContain(old);
      for (const fact of FACTS[lang]) expect(s, `${where}: ${fact}`).toContain(fact);
      for (const fact of OPEN_SOURCE) expect(s, `${where}: ${fact}`).toContain(fact);
    }
    expect(faq.startsWith(YES[lang]), "faq still opens with a flat yes").toBe(false);
    // No other string of this locale's article revives an old claim.
    const all = JSON.stringify(page.article.langs[lang]);
    for (const old of OLD[lang]) expect(all, old).not.toContain(old);
  });

  it.each(PAGES.map((p) => [p.slug, p]))("generated %s: corrected, archived, linked to the maintained versions", (slug) => {
    const html = readFileSync(resolve(publicDir, lang, slug, "index.html"), "utf8");
    const text = unesc(html);
    for (const old of OLD[lang]) expect(text, old).not.toContain(old);
    // Each fact is stated in both the comparison bullet and the FAQ answer.
    for (const fact of FACTS[lang]) expect(count(text, fact), fact).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/<aside class="archived"/);
    expect(html).toContain(`<a href="/${slug}/" lang="en"`);
    expect(html).toContain(`<a href="/zh/${slug}/" lang="zh-Hans"`);
  });
});
