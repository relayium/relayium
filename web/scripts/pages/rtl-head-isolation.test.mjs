// web/scripts/pages/rtl-head-isolation.test.mjs — the bidi rules from
// content/GLOSSARY.md ("Arabic: inline placeholders need bidi isolation"),
// checked against the REAL generated pages rather than against the source
// strings, because the defect only exists once a string reaches a head slot.
//
// Two separate failures live here. Both are invisible in a code review and both
// are visible to an Arabic reader:
//
//  1. A head string that OPENS with a Latin word. `dir="rtl"` on <html> governs
//     the page body, but a <title> is resolved by the browser chrome and by
//     search engines from the first strong character — so
//     "Relayium مقابل Snapdrop… آمن؟" resolves LTR and hangs the Arabic question
//     mark off the wrong end, in the tab and in the search result. 13 generated
//     pages shipped this way; the SPA tables had already been fixed by hand
//     (i18n/ar.ts `titleDefault` carries the U+200F), which is exactly how the
//     static pipeline came to be the half nobody rechecked.
//
//  2. An inline placeholder whose Latin run ends in `>` or `]` immediately
//     before Arabic text. The bracket is bidi-neutral between an LTR and an RTL
//     run, so it resolves to the RTL base level, gets MIRRORED (`>` renders as
//     `<`) and jumps to the wrong side. That half was already repaired with
//     U+200E wrappers before this test existed — this pins it at zero rather
//     than discovering it.
import { describe, it, expect } from "vitest";
import { buildAllPages } from "../gen-pages.mjs";

const LRM = "‎";
const RLM = "‏";
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;

const pages = buildAllPages();
const arPages = pages.filter((p) => p.path === "ar/index.html" || p.path.startsWith("ar/"));

/** Every content module's Arabic subtree, by glob so new files are covered. */
const ARABIC_SOURCES = Object.entries(
  import.meta.glob(["./content/**/*.mjs", "!./content/**/*.test.mjs"], { eager: true }),
)
  .map(([path, mod]) => [path.replace("./content/", ""), (mod.default?.langs ?? mod.default ?? {}).ar])
  .filter(([, ar]) => ar);

/** Every string under a value, with the path that reaches it. */
function walk(node, at, cb) {
  if (typeof node === "string") return cb(node, at);
  if (Array.isArray(node)) return node.forEach((x, i) => walk(x, `${at}[${i}]`, cb));
  if (node && typeof node === "object") for (const [k, x] of Object.entries(node)) walk(x, `${at}.${k}`, cb);
}

/** The head slots whose direction is resolved by a consumer, not by our CSS. */
function headStrings(html) {
  const out = [];
  const title = html.match(/<title>(.*?)<\/title>/s)?.[1];
  if (title) out.push(["title", title]);
  for (const m of html.matchAll(
    /<meta (?:name|property)="((?:og:|twitter:)?(?:title|description))" content="([^"]*)"/g,
  )) {
    out.push([m[1], m[2]]);
  }
  return out;
}

describe("Arabic bidi isolation in generated pages", () => {
  it("builds a non-trivial set of ar pages to check", () => {
    // A glob that stops matching would make every assertion below vacuous.
    expect(arPages.length).toBeGreaterThan(30);
    expect(headStrings(arPages[0].html).length).toBeGreaterThanOrEqual(2);
    expect(ARABIC_SOURCES.length).toBeGreaterThan(30);
  });

  it("no ar head string opens with a Latin word without U+200F", () => {
    const bad = [];
    for (const page of arPages) {
      for (const [slot, value] of headStrings(page.html)) {
        if (RTL.test(value) && /^[A-Za-z]/.test(value)) bad.push(`${page.path} ${slot}: ${value.slice(0, 70)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the U+200F it adds is exactly one character, and only where needed", () => {
    // Guards the other direction: a helper that prefixed unconditionally, or
    // twice on a rebuild, would still pass the assertion above.
    const bad = [];
    for (const page of arPages) {
      for (const [slot, value] of headStrings(page.html)) {
        if (value.startsWith(RLM + RLM)) bad.push(`${page.path} ${slot}: doubled U+200F`);
        if (value.startsWith(RLM) && !/^.[A-Za-z]/.test(value)) {
          bad.push(`${page.path} ${slot}: U+200F on copy that does not open with a Latin word`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  // This one reads the SOURCE strings, not the built HTML, and that is the whole
  // point: by the time `--ttl <duration>` reaches a page it has been escaped to
  // `--ttl &lt;duration&gt;`, so a check over the output can never see the `>`
  // whose mirroring is the defect. The first version of this test did scan the
  // HTML, passed on a deliberately broken corpus, and was rewritten.
  it("no Latin placeholder run touches Arabic text without U+200E", () => {
    const bad = [];
    for (const [path, mod] of ARABIC_SOURCES) {
      walk(mod, "", (text, at) => {
        for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9_.:/-]*[>\]][^\n]{0,1}?[֐-ࣿ]/g)) {
          if (!m[0].includes(LRM)) bad.push(`${path}${at}: ${m[0]}`);
        }
      });
    }
    expect(bad).toEqual([]);
  });
});
