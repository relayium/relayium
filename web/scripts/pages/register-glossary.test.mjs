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
// wolf gets suppressed, and then it protects nothing.
//
// One half of one row is deliberately left out: the French NBSP before a COLON.
// An earlier note in this file claimed ~950 sites were missing it and called for
// a typography pass. That number was wrong — it came from counting colons in the
// TypeScript SOURCE of fr.ts, where almost every one is object syntax. Against
// the parsed corpus the real figure was 122 strings, all fixed in the commit that
// added this rule; what remains uncoverable is the colon, because the three sites
// that legitimately keep a bare one are quoted machine output — `relayium-node:
// command not found` and the `environment:` block key, which all nine locales
// write exactly that way. So `; ! ?`, which machine output does not produce in
// that position, carries the rule and the colon stays a reviewer's judgement.
//
// The zh half-width punctuation rule was left out at first for a reason that
// turned out to be wrong — "it cannot separate prose from code samples". It does
// not need to: keying on a CJK NEIGHBOUR rather than on the field makes Latin
// runs, paths, flags and numbers inside zh strings invisible to it, and the
// measurement across the whole corpus including code blocks is zero either way.
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

/**
 * The app-side corpus, for the locales the app still ships.
 *
 * Since the 2026-08-14 language freeze that is Chinese alone among the rule
 * locales — English has no register rule here. The other six keep their rules,
 * running over the PAGE corpus only: those pages are archived but still public,
 * and an edit to one still has to obey the register decision it was written
 * under. What is gone is the app half, because there is no ja/ko/de/es/pt/ar
 * message table to read (see src/lib/i18n/archive/README.md).
 *
 * `LOCALES` below is what the completeness guard iterates, so a locale losing
 * its app table cannot silently lose its page coverage too.
 */
const APP_TABLES = { zh };

/** Every locale these rules cover, app table or not. */
const LOCALES = ["zh", "ja", "ko", "de", "es", "pt", "ar"];

// Same glob as content-claims.test.mjs, for the same reason: a new content file
// is covered the day it lands, not the day someone remembers to list it.
const CONTENT = Object.entries(
  import.meta.glob(["./content/**/*.mjs", "!./content/**/*.test.mjs"], { eager: true }),
).map(([path, mod]) => [path.replace("./content/", ""), mod]);

// Arguments to render a message function with. A locale table is full of
// `(n) => \`… ${n} …\`` and `(name) => \`… ${name} …\``, and the two shapes want
// different values — a count that formats, and a string that does not throw on
// .toUpperCase(). Try in order, keep the first that returns a string.
const RENDER_ARGS = [1, "x", 0, [], null];

/**
 * Every string in a value, with the path that reaches it.
 *
 * Message FUNCTIONS are rendered, not skipped. They are prose with a hole in it,
 * and skipping them left a real blind spot: 16 of the French non-breaking spaces
 * this file now enforces live inside `(n) => …` templates that a string-only walk
 * never visits. `renderFailures` records anything that would not render, so the
 * blind spot cannot come back silently.
 */
