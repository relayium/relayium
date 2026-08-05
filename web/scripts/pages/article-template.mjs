// web/scripts/pages/article-template.mjs — renders one article (one language) to a
// self-contained static HTML string. No JS, no external CSS: styles are inlined so
// the page is independent of the Vite asset graph and crawlable with JS disabled.
import { LANGS, DEFAULT_LANG, LANG_LABELS, GUIDES_LABELS, APPS_LABELS, pricingLabel, PRICING_URL, BCP47, OG_LOCALE, OG_IMAGE_META, SITE, urlPath, absUrl, esc, ctaHref, landingUrl, dirAttr, rtlHead } from "./shared.mjs";

// Footer link label; matches content/landing.mjs footer.privacy per language.
const PRIVACY_LABELS = {
  en: "Privacy", zh: "隐私政策", ja: "プライバシーポリシー",
  ko: "개인정보 처리방침", de: "Datenschutz", fr: "Confidentialité",
  ar: "الخصوصية", es: "Privacidad", pt: "Privacidade",
};

const STYLE = `
:root{--text:#6b6375;--text-h:#08060d;--bg:#fff;--border:#e5e4e7;--card:rgba(244,243,236,.5);--accent:#aa3bff;--accent-fg:#7e22ce;--accent-action:#6d28d9;--accent-action-deep:#4338ca;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--text:#9ca3af;--text-h:#f3f4f6;--bg:#16171d;--border:#2e303a;--card:rgba(47,48,58,.5);--accent:#c084fc;--accent-fg:#c084fc;--accent-action:#7c3aed;--accent-action-deep:#4f46e5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 system-ui,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:0 20px 64px}
header{display:flex;align-items:center;gap:10px;padding:22px 0;border-bottom:1px solid var(--border)}
header .logo{width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;color:#fff;background:linear-gradient(135deg,var(--accent),#6d28d9)}
header a{color:var(--text-h);text-decoration:none;font-weight:600}
h1{color:var(--text-h);font-size:34px;letter-spacing:-.5px;margin:36px 0 6px}
h2{color:var(--text-h);font-size:23px;margin:38px 0 10px}
h3{color:var(--text-h);font-size:18px;margin:22px 0 4px}
.updated{color:var(--text);font-size:14px;margin:0 0 8px}
.lead{font-size:19px}
p{margin:12px 0}ul{margin:12px 0;padding-inline-start:22px}li{margin:6px 0}
pre{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:16px 0}
pre code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:var(--text-h);white-space:pre;line-height:1.6}
.langbar{display:flex;flex-wrap:wrap;gap:6px 12px;margin:16px 0 8px;font-size:13.5px}
.langbar a{color:var(--accent-fg);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
.ctacard{margin:40px 0 8px;padding:24px;border:1px solid var(--border);border-radius:14px;background:var(--card)}
.ctacard p{margin:0 0 14px}
.cta{display:inline-block;padding:14px 28px;border-radius:10px;color:#fff;font-weight:600;font-size:17px;text-decoration:none;background:linear-gradient(135deg,var(--accent-action),var(--accent-action-deep))}
.related{list-style:none;padding:0}.related a{color:var(--accent-fg);text-decoration:none}
.crumbs{margin:18px 0 0;font-size:13.5px;color:var(--text)}
.crumbs a{color:var(--accent-fg);text-decoration:underline;text-underline-offset:2px}
.crumbs [aria-current]{color:var(--text)}
footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--border);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
footer a{color:var(--text-h);text-decoration:none}
`;

function langBar(slug, lang) {
  const links = LANGS.map((l) => {
    const cur = l === lang ? " aria-current=\"true\"" : "";
    return `<a href="${urlPath(slug, l)}"${cur}>${esc(LANG_LABELS[l])}</a>`;
  });
  return `<nav class="langbar" aria-label="Language">${links.join("")}</nav>`;
}

