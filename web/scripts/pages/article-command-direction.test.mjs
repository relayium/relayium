// web/scripts/pages/article-command-direction.test.mjs — commands are code, and
// code is left-to-right in every language.
//
// The document direction is a separate question from the direction of a shell
// command printed inside it. An Arabic article is `dir="rtl"` and must stay that
// way: the prose, the headings, the list items and the ordinary table cells are
// translated copy and are read right-to-left. A `<pre>` holding
// `relayium up ./notes.txt --ttl 24h` is not copy — it is a literal string the
// reader is meant to retype. Inherited RTL, the bidi algorithm treats it as an
// RTL paragraph with embedded LTR runs: neutral characters at the run edges (a
// leading `$`, a trailing `\`, the `|` joining two pipeline stages) resolve to
// the RTL base level and move to the wrong end, and a command whose runs are
// separated by a neutral reorders the runs themselves. The DOM text stays
// correct throughout, which is why this is invisible in a diff and visible on
// screen — and why a reader copying what they SEE types something that fails.
//
// So this file pins two things at once, because either alone is the bug:
//   1. the page is still RTL — no template fix may flatten an Arabic article to
//      LTR to make its commands come out right;
//   2. every command surface declares LTR — section code, step code, expected
//      result, troubleshooting check, the JS-off browser command fallback, and
//      the first-column code cell that already had it.
//
// The invariant is "a command block never inherits RTL", not "every command
// block carries an attribute". On an LTR document `direction:ltr` is already
// what a <pre> computes, so the attribute is emitted only where it changes
// something — and the LTR pages, which are the overwhelming majority of the
// generated tree, keep their previous bare <pre> markup. Both halves are pinned
// below: the RTL page must declare it, the LTR page must not need it.
//
// The synthetic document below is deliberately exhaustive rather than realistic:
// it renders every surface the template can emit in one page, so a NEW command
// surface added to article-template.mjs without direction fails here instead of
// shipping into ~250 archived Arabic pages unnoticed.
import { describe, it, expect } from "vitest";
import { renderArticlePage } from "./article-template.mjs";
import { buildAllPages } from "../gen-pages.mjs";

/** One document exercising every code/command surface the template can render. */
const DOC = {
  title: "عنوان",
  description: "وصف",
  updatedLabel: "آخر تحديث",
  lead: ["فقرة تمهيدية"],
  relatedHeading: "ذات صلة",
  cta: { text: "جرّب", button: "ابدأ" },
  sections: [
    {
      heading: "قسم",
      body: ["نص عادي"],
      // A table: the first column is code (already pinned), the rest is copy.
      table: { head: ["مفتاح", "المعنى"], firstColCode: true, rows: [["--ttl 24h", "مدة الصلاحية"]] },
      // A section-level command block.
      code: ["relayium up ./notes.txt --ttl 24h"],
      // The browser command fallback inside the download builder.
      widget: {
        linkToken: "link", destToken: "dir",
        linkLabel: "الرابط", destLabel: "المجلد",
        linkPlaceholder: "https://relayium.com/#k=…", destPlaceholder: ".",
        copy: "نسخ", copied: "تم النسخ",
      },
      // A procedure, whose steps carry their own commands.
      steps: [
        { text: "الخطوة الأولى", code: ["relayium login"] },
        { text: "الخطوة الثانية", code: ["relayium down '<link>' ."] },
      ],
      // What a working run looks like.
      success: { label: "النتيجة المتوقعة", body: ["يظهر ما يلي"], code: ["Uploaded 1 file"] },
      bullets: ["نقطة"],
      // The check that decides a symptom.
      troubleshooting: {
        label: "حل المشكلات",
        items: [{ symptom: "لا يعمل", code: ["systemctl status relayium"], fix: "أعد المحاولة" }],
      },
    },
  ],
};

const render = (lang) =>
  renderArticlePage({ slug: "guides/x", lang, doc: DOC, updated: "2026-09-01", published: "2026-09-01" });

/** The six command blocks DOC renders, in document order. */
const EXPECTED_COMMANDS = [
  "relayium up ./notes.txt --ttl 24h", // section code
  "relayium down &#39;&lt;link&gt;&#39; &lt;dir&gt;", // widget fallback (escaped)
  "relayium login", // step 1
  "relayium down &#39;&lt;link&gt;&#39; .", // step 2
  "Uploaded 1 file", // expected result
  "systemctl status relayium", // troubleshooting check
];