const renderFailures = [];
function strings(v, path, out) {
  if (typeof v === "string") out.push([path, v]);
  else if (typeof v === "function") {
    for (const arg of RENDER_ARGS) {
      try {
        const r = v(...Array.from({ length: Math.max(v.length, 1) }, () => arg));
        if (typeof r === "string") return out.push([path, r]);
      } catch {
        // next shape
      }
    }
    renderFailures.push(path);
  } else if (Array.isArray(v)) v.forEach((x, i) => strings(x, `${path}[${i}]`, out));
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
  const out = APP_TABLES[locale] ? strings(APP_TABLES[locale], `i18n/${locale}`, []) : [];
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

  // zh — full-width ，：；？（）. The rule is written as CJK ADJACENCY rather than
  // "no half-width punctuation in a zh string", because a zh string legitimately
  // carries Latin runs, paths, flags and numbers whose own punctuation is
  // half-width and must stay so: "docs/x.md", "--ttl 1d", "1,000".
  //
  // Adjacency is what the 2026-07 machine-translation leftovers actually looked
  // like — "更进一步:文件…已经加密,而这把密钥", "（上限取决于套餐）,或首次下载后即焚" —
  // and it is a shape correct Chinese never produces. It needed no prose-vs-code
  // exclusion in the end: measured across the whole corpus INCLUDING code blocks,
  // all four forms are zero, because the discriminator is the CJK neighbour and
  // not the field the string sits in. A Chinese comment inside a code sample is
  // prose too (GLOSSARY.md says translate them), so catching one there is right.
  { locale: "zh", name: "half-width punctuation between CJK", legal: "keep", re: /[一-鿿々〇][,;:?!][一-鿿々〇]/ },
  { locale: "zh", name: "half-width punctuation closing a CJK clause", legal: "keep", re: /[一-鿿々〇][,;:?!](\s|$)/ },
  { locale: "zh", name: "half-width punctuation opening a CJK clause", legal: "keep", re: /[,;:?!][一-鿿々〇]/ },

  // fr — one rendering of "pairing code", not two. GLOSSARY.md settles
  // `code d'appairage`; `guides-receive-from-cli` had drifted to `code de
  // jumelage` in 8 places (plus the matching verb `se jumeler`) while the other
  // 127 sites across the corpus used the settled term. This is the "2–6
  // competing renderings" problem GLOSSARY.md was written for, caught by the
  // completeness guard in pairing-facts.test.mjs rather than by a reader.
  { locale: "fr", name: "jumelage／jumeler (the settled term is appairage)", legal: "keep", re: /jumel/i },

  // fr — a no-break space before ; ! ? (see the colon note in the header for the
  // half that is not enforced). A plain space would let the mark wrap to the next
  // line on its own, which is the visible defect this prevents.
  //
  // This is the one rule that needs the code exclusion the zh rules turned out not
  // to need, and for a reason that is specific to it: French typography is about
  // the space around a mark, and a shell sample is full of marks with ordinary
  // spacing — `…; do echo`, `Accept and remember this peer? [y/N]`. There is no
  // neighbouring character that separates those from prose, only the field.
  {
    locale: "fr",
    name: "missing no-break space before ; ! ?",
    legal: "keep",
    skipCode: true,
    re: /[^\u00a0][;!?](\s|$)/,
  },
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
  for (const { locale, name, legal, re, skipCode } of RULES) {
    it(`${locale}: no ${name}`, () => {
      const bad = corpus(locale, { legal })
        .filter(([where]) => !(skipCode && /\.code\[/.test(where)))
        .filter(([, text]) => re.test(text));
      expect(bad.map(([where, text]) => `${where}: ${text.slice(0, 120)}`)).toEqual([]);
    });
  }

  it("de: no Siezen outside legal/ (the register is du)", () => {
    const bad = corpus("de", { legal: "skip" })
      .map(([where, text]) => [where, siezen(text)])
      .filter(([, hit]) => hit);
    expect(bad.map(([where, hit]) => `${where}: ${hit.slice(0, 120)}`)).toEqual([]);
  });

  // Rendering message functions is the difference between checking a locale
  // table and checking most of one. If a future table shape makes them
  // unrenderable, the rules would quietly stop seeing that copy — so say so.
  it("renders every message function it walks", () => {
    for (const locale of LOCALES) corpus(locale, { legal: "keep" });
    expect(renderFailures).toEqual([]);
  });

  // The rules above are worth nothing if the corpus they read is empty — a
  // renamed export or a glob that stops matching would turn every assertion
  // green. Pin the shape instead of trusting it.
  it("reads both corpora for every locale it claims to cover", () => {
    for (const locale of LOCALES) {
      const all = corpus(locale, { legal: "keep" });
      const fromContent = all.filter(([where]) => !where.startsWith("i18n/"));
      const fromApp = all.filter(([where]) => where.startsWith("i18n/"));
      // A maintained locale must contribute both halves; an archived one has no
      // app table by construction, and asserting it does would be asserting the
      // freeze never happened.
      expect(fromApp.length, `${locale}: app table`).toBeGreaterThan(APP_TABLES[locale] ? 500 : -1);
      expect(Boolean(APP_TABLES[locale]), `${locale}: app table presence`)
        .toBe(locale === "zh");
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