function alternates(slug) {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath(slug, l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath(slug, DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

// widgetHtml renders an interactive command builder that degrades gracefully:
// with JS off it's a plain <pre> showing the command template (real,
// crawlable content) plus two labelled inputs; the inline BUILDER_SCRIPT
// (injected only when a page uses a widget) upgrades it to live-build the
// `relayium down '<link>' <dir>` command and reveal a Copy button. Only the
// "downloadBuilder" kind exists today.
function widgetHtml(w) {
  const fallback = `relayium down '<${w.linkToken}>' <${w.destToken}>`;
  return (
    `\n      <div class="builder" data-download-builder>` +
    `<label class="bf"><span>${esc(w.linkLabel)}</span>` +
    `<input data-link type="text" placeholder="${esc(w.linkPlaceholder)}" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" data-token="${esc(w.linkToken)}" /></label>` +
    `<label class="bf"><span>${esc(w.destLabel)}</span>` +
    `<input data-dest type="text" placeholder="${esc(w.destPlaceholder)}" spellcheck="false" autocapitalize="off" autocorrect="off" autocomplete="off" /></label>` +
    `<div class="bcmd"><pre><code data-cmd>${esc(fallback)}</code></pre>` +
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

const codeHtml = (blocks) =>
  (blocks || []).map((b) => `<pre><code>${esc(b)}</code></pre>`).join("");

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
function stepsHtml(steps) {
  const items = steps
    .map((s) => `<li><p>${esc(s.text)}</p>${codeHtml(s.code)}</li>`)
    .join("");
  return `\n      <ol class="steps" data-block="steps">${items}</ol>`;
}

// successHtml — what the reader compares their terminal against. Labelled, so
// it reads as "this is the expected result" rather than as one more code sample.
function successHtml(s) {
  return (
    `\n      <div class="cbox ok" data-block="success">` +
    `<p class="cbox-t">${esc(s.label)}</p>` +
    (s.body || []).map((p) => `<p>${esc(p)}</p>`).join("") +
    codeHtml(s.code) +
    `</div>`
  );
}

// troubleshootHtml — a description list, because that is exactly the shape of
// the content: the <dt> is the symptom the reader can see, the <dd> is the check
// that decides it and the fix that follows. Each item's `code` is the check —
// something to run, or an exact state to look at.
function troubleshootHtml(t) {
  const items = t.items
    .map((i) => `<dt>${esc(i.symptom)}</dt><dd>${codeHtml(i.code)}<p>${esc(i.fix)}</p></dd>`)
    .join("");
  return (
    `\n      <div class="cbox fix" data-block="troubleshooting">` +
    `<p class="cbox-t">${esc(t.label)}</p>` +
    `<dl>${items}</dl>` +
    `</div>`
  );
}

function sectionHtml(s) {
  let out = `<h2>${esc(s.heading)}</h2>`;
  if (s.prereqs) out += prereqsHtml(s.prereqs);
  for (const p of s.body || []) out += `\n      <p>${esc(p)}</p>`;
  if (s.table) out += tableHtml(s.table);
  for (const block of s.code || []) out += `\n      <pre><code>${esc(block)}</code></pre>`;
  if (s.widget) out += widgetHtml(s.widget);
  if (s.steps?.length) out += stepsHtml(s.steps);
  if (s.success) out += successHtml(s.success);
  if (s.bullets?.length) out += `\n      <ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
  if (s.troubleshooting) out += troubleshootHtml(s.troubleshooting);
  return out;
}

// Styles for tableHtml, emitted only on pages that actually contain a table —
// same gating as BUILDER_STYLE, so the other 390-odd articles stay byte-for-byte
// free of it. `text-align:start` is deliberate (not `left`): it is a logical
// property, so an RTL page picks up right alignment from <html dir="rtl"> with
// no direction-specific rule anywhere.
const TABLE_STYLE = `<style>
.tw{overflow-x:auto;margin:16px 0}
.tw table{border-collapse:collapse;width:100%;font-size:15px}
.tw th,.tw td{border:1px solid var(--border);padding:8px 11px;text-align:start;vertical-align:top}
.tw th{color:var(--text-h);background:var(--card);font-weight:600}
.tw code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;color:var(--text-h)}
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
.cbox{margin:16px 0;padding:14px 18px;border:1px solid var(--border);border-inline-start:3px solid var(--accent);border-radius:12px;background:var(--card)}
.cbox-t{margin:0 0 8px;color:var(--text-h);font-weight:600;font-size:15.5px}
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
.builder{margin:16px 0;padding:18px;border:1px solid var(--border);border-radius:12px;background:var(--card)}
.builder .bf{display:block;margin:0 0 12px}
.builder .bf span{display:block;font-size:14px;color:var(--text);margin:0 0 5px}
.builder .bf input{width:100%;font:15px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text-h)}
.builder .bcmd{margin:14px 0 0}
.builder .bcmd pre{margin:0}
.builder .bcopy{margin:10px 0 0;padding:8px 16px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text-h);font:inherit;font-size:14px;cursor:pointer}
.builder .bcopy:hover{border-color:var(--accent)}
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
  const sections = doc.sections.map(sectionHtml).join("\n      ");
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
    <link rel="canonical" href="${canonical}" />
    ${alternates(slug)}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16171d" media="(prefers-color-scheme: dark)" />
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
    <style>${STYLE}</style>${hasTable(doc) ? "\n    " + TABLE_STYLE : ""}${hasBlocks(doc) ? "\n    " + BLOCK_STYLE : ""}${hasWidget(doc) ? "\n    " + BUILDER_STYLE : ""}
  </head>
  <body>
    <div class="wrap">
      <header><span class="logo" aria-hidden="true">⇌</span><a href="${ctaHref(lang)}">Relayium</a></header>
      <nav class="crumbs" aria-label="Breadcrumb"><a href="${landingUrl(lang)}">${esc(SITE.name)}</a> <span aria-hidden="true">›</span> <a href="${urlPath("guides", lang)}">${esc(GUIDES_LABELS[lang])}</a> <span aria-hidden="true">›</span> <span aria-current="page">${esc(doc.title)}</span></nav>
      <!-- The breadcrumb sits outside the main landmark; the language bar sits
           inside it, after the h1, because that is where it renders visually.
           Both are labelled <nav> landmarks in their own right, so either side of
           the boundary satisfies the "content lives in a landmark" rule. -->
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
      ${langBar(slug, lang)}
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
    </div>${hasWidget(doc) ? "\n    " + BUILDER_SCRIPT : ""}
  </body>
</html>
`;
}