describe("command blocks are LTR on an RTL page", () => {
  const ar = render("ar");

  it("keeps the Arabic document right-to-left", () => {
    // The whole point of the fix is that it does NOT reach for the easy version.
    expect(ar).toContain('<html lang="ar" dir="rtl">');
  });

  it("declares dir=ltr on every <pre> the template emits", () => {
    const opens = ar.match(/<pre[^>]*>/g) || [];
    expect(opens.length).toBe(EXPECTED_COMMANDS.length);
    expect([...new Set(opens)]).toEqual(['<pre dir="ltr">']);
  });

  it("covers all six command surfaces, not just the easy ones", () => {
    // Counting <pre> alone would pass if a surface stopped rendering entirely.
    for (const cmd of EXPECTED_COMMANDS) {
      expect(ar).toContain(`>${cmd}</code></pre>`);
    }
    // The builder's fallback keeps its hook, so the progressive-enhancement
    // script still finds the element it rewrites.
    expect(ar).toContain('<pre dir="ltr"><code data-cmd>');
  });

  it("puts the direction on the scroll box, not on the inner <code>", () => {
    // <pre> is what carries overflow-x:auto. Pinning <code> instead would fix
    // the character order and still open a wide command scrolled to its right
    // edge, i.e. mid-line, which is the half of the bug that a text-only
    // assertion cannot see.
    expect(ar).not.toMatch(/<pre[^>]*><code dir=/);
  });

  it("keeps the first-column code cell pinned", () => {
    expect(ar).toContain('<code dir="ltr">--ttl 24h</code>');
  });

  it("leaves prose, list items and ordinary table cells to follow the page", () => {
    // A blunt fix — dir="ltr" on the article, on <td>, or on every <li> — would
    // satisfy the assertions above and silently break the Arabic reading order.
    for (const tag of ["p", "td", "th", "li", "ul", "ol", "dt", "dd", "main", "h1", "h2"]) {
      expect(ar).not.toMatch(new RegExp(`<${tag}\\b[^>]*\\bdir=`));
    }
    expect(ar).toContain("<td>مدة الصلاحية</td>");
  });

  it("leaves the LTR page's command blocks bare", () => {
    // The attribute is a correction, and on an LTR document there is nothing to
    // correct: <pre> already computes direction:ltr by inheritance and already
    // starts its overflow at the left edge. Emitting it anyway would rewrite
    // every command block in the generated tree to state what the browser does
    // on its own, so an English page keeps exactly the markup it had before the
    // RTL fix — same commands, same count, no dir attribute anywhere.
    const en = render("en");
    expect(en).toContain('<html lang="en">');
    expect(en).not.toContain('dir="rtl"');
    const opens = en.match(/<pre[^>]*>/g) || [];
    expect(opens.length).toBe(EXPECTED_COMMANDS.length);
    expect([...new Set(opens)]).toEqual(["<pre>"]);
    for (const cmd of EXPECTED_COMMANDS) expect(en).toContain(`>${cmd}</code></pre>`);
    expect(en).toContain("<pre><code data-cmd>");
    // The one thing that is NOT direction-conditional: a firstColCode cell is
    // pinned on every page and predates this fix. It stays that way, so the
    // refactor cannot be mistaken for permission to unpin it.
    expect(en).toContain('<code dir="ltr">--ttl 24h</code>');
  });

  it("differs from the Arabic page only in the command blocks' direction", () => {
    // Guards the narrowness of the branch itself: strip the one attribute the
    // RTL page adds and the two documents' <pre> markup is identical, so the
    // template stayed a single rendering path rather than forking into an RTL
    // variant that can drift.
    const en = render("en");
    const arOpens = (ar.match(/<pre[^>]*>/g) || []).map((t) => t.replace(' dir="ltr"', ""));
    expect(arOpens).toEqual(en.match(/<pre[^>]*>/g));
  });
});

// The template test above proves the renderer. This proves the tree that is
// actually committed and served — including the frozen Arabic translations,
// which the Batch B contract covers explicitly: an archived page may be stale
// copy, but it must not print a command that cannot be typed.
describe("the generated corpus", () => {
  const withCode = buildAllPages().filter((p) => p.html.includes("<pre"));
  const arPages = withCode.filter((p) => p.path.startsWith("ar/"));
  const ltrPages = withCode.filter((p) => !p.path.startsWith("ar/"));

  it("finds both corpora", () => {
    expect(arPages.length).toBeGreaterThan(20);
    expect(ltrPages.length).toBeGreaterThan(arPages.length);
  });

  it("is right-to-left with left-to-right commands, on every Arabic page", () => {
    const bad = [];
    for (const page of arPages) {
      if (!page.html.includes('dir="rtl"')) bad.push(`${page.path}: page is not dir="rtl"`);
      for (const open of page.html.match(/<pre[^>]*>/g) || []) {
        if (open !== '<pre dir="ltr">') bad.push(`${page.path}: ${open}`);
      }
    }
    expect(bad).toEqual([]);
  });

  // The other side of the same contract, and the reason this fix stays inside
  // Batch B: an LTR page must be untouched by it. Asserting the absence here
  // means a future "just pin it everywhere" simplification fails as a test
  // rather than as a ~290-file diff nobody asked for.
  it("leaves every left-to-right page's command blocks bare", () => {
    const bad = [];
    for (const page of ltrPages) {
      if (page.html.includes('dir="rtl"')) bad.push(`${page.path}: an LTR page must not be dir="rtl"`);
      for (const open of page.html.match(/<pre[^>]*>/g) || []) {
        if (open !== "<pre>") bad.push(`${page.path}: ${open}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
