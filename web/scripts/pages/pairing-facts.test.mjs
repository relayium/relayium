// web/scripts/pages/pairing-facts.test.mjs — a COMPLETENESS guard for the
// pairing-code flow, in all nine locales.
//
// content-claims.test.mjs already stops the tutorials from saying something
// FALSE about a pairing code (a code no server could issue, "sending needs no
// account", "direct first, relay as fallback"). This file covers the other half,
// which nothing watched: a tutorial that teaches the flow and quietly leaves out
// the one fact most likely to make the reader's attempt fail.
//
// The fact is the five-minute life of a code (`signal.CodeTTLSeconds` = 300).
// Reading a code down a phone line, walking to the other room, or stopping to
// read the next paragraph all take longer than people expect; when it lapses the
// other end simply refuses the code, with nothing on screen explaining why. When
// this file landed, 5 of the browser how-tos that teach the flow never mentioned
// it — including `howto-same-wifi`, where the pairing code is the documented
// fallback for exactly the reader whose devices did not find each other.
//
// ── Why the list is explicit ────────────────────────────────────────────────
// "Mentions a pairing code" is not the same as "teaches the pairing flow".
// `cli-server-to-server` mentions one to say it needs none; `guides-is-it-safe`
// discusses it as a security property. Making those articles recite a TTL would
// be noise, and a heuristic that tried to tell the two apart across nine locales
// would be exactly the kind of clever rule that fails silently.
//
// So the classification is written down — and the PARTITION is asserted, which
// is what keeps the list from rotting: every tutorial article that mentions a
// pairing code must appear in one of the two lists below. A new article, or an
// old one that starts explaining the flow, fails here until someone classifies
// it deliberately.
import { describe, expect, it } from "vitest";
import { articles } from "../gen-pages.mjs";
import { LANGS } from "./shared.mjs";

/** Articles that teach the reader to obtain and use a pairing code. */
const TEACHES_THE_FLOW = [
  "how-to/send-files-on-the-same-wifi",
  "how-to/transfer-files-android-to-iphone",
  "how-to/send-files-pc-to-phone-wirelessly",
  "how-to/send-files-between-two-computers-over-the-internet",
  "how-to/airdrop-for-windows-and-android",
  "how-to/transfer-files-between-mac-and-windows",
  "how-to/transfer-files-by-scanning-a-qr-code",
  "how-to/send-text-between-devices",
  "guides/transfer-files-from-terminal",
  "guides/send-a-file-to-someone",
  "guides/receive-files-from-the-command-line",
];

/** Articles where a pairing code is referred to, but not taught. */
const MENTIONS_ONLY = [
  "how-to/send-a-folder",
  "guides/is-it-safe-to-send-files-over-the-internet",
  "guides/what-is-peer-to-peer-file-transfer",
  "guides/push-to-cloud-pull-on-another-computer",
  "guides/server-to-server-transfers",
];

// The term each locale uses for a pairing code — the GLOSSARY.md row, except
// Arabic, which writes it indefinitely (رمز اقتران) in running prose.
const TERM = {
  en: "pairing code", zh: "配对码", ja: "ペアリングコード", ko: "페어링 코드",
  de: "Pairing-Code", fr: "code d'appairage", ar: "اقتران",
  es: "código de emparejamiento", pt: "código de emparelhamento",
};

// Five minutes, written the way each locale writes it. Both the spelled-out and
// the numeric form are accepted: the choice belongs to the translator, not here.
const FIVE_MINUTES = {
  en: /five minutes|5 minutes/, zh: /5 ?分钟|五分钟/, ja: /5\s?分|五分/, ko: /5\s?분/,
  de: /fünf Minuten|5 Minuten/, fr: /cinq minutes|5 minutes/,
  ar: /خمس دقائق|5 دقائق/, es: /cinco minutos|5 minutos/, pt: /cinco minutos|5 minutos/,
};

/** Every string in one locale of an article, flattened. */
function textOf(doc) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(doc);
  return out.join("\n");
}

const TUTORIAL = /^(how-to|guides)\//;
const bySlug = new Map(articles.map((a) => [a.slug, a]));

describe("pairing-code facts", () => {
  it("classifies every tutorial that mentions a pairing code", () => {
    // The partition. Without this, the two lists below are a snapshot of who
    // remembered, and a new tutorial joins the corpus unwatched.
    const mentioning = articles
      .filter((a) => TUTORIAL.test(a.slug))
      .filter((a) => textOf(a.langs.en).includes(TERM.en))
      .map((a) => a.slug);
    const classified = new Set([...TEACHES_THE_FLOW, ...MENTIONS_ONLY]);
    expect(mentioning.filter((s) => !classified.has(s))).toEqual([]);
  });

  it("lists only slugs that exist", () => {
    // A renamed article would otherwise drop out of the guard silently.
    const missing = [...TEACHES_THE_FLOW, ...MENTIONS_ONLY].filter((s) => !bySlug.has(s));
    expect(missing).toEqual([]);
  });

  it("states the five-minute code life wherever the flow is taught", () => {
    const bad = [];
    for (const slug of TEACHES_THE_FLOW) {
      for (const lang of LANGS) {
        const text = textOf(bySlug.get(slug).langs[lang]);
        if (!FIVE_MINUTES[lang].test(text)) bad.push(`${slug} [${lang}]`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("still names a pairing code in every locale of those articles", () => {
    // Guards the guard: if a translation stopped using the glossary term, the
    // rule above would keep passing while the article drifted.
    const bad = [];
    for (const slug of TEACHES_THE_FLOW) {
      for (const lang of LANGS) {
        const text = textOf(bySlug.get(slug).langs[lang]);
        if (!text.includes(TERM[lang])) bad.push(`${slug} [${lang}]`);
      }
    }
    expect(bad).toEqual([]);
  });
});
