// web/scripts/pages/article-template.mjs — renders one article (one language) to a
// self-contained static HTML string. No external CSS: styles are inlined so the
// page is independent of the Vite asset graph and crawlable with JS disabled. The
// only scripts are the pre-paint theme snippet every page in this tree carries
// and, on the handful of pages with a command builder, BUILDER_SCRIPT.
import { MAINTAINED_LANGS, DEFAULT_LANG, LANG_LABELS, GUIDES_LABELS, APPS_LABELS, pricingLabel, PRICING_URL, BCP47, OG_LOCALE, OG_IMAGE_META, SITE, urlPath, absUrl, esc, ctaHref, landingUrl, dirAttr, RTL_LANGS, rtlHead, isFrozen, archiveNotice, ARCHIVE_STYLE } from "./shared.mjs";
import { pageStyle, THEME_HEAD } from "./page-chrome.mjs";
import { appShell } from "./page-shell.mjs";

// Footer link label; matches content/landing.mjs footer.privacy per language.
const PRIVACY_LABELS = {
  en: "Privacy", zh: "隐私政策", ja: "プライバシーポリシー",
  ko: "개인정보 처리방침", de: "Datenschutz", fr: "Confidentialité",
  ar: "الخصوصية", es: "Privacidad", pt: "Privacidade",
};

// What this one template owns. Everything else — tokens, reading typography,
// the header band, the footer, `.cta`, `.langbar`, `.crumbs`, `pre`/`code` —
// comes from page-chrome.mjs, which all six templates share.
const STYLE = pageStyle(`
.ctacard{margin:40px 0 8px;padding:22px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
.ctacard p{margin:0 0 14px}
/* Related reading is a row of destinations, not a paragraph of links: each one
   is a card, so the end of an article looks like the rest of the product
   instead of a bare <ul>. */
.related{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:8px}
@media(min-width:620px){.related{grid-template-columns:repeat(2,minmax(0,1fr))}}
.related li{margin:0}
.related a{display:block;padding:12px 14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);color:var(--text-h);text-decoration:none;font-size:var(--fs-sm);line-height:1.45;transition:border-color .13s,color .13s}
.related a:hover{border-color:var(--accent-border);color:var(--accent-fg)}
@media(prefers-reduced-motion:reduce){.related a{transition:none}}
`);

/**
 * The language bar, on the maintained pages only.
 *
 * A frozen page gets `archiveNotice()` in this slot instead. That is the whole
 * difference: a selector says "pick a language, they are all current", and for
 * seven of them that is no longer true. The notice says what the page is and
 * links to the same two destinations the bar would have offered.
 */
function langBar(slug, lang) {
  if (isFrozen(lang)) return archiveNotice(lang, { en: urlPath(slug, "en"), zh: urlPath(slug, "zh") });
  const links = MAINTAINED_LANGS.map((l) => {
    const cur = l === lang ? " aria-current=\"true\"" : "";
    return `<a href="${urlPath(slug, l)}"${cur}>${esc(LANG_LABELS[l])}</a>`;
  });
  return `<nav class="langbar" aria-label="Language">${links.join("")}</nav>`;
}

/**
 * The hreflang cluster: English, Simplified Chinese, and x-default at English.
 *
 * The seven archived locales are deliberately absent, and their own pages emit
 * no cluster at all (see below). hreflang declares "these URLs are the same
 * page in the languages this site offers" and is reciprocal by design — listing
 * /ja/ here would claim Japanese is on offer, and listing English from /ja/
 * without the return link is the broken-cluster shape Search Console reports.
 * Archived pages keep a self-referential canonical, stay `index, follow` and
 * stay in the sitemap; they are simply not alternates of the current page.
 *
 * Callers gate on `isFrozen` and interpolate the result with its own leading
 * newline, so a frozen page emits no cluster and no blank line where one used
 * to be — the generated tree is committed, and a line of trailing indentation
 * on ~250 archived pages is what `git diff --check` exists to refuse.
 */
