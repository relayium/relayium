// web/scripts/pages/guides-index-template.mjs — renders the Guides hub (one language)
// to a self-contained static HTML string. Same inlined-style, no-JS approach as
// article-template.mjs so it is crawlable and independent of the Vite asset graph.
import { LANGS, DEFAULT_LANG, LANG_LABELS, APPS_LABELS, PRICING_LABELS, PRICING_URL, BCP47, OG_LOCALE, OG_IMAGE_META, SITE, urlPath, absUrl, esc, ctaHref, dirAttr, rtlHead } from "./shared.mjs";

// Copy this verbatim from article-template.mjs:7-10 (same six labels).
const PRIVACY_LABELS = {
  en: "Privacy", zh: "隐私政策", ja: "プライバシーポリシー",
  ko: "개인정보 처리방침", de: "Datenschutz", fr: "Confidentialité",
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
.lead{font-size:19px}
p{margin:12px 0}ul{margin:12px 0;padding-inline-start:0}
.langbar{display:flex;flex-wrap:wrap;gap:6px 12px;margin:16px 0 8px;font-size:13.5px}
.langbar a{color:var(--accent-fg);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
.guidelist{list-style:none;padding:0}.guidelist li{margin:8px 0}.guidelist a{color:var(--accent-fg);text-decoration:none;font-size:18px}
footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--border);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
footer a{color:var(--text-h);text-decoration:none}
`;

function langBar(lang) {
  const links = LANGS.map((l) => {
    const cur = l === lang ? " aria-current=\"true\"" : "";
    return `<a href="${urlPath("guides", l)}"${cur}>${esc(LANG_LABELS[l])}</a>`;
  });
  return `<nav class="langbar" aria-label="Language">${links.join("")}</nav>`;
}

function alternates() {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath("guides", l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath("guides", DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

function groupSection(label, items, lang) {
  if (!items.length) return "";
  const lis = items
    .map((a) => `<li><a href="${urlPath(a.slug, lang)}">${esc(a.title)}</a></li>`)
    .join("");
  return `<h2>${esc(label)}</h2>\n      <ul class="guidelist">${lis}</ul>`;
}

export function renderGuidesIndexPage({ lang, doc, groups }) {
  const canonical = absUrl(urlPath("guides", lang));
  const ogImage = SITE.origin + "/og-image.jpg";
  const ordered = [
    [doc.categories.guides, groups.guides],
    [doc.categories.howTo, groups.howTo],
    [doc.categories.compare, groups.compare],
  ];
  const flat = ordered.flatMap(([, items]) => items);
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: doc.heading,
        description: doc.description,
        inLanguage: BCP47[lang],
        url: canonical,
        mainEntity: {
          "@type": "ItemList",
          itemListElement: flat.map((a, i) => ({
            "@type": "ListItem",
            position: i + 1,
            url: absUrl(urlPath(a.slug, lang)),
            name: a.title,
          })),
        },
      },
    ],
  };
  const sections = ordered.map(([label, items]) => groupSection(label, items, lang)).filter(Boolean).join("\n      ");

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
    <title>${headTitle}</title>
    <meta name="description" content="${headDesc}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />
    ${alternates()}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16171d" media="(prefers-color-scheme: dark)" />
    <meta property="og:type" content="website" />
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
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="wrap">
      <header><span class="logo" aria-hidden="true">⇌</span><a href="${ctaHref(lang)}">Relayium</a></header>
      <!-- Everything between the site header and the footer is this page's own
           content, so it belongs to one main landmark. -->
      <main>
      <h1>${esc(doc.heading)}</h1>
      <p class="lead">${esc(doc.intro)}</p>
      ${langBar(lang)}
      ${sections}
      </main>
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("apps", lang)}">${esc(APPS_LABELS[lang])}</a>
        <a href="${urlPath("privacy", lang)}">${esc(PRIVACY_LABELS[lang])}</a>
        <a href="${PRICING_URL}">${esc(PRICING_LABELS[lang])}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
