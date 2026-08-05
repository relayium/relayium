// web/scripts/pages/register-glossary.test.mjs — build-time enforcement of the
// *settled register decisions* at the top of content/GLOSSARY.md, over both
// localized corpora at once: the SPA tables (src/lib/i18n/<lang>.ts) and the
// static page content (scripts/pages/content/**/*.mjs).
//
// Why this file exists: GLOSSARY.md says "pick the row, use the row", but until
// now nothing checked. Nine locales × ~44,000 lines of prose drift silently —
// the corpus had 20 violations of its own settled rules when this test landed
// (4 German Siezen in de.ts and 1 in guides-self-host, 3 Japanese あなた,
// 4 Portuguese vocês, 3 pt "on-line", 8 Arabic اً), none of which any of the 44
// other content tests could see.
//
// ── SCOPE, and why it is this narrow ─────────────────────────────────────────
// Only rules that are (a) settled in GLOSSARY.md, (b) mechanically decidable and
// (c) produce ZERO false positives on today's corpus. A locale lint that cries
// wolf gets suppressed, and then it protects nothing. Two rules were measured
// and deliberately left out:
//
//   * fr: the non-breaking space before `: ; ! ?`. fr.ts already carries 195
//     NBSPs, so the convention is real, but ~950 sites across the corpus do not
//     have one. That is its own typography pass, not a lint to bolt on here.
//   * zh: half-width `,;:?` and `()` inside Chinese runs. The corpus is clean
//     today (the 2026-07 machine-translation leftovers were all edited out), so
//     a guard would be free — but the same rule cannot distinguish prose from
//     the code samples and Latin-run punctuation that legitimately sit inside
//     zh strings. Left to a follow-up that separates prose from code first.
//
// ── HOW TO EXTEND ───────────────────────────────────────────────────────────
// Add a row only with an injection proof: put the defect string into one locale,
// run this file, confirm it fails, then revert. A rule nobody has watched fail
// is a rule that does not work. As last verified, every rule below was injected
// once and caught once, with the corpus otherwise green.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import zh from "../../src/lib/i18n/zh.ts";
import ja from "../../src/lib/i18n/ja.ts";
import ko from "../../src/lib/i18n/ko.ts";
import de from "../../src/lib/i18n/de.ts";
import es from "../../src/lib/i18n/es.ts";
import pt from "../../src/lib/i18n/pt.ts";
import ar from "../../src/lib/i18n/ar.ts";

const APP_TABLES = { zh, ja, ko, de, es, pt, ar };

// Same glob as content-claims.test.mjs, for the same reason: a new content file
// is covered the day it lands, not the day someone remembers to list it.
const CONTENT = Object.entries(
  import.meta.glob(["./content/**/*.mjs", "!./content/**/*.test.mjs"], { eager: true }),
).map(([path, mod]) => [path.replace("./content/", ""), mod]);

/** Every string in a value, with the path that reaches it. */
function strings(v, path, out) {
  if (typeof v === "string") out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) strings(x, `${path}.${k}`, out);
  return out;
}

/**
 * Every localized string in the corpus for one locale, as [where, text].
 *
 * `legal: "keep"` yields the legal pages too; `legal: "skip"` drops them. That
 * switch is not a convenience — GLOSSARY.md settles a *different* register for
 * legal copy in three languages (ja お客様, ko 귀하, de Sie), so a formality rule
 * that ran over legal/ would be enforcing the wrong decision there.
 */
function corpus(locale, { legal }) {
  const out = strings(APP_TABLES[locale], `i18n/${locale}`, []);
  for (const [name, mod] of CONTENT) {
    if (legal === "skip" && name.startsWith("legal/")) continue;
    const root = mod.default?.langs ?? mod.default ?? {};
    if (root[locale]) strings(root[locale], `${name}:${locale}`, out);
  }
  return out;
}