function alternates(slug) {
  const links = MAINTAINED_LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath(slug, l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath(slug, DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

// Every command block is left-to-right, for the same reason the firstColCode
// table cell is (see tableHtml): a shell command is code, and code is read
// left-to-right in every language. Inherited from <html dir="rtl"> the bidi
// algorithm treats the command as an RTL paragraph containing embedded LTR runs,
// so neutral characters at the edges — a leading `$`, a trailing `\`, the `|`
// between two pipeline stages — resolve to the RTL base level and move to the
// wrong end, and a command split across runs reorders the runs themselves. A
// reader copying what they see would type something that does not run.
//
// The attribute goes on <pre>, not on <code>, because <pre> is the box that
// carries `overflow-x:auto`: in an RTL context a scrollable box also starts
// scrolled to its right edge, so a wide command would open mid-line. Setting
// direction on the container fixes the text order and the scroll origin at once.
// It is deliberately NOT set on prose, list items or ordinary table cells —
// those are translated copy and must follow the page.
//
// It is emitted only when the document itself is RTL. An LTR document already
// computes `direction:ltr` on every <pre> by inheritance, so spelling it out
// there would change ~290 generated files to assert what the browser already
// does. The invariant this file owns is "a command block never inherits RTL",
// and on an LTR page that holds with no attribute at all. The flag is threaded
// from renderArticlePage rather than read from a module global so the two
// directions stay one rendering path with one branch, not two templates.
//
// CommandBlock.svelte pins its own <pre> unconditionally because the SPA renders
// one document whose direction changes at runtime with the locale switch; here
// the direction is known at generation time, per file.
//
// `tabindex="0"` for the same reason CommandBlock.svelte carries it: `overflow-x`
// makes the block a scrollable region, and a region that only a mouse wheel or a
// trackpad swipe can move is a command a keyboard reader cannot finish reading
// (WCAG 2.1.1; axe's scrollable-region-focusable). It bites hardest on a phone,
// where almost every command is wider than the column — which is why the 390px
// dark a11y target added on 2026-09-21 is what finally reported it. The block
// scrolls at every width, so the attribute is unconditional.
const codeBlockHtml = (text, rtl, attrs = "") =>
  `<pre tabindex="0"${rtl ? ' dir="ltr"' : ""}><code${attrs}>${esc(text)}</code></pre>`;

// widgetHtml renders an interactive command builder that degrades gracefully:
// with JS off it's a plain <pre> showing the command template (real,
// crawlable content) plus two labelled inputs; the inline BUILDER_SCRIPT
// (injected only when a page uses a widget) upgrades it to live-build the
// `relayium down '<link>' <dir>` command and reveal a Copy button. Only the
// "downloadBuilder" kind exists today.
function widgetHtml(w, rtl) {
  const fallback = `relayium down '<${w.linkToken}>' <${w.destToken}>`;
  return (
    `\n      <div class="builder" data-download-builder>` +
    `<label class="bf"><span>${esc(w.linkLabel)}</span>` +
    `<input data-link type="text" placeholder="${esc(w.linkPlaceholder)}" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" data-token="${esc(w.linkToken)}" /></label>` +
    `<label class="bf"><span>${esc(w.destLabel)}</span>` +
    `<input data-dest type="text" placeholder="${esc(w.destPlaceholder)}" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" /></label>` +
    `<div class="bcmd">${codeBlockHtml(fallback, rtl, " data-cmd")}` +
    `<button type="button" class="bcopy" data-copy data-copied="${esc(w.copied)}" hidden>${esc(w.copy)}</button></div>` +
    `</div>`
  );
}

// tableHtml renders a two-or-more column table. Wrapped in .tw so a wide table
// scrolls inside its own box instead of making the whole page scroll sideways.
// firstColCode monospaces the first cell of every row (config directives, env
// vars) without needing markup in the content files. Direction is inherited from
// <html dir>; the cell alignment is `text-align:start`, a logical property, so
// RTL pages need no separate rule.
//
// The code cell itself is pinned dir="ltr" regardless of page direction. A cell
// holding two LTR runs joined by punctuation from the page's own script (e.g. an
// Arabic comma between two systemd directives) is, to the bidi algorithm, a
// right-to-left context containing two embedded LTR runs — which reorders the
// runs themselves, not just the punctuation between them. `firstColCode` cells
// are always literal config/env text meant to read left-to-right exactly as
// written, in every language, so direction is fixed rather than inherited.
function tableHtml(t) {
  const head = t.head?.length
    ? `<thead><tr>${t.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>`
    : "";
  const body = (t.rows || [])
    .map(
      (r) =>
        `<tr>${r
          .map((c, i) => `<td>${i === 0 && t.firstColCode ? `<code dir="ltr">${esc(c)}</code>` : esc(c)}</td>`)
          .join("")}</tr>`
    )
    .join("");
  return `\n      <div class="tw"><table>${head}<tbody>${body}</tbody></table></div>`;
}

// ── Tutorial blocks ─────────────────────────────────────────────────────────
// A how-to needs four things a wall of prose and bullets cannot express: what
// you must have before you start, the procedure in order, what a working run
// actually looks like, and what to do when it doesn't. Four optional per-section
// fields carry them, so a section keeps its existing narrative (body, code,
// bullets) and gains structure only where structure is the point.
//
// They are separate fields rather than a `kind` on the generic bullet list
// because each renders as a DIFFERENT element: prerequisites are an unordered
// list, a procedure is an <ol> (numbering that survives a reordered step, a
// screen reader, and a reader-mode extraction — a "1." typed into a bullet
// string survives none of those), an expected result is a labelled note, and
// troubleshooting is a <dl> whose <dt> is the symptom you are looking at.
//
// `data-block` on each is for the tests, not for CSS or script: it names the
// concept in the output, so a guard can assert that an article really renders a
// procedure as an <ol> rather than matching a class that a restyle could rename.

const codeHtml = (blocks, rtl) => (blocks || []).map((b) => codeBlockHtml(b, rtl)).join("");

// prereqsHtml — "you need these before step 1". An unordered list: the items are
// conditions to satisfy in any order, not a sequence.
function prereqsHtml(p) {
  return (
    `\n      <div class="cbox prereq" data-block="prereqs">` +
    `<p class="cbox-t">${esc(p.label)}</p>` +
    `<ul>${p.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` +
    `</div>`
  );
}

// stepsHtml — the procedure, as a real ordered list. A step may carry its own
// command block, which lands inside its <li> so the command stays attached to
// the step that runs it.
function stepsHtml(steps, rtl) {
  const items = steps
    .map((s) => `<li><p>${esc(s.text)}</p>${codeHtml(s.code, rtl)}</li>`)
    .join("");
  return `\n      <ol class="steps" data-block="steps">${items}</ol>`;
}

// successHtml — what the reader compares their terminal against. Labelled, so
// it reads as "this is the expected result" rather than as one more code sample.
function successHtml(s, rtl) {
  return (
    `\n      <div class="cbox ok" data-block="success">` +
    `<p class="cbox-t">${esc(s.label)}</p>` +
    (s.body || []).map((p) => `<p>${esc(p)}</p>`).join("") +
    codeHtml(s.code, rtl) +
    `</div>`
  );
}

// troubleshootHtml — a description list, because that is exactly the shape of
// the content: the <dt> is the symptom the reader can see, the <dd> is the check
// that decides it and the fix that follows. Each item's `code` is the check —
// something to run, or an exact state to look at.
function troubleshootHtml(t, rtl) {
  const items = t.items
    .map((i) => `<dt>${esc(i.symptom)}</dt><dd>${codeHtml(i.code, rtl)}<p>${esc(i.fix)}</p></dd>`)
    .join("");
  return (
    `\n      <div class="cbox fix" data-block="troubleshooting">` +
    `<p class="cbox-t">${esc(t.label)}</p>` +
    `<dl>${items}</dl>` +
    `</div>`
  );
}

function sectionHtml(s, rtl) {
  let out = `<h2>${esc(s.heading)}</h2>`;
  if (s.prereqs) out += prereqsHtml(s.prereqs);
  for (const p of s.body || []) out += `\n      <p>${esc(p)}</p>`;
  if (s.table) out += tableHtml(s.table);
  for (const block of s.code || []) out += `\n      ${codeBlockHtml(block, rtl)}`;
  if (s.widget) out += widgetHtml(s.widget, rtl);
  if (s.steps?.length) out += stepsHtml(s.steps, rtl);
  if (s.success) out += successHtml(s.success, rtl);
  if (s.bullets?.length) out += `\n      <ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
  if (s.troubleshooting) out += troubleshootHtml(s.troubleshooting, rtl);
  return out;
}

// Styles for tableHtml, emitted only on pages that actually contain a table —
// same gating as BUILDER_STYLE, so the other 390-odd articles stay byte-for-byte
// free of it. `text-align:start` is deliberate (not `left`): it is a logical
// property, so an RTL page picks up right alignment from <html dir="rtl"> with
// no direction-specific rule anywhere.
const TABLE_STYLE = `<style>
.tw{overflow-x:auto;margin:16px 0;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
.tw table{border-collapse:collapse;inline-size:100%;font-size:var(--fs-sm)}
.tw th,.tw td{border-block-end:1px solid var(--sep);padding:10px 14px;text-align:start;vertical-align:top}
.tw tr:last-child td{border-block-end:0}
.tw th{color:var(--text-h);background:var(--row-hover);font-weight:600}
.tw code{font-size:13px;color:var(--text-h)}
</style>`;

// Styles for the four tutorial blocks, emitted only on pages that use one —
// same gating as TABLE_STYLE, so the ~380 articles that are prose stay
// byte-for-byte free of it.
//
// Every directional property is logical: `border-inline-start` puts the accent
// rule on the reading-start edge, so an Arabic page gets it on the right with no
// direction-specific rule, and `padding-inline-start` does the same for the two
// lists. `<dd>` carries a UA `margin-inline-start:40px` that would indent every
// fix under its symptom, so it is zeroed rather than overridden per direction.
// Colours are the existing tokens, which already have a dark-scheme value, so
// the blocks follow the page into dark mode without a second media query.
const BLOCK_STYLE = `<style>
.cbox{margin:16px 0;padding:14px 18px;border:1px solid var(--border);border-inline-start:3px solid var(--accent);border-radius:var(--radius);background:var(--card)}
.cbox-t{margin:0 0 8px;color:var(--text-h);font-weight:600;font-size:15px}
.cbox p:last-child{margin-bottom:0}
.cbox ul{margin:0}
.cbox pre{margin:10px 0 0}
ol.steps{margin:18px 0;padding-inline-start:26px}
ol.steps>li{margin:12px 0}
ol.steps>li::marker{color:var(--text-h);font-weight:600}
ol.steps>li>p{margin:0}
ol.steps>li>pre{margin:8px 0 0}
.fix dl{margin:0}
.fix dt{margin:14px 0 4px;color:var(--text-h);font-weight:600}
.fix dl>dt:first-child{margin-top:0}
.fix dd{margin:0}
.fix dd>pre{margin:6px 0}
</style>`;

// Styles for widgetHtml, emitted only on pages that use a builder so every
// other article stays byte-for-byte free of it (mirrors BUILDER_SCRIPT gating).
const BUILDER_STYLE = `<style>
.builder{margin:16px 0;padding:18px;border:1px solid var(--border);border-radius:var(--radius);background:var(--card)}
.builder .bf{display:block;margin:0 0 12px}
.builder .bf span{display:block;font-size:var(--fs-sm);color:var(--text-h);font-weight:600;margin:0 0 5px}
.builder .bf input{inline-size:100%;min-block-size:44px;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text-h)}
.builder .bcmd{margin:14px 0 0}
.builder .bcmd pre{margin:0}
.builder .bcopy{margin:10px 0 0;min-block-size:44px;padding:8px 16px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text-h);font:inherit;font-size:var(--fs-sm);cursor:pointer}
.builder .bcopy:hover{border-color:var(--accent-border)}
</style>`;

// Progressive enhancement for widgetHtml. Kept dependency-free and tiny; only
// emitted on pages that actually contain a [data-download-builder]. An empty
// link falls back to its <…> token so the command still reads as a template;
// an empty destination becomes "." (down's own default — current directory).
const BUILDER_SCRIPT = `<script>
(function(){
  function q(s){return /^[\\w@%+=:,.\\/-]+$/.test(s)?s:"'"+s.replace(/'/g,"'\\\\''")+"'";}
  document.querySelectorAll('[data-download-builder]').forEach(function(b){
    var link=b.querySelector('[data-link]'),dest=b.querySelector('[data-dest]'),
        out=b.querySelector('[data-cmd]'),copy=b.querySelector('[data-copy]');
    function render(){
      var l=link.value.trim()||('<'+(link.getAttribute('data-token')||'link')+'>');
      var d=dest.value.trim();
      out.textContent="relayium down '"+l+"' "+(d?q(d):".");
    }
    link.addEventListener('input',render);
    dest.addEventListener('input',render);
    if(copy){
      copy.hidden=false;
      copy.addEventListener('click',function(){
        navigator.clipboard.writeText(out.textContent).then(function(){
          var o=copy.textContent;copy.textContent=copy.getAttribute('data-copied')||o;
          setTimeout(function(){copy.textContent=o;},1500);
        }).catch(function(){});
      });
    }
    render();
  });
})();
</script>`;

// hasWidget reports whether any section carries a builder widget, so the page
// only ships BUILDER_SCRIPT when it's needed (every other article stays JS-free).
function hasWidget(doc) {
  return (doc.sections || []).some((s) => s.widget);
}

function hasTable(doc) {
  return (doc.sections || []).some((s) => s.table);
}

// hasBlocks reports whether any section uses a tutorial block, so BLOCK_STYLE is
// emitted only where one of the four actually renders.
function hasBlocks(doc) {
  return (doc.sections || []).some((s) => s.prereqs || s.steps?.length || s.success || s.troubleshooting);
}

export function renderArticlePage({ slug, lang, doc, updated, published, related = [] }) {
  const archived = isFrozen(lang);
  // Same predicate that decides <html dir="rtl">, so a command block can never
  // disagree with the document it sits in: adding a locale to RTL_LANGS turns
  // the page and its command blocks at the same time.
  const rtl = RTL_LANGS.has(lang);
  const dateModified = doc.updated || updated;
  const canonical = absUrl(urlPath(slug, lang));
  const ogImage = SITE.origin + "/og-image.jpg";
  // The Organization node is spelled out (rather than a bare name/url) so the
  // logo travels with it: Google's article rich results want a publisher logo,
  // and index.html's #org node already carries one. datePublished comes from the
  // article's own `published` field — the day the file landed in git, not a
  // guess; falling back to dateModified would claim every article was written
  // the day it was last touched.
  const org = {
    "@type": "Organization",
    name: SITE.name,
    url: SITE.origin + "/",
    logo: { "@type": "ImageObject", url: SITE.origin + "/icon-512.png", width: 512, height: 512 },
  };
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: doc.title,
        description: doc.description,
        inLanguage: BCP47[lang],
        ...(published ? { datePublished: published } : {}),
        dateModified,
        image: ogImage,
        mainEntityOfPage: canonical,
        author: org,
        publisher: org,
      },
      // Every article sat two clicks below the homepage with nothing on the page
      // saying so: no breadcrumb, and the only link back to the hub was in the
      // footer. This gives Google the hierarchy explicitly (and earns the
      // breadcrumb line in a search result instead of a bare URL).
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE.name, item: absUrl(landingUrl(lang)) },
          { "@type": "ListItem", position: 2, name: GUIDES_LABELS[lang], item: absUrl(urlPath("guides", lang)) },
          // The last crumb carries no `item`: it is the current page, and
          // Google's own guidance is to leave the trailing URL off.
          { "@type": "ListItem", position: 3, name: doc.title },
        ],
      },
      ...(doc.faq
        ? [
            {
              "@type": "FAQPage",
              inLanguage: BCP47[lang],
              mainEntity: doc.faq.items.map((f) => ({
                "@type": "Question",
                name: f.q,
                acceptedAnswer: { "@type": "Answer", text: f.a },
              })),
            },
          ]
        : []),
    ],
  };

  const lead = (doc.lead || []).map((p) => `<p class="lead">${esc(p)}</p>`).join("\n      ");
  // Explicit arrow, not a bare `map(sectionHtml)`: map's second argument is the
  // index, which would silently arrive as the `rtl` flag and make section 0 LTR
  // and every later section RTL on the same page.
  // One section, one card — the app's grouped-rows shape rather than an
  // unbroken column of prose. `.sheet` is page-shell.mjs's; a block that draws
  // its own surface (a tutorial box, a <pre>, a table) flattens inside it, so
  // nothing becomes a card inside a card.
  const sections = doc.sections
    .map((s) => `<section class="sheet">${sectionHtml(s, rtl)}</section>`)
    .join("\n      ");
  const faq = doc.faq
    ? `<h2>${esc(doc.faq.heading)}</h2>\n      ` +
      doc.faq.items.map((it) => `<h3>${esc(it.q)}</h3>\n      <p>${esc(it.a)}</p>`).join("\n      ")
    : "";
  const relatedLinks = [
    ...related.map((r) => `<li><a href="${urlPath(r.slug, lang)}">${esc(r.title)}</a></li>`),
    `<li><a href="${landingUrl(lang)}">${esc(SITE.name)}</a></li>`,
  ].join("");
  const relatedBlock = `<h2>${esc(doc.relatedHeading)}</h2>\n      <ul class="related">${relatedLinks}</ul>`;

  // Bidi-isolated for RTL locales: the head is read by browser chrome and search
  // engines, which resolve direction from the first strong character rather than
  // from the page's dir="rtl". See rtlHead() in shared.mjs.
  const headTitle = esc(rtlHead(lang, doc.title));
  const headDesc = esc(rtlHead(lang, doc.description));

  return `<!doctype html>
<html lang="${BCP47[lang]}"${dirAttr(lang)}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${headTitle} · ${SITE.name}</title>
    <meta name="description" content="${headDesc}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />${archived ? "" : "\n    " + alternates(slug)}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    ${THEME_HEAD}
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="${SITE.name}" />
    <meta property="og:title" content="${headTitle}" />
    <meta property="og:description" content="${headDesc}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ogImage}" />
    ${OG_IMAGE_META}
    <meta property="og:locale" content="${OG_LOCALE[lang]}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${headTitle}" />
    <meta name="twitter:description" content="${headDesc}" />
    <meta name="twitter:image" content="${ogImage}" />
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
    <style>${STYLE}${archived ? ARCHIVE_STYLE : ""}</style>${hasTable(doc) ? "\n    " + TABLE_STYLE : ""}${hasBlocks(doc) ? "\n    " + BLOCK_STYLE : ""}${hasWidget(doc) ? "\n    " + BUILDER_STYLE : ""}
  </head>
  <body>
    ${appShell({ lang, home: ctaHref(lang), foot: archived ? "" : langBar(slug, lang), content: `
      <nav class="crumbs" aria-label="Breadcrumb"><a href="${landingUrl(lang)}">${esc(SITE.name)}</a> <span aria-hidden="true">›</span> <a href="${urlPath("guides", lang)}">${esc(GUIDES_LABELS[lang])}</a> <span aria-hidden="true">›</span> <span aria-current="page">${esc(doc.title)}</span></nav>
      <!-- The breadcrumb sits outside the main landmark; the language bar sits
           inside it, after the h1, because that is where it renders visually.
           Both are labelled <nav> landmarks in their own right, so either side of
           the boundary satisfies the "content lives in a landmark" rule.
           On an archived page that slot holds the archived-translation notice
           instead — a labelled <aside>, so it is a complementary landmark rather
           than a navigation one, and the same rule is satisfied either way. -->
      <main>
      <h1>${esc(doc.title)}</h1>
      <!-- Isolated: an ISO date is three digit runs joined by hyphens, and the
           bidi algorithm lays those runs out right-to-left inside the Arabic
           page, so "2026-07-31" rendered as "31-07-2026" — the same day in a
           different convention, arrived at by accident rather than by choice,
           and disagreeing with the dateModified in this page's own JSON-LD.
           See rtl-head-isolation.test.mjs, which pins every date on every
           generated Arabic page. -->
      <p class="updated">${esc(doc.updatedLabel)}: <bdi>${esc(dateModified)}</bdi></p>
      ${archived ? langBar(slug, lang) : ""}
      ${lead}
      ${sections}
      ${faq}
      <div class="ctacard">
        <p>${esc(doc.cta.text)}</p>
        <a class="cta" href="${doc.cta.href || ctaHref(lang)}">${esc(doc.cta.button)}</a>
      </div>
      ${relatedBlock}
      </main>
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("apps", lang)}">${esc(APPS_LABELS[lang])}</a>
        <a href="${urlPath("guides", lang)}">${esc(GUIDES_LABELS[lang])}</a>
        <a href="${urlPath("privacy", lang)}">${esc(PRIVACY_LABELS[lang])}</a>
        <a href="${PRICING_URL}">${esc(pricingLabel(lang))}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
` })}${hasWidget(doc) ? "\n    " + BUILDER_SCRIPT : ""}
  </body>
</html>
`;
}