/** Locale, rule name, matcher, and whether legal copy is in or out. */
const RULES = [
  // zh — 你 (never 您), and 其他 (never the 其-它 variant).
  { locale: "zh", name: "formal 您 (register is 你)", legal: "skip", re: /您/ },
  { locale: "zh", name: "其它 (the settled form is 其他)", legal: "keep", re: /其它/ },

  // ja — です・ます everywhere; legal uses お客様 and everything else drops the
  // pronoun. あなた/あなたたち is the drift this catches; 私たち/御社 is the
  // first-person half of the same row (当社 or Relayium).
  { locale: "ja", name: "あなた (drop the pronoun outside legal)", legal: "skip", re: /あなた/ },
  { locale: "ja", name: "私たち／御社 (first person is 当社 or Relayium)", legal: "keep", re: /私たち|御社/ },

  // ko — 합니다체, never 당신; legal keeps 귀하.
  { locale: "ko", name: "당신 (drop it, or use 내／본인／기존)", legal: "skip", re: /당신/ },

  // es — tú singular, and neither vosotros nor ustedes (reformulate:
  // "ambos lados", "las dos partes").
  { locale: "es", name: "vosotros／ustedes (reformulate instead)", legal: "keep", re: /\b(vosotros|vosotras|ustedes)\b/i },

  // pt — pt-BR, você and never vocês; "online"/"offline" unhyphenated.
  { locale: "pt", name: "vocês (the register is você)", legal: "keep", re: /\bvoc[eê]s\b/i },
  { locale: "pt", name: "on-line／off-line (write online／offline)", legal: "keep", re: /\bo(n|ff)-line\b/i },

  // ar — tanwīn is written ً then ا. The reversed form اً is what a keyboard
  // produces by accident; it renders as a visibly misplaced mark.
  { locale: "ar", name: "reversed tanwīn اً (write ًا)", legal: "keep", re: /اً/ },
];

// German is not a plain substring rule. Capitalized Sie/Ihnen/Ihr* is formal
// address ONLY away from a sentence start — at a sentence start the very same
// spelling is ordinary "sie/ihr" (it, they, or informal plural you) capitalized
// by position. Blanket matching flagged 13 innocent sentences on this corpus
// ("Sie ist ein Entwicklungs-Build", "Ihr müsst nicht im selben WLAN sein");
// blanking the first word of each sentence leaves only real Siezen.
const SENTENCE_SPLIT = /(?<=[.!?:;])\s+|\n+|(?<=[—–])\s+|(?<=[(„])/;
const SIEZEN = /\b(Sie|Ihnen|Ihre[nmrs]?|Ihr)\b/;

function siezen(text) {
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const rest = sentence.replace(/^\s*\S+/, "");
    if (SIEZEN.test(rest)) return sentence.trim();
  }
  return null;
}

describe("GLOSSARY.md register decisions", () => {
  for (const { locale, name, legal, re } of RULES) {
    it(`${locale}: no ${name}`, () => {
      const bad = corpus(locale, { legal }).filter(([, text]) => re.test(text));
      expect(bad.map(([where, text]) => `${where}: ${text.slice(0, 120)}`)).toEqual([]);
    });
  }

  it("de: no Siezen outside legal/ (the register is du)", () => {
    const bad = corpus("de", { legal: "skip" })
      .map(([where, text]) => [where, siezen(text)])
      .filter(([, hit]) => hit);
    expect(bad.map(([where, hit]) => `${where}: ${hit.slice(0, 120)}`)).toEqual([]);
  });

  // The rules above are worth nothing if the corpus they read is empty — a
  // renamed export or a glob that stops matching would turn every assertion
  // green. Pin the shape instead of trusting it.
  it("reads both corpora for every locale it claims to cover", () => {
    for (const locale of Object.keys(APP_TABLES)) {
      const all = corpus(locale, { legal: "keep" });
      const fromContent = all.filter(([where]) => !where.startsWith("i18n/"));
      expect(all.length, `${locale}: app table`).toBeGreaterThan(500);
      expect(fromContent.length, `${locale}: page content`).toBeGreaterThan(500);
      expect(
        fromContent.filter(([where]) => where.startsWith("legal/")).length,
        `${locale}: legal pages`,
      ).toBeGreaterThan(50);
    }
  });

  // GLOSSARY.md is the only place these decisions are written down. If it is
  // renamed or rewritten past the register table, this file is stale and the
  // reader deserves to be told by a failing test, not by silence.
  it("stays anchored to the register table it enforces", () => {
    const glossary = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "content/GLOSSARY.md"),
      "utf8",
    );
    expect(glossary).toMatch(/## Register decisions \(settled/);
    for (const token of ["`你`, never `您`", "never `あなた`", "Never `당신`", "never `vocês`"]) {
      expect(glossary, `GLOSSARY.md no longer states: ${token}`).toContain(token);
    }
  });
});
