// web/scripts/pages/article-template.mjs — renders one article (one language) to a
// self-contained static HTML string. No JS, no external CSS: styles are inlined so
// the page is independent of the Vite asset graph and crawlable with JS disabled.
import { LANGS, DEFAULT_LANG, LANG_LABELS, BCP47, OG_LOCALE, SITE, urlPath, absUrl, esc, ctaHref, landingUrl } from "./shared.mjs";

// Footer link label; matches content/landing.mjs footer.privacy per language.
const PRIVACY_LABELS = {
  en: "Privacy", zh: "隐私政策", ja: "プライバシーポリシー",
  ko: "개인정보 처리방침", de: "Datenschutz", fr: "Confidentialité",
};

const STYLE = `
:root{--text:#6b6375;--text-h:#08060d;--bg:#fff;--border:#e5e4e7;--card:rgba(244,243,236,.5);--accent:#aa3bff;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--text:#9ca3af;--text-h:#f3f4f6;--bg:#16171d;--border:#2e303a;--card:rgba(47,48,58,.5);--accent:#c084fc}}
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
p{margin:12px 0}ul{margin:12px 0;padding-left:22px}li{margin:6px 0}
pre{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:16px 0}
pre code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;color:var(--text-h);white-space:pre;line-height:1.6}
.langbar{display:flex;flex-wrap:wrap;gap:6px 14px;margin:24px 0 8px;font-size:14px}
.langbar a{color:var(--accent);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
.ctacard{margin:40px 0 8px;padding:24px;border:1px solid var(--border);border-radius:14px;background:var(--card)}
.ctacard p{margin:0 0 14px}
.cta{display:inline-block;padding:14px 28px;border-radius:10px;color:#fff;font-weight:600;font-size:17px;text-decoration:none;background:linear-gradient(135deg,var(--accent),#6d28d9)}
.related{list-style:none;padding:0}.related a{color:var(--accent);text-decoration:none}
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

function sectionHtml(s) {
  let out = `<h2>${esc(s.heading)}</h2>`;
  for (const p of s.body || []) out += `\n      <p>${esc(p)}</p>`;
  for (const block of s.code || []) out += `\n      <pre><code>${esc(block)}</code></pre>`;
  if (s.bullets?.length) out += `\n      <ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
  return out;
}

export function renderArticlePage({ slug, lang, doc, updated, related = [] }) {
  const dateModified = doc.updated || updated;
  const canonical = absUrl(urlPath(slug, lang));
  const ogImage = SITE.origin + "/og-image.jpg";
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: doc.title,
        description: doc.description,
        inLanguage: BCP47[lang],
        dateModified,
        mainEntityOfPage: canonical,
        author: { "@type": "Organization", name: SITE.name, url: SITE.origin + "/" },
        publisher: { "@type": "Organization", name: SITE.name, url: SITE.origin + "/" },
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

  return `<!doctype html>
<html lang="${BCP47[lang]}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(doc.title)} · ${SITE.name}</title>
    <meta name="description" content="${esc(doc.description)}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />
    ${alternates(slug)}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16171d" media="(prefers-color-scheme: dark)" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="${esc(doc.title)}" />
    <meta property="og:description" content="${esc(doc.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:locale" content="${OG_LOCALE[lang]}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(doc.title)}" />
    <meta name="twitter:description" content="${esc(doc.description)}" />
    <meta name="twitter:image" content="${ogImage}" />
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="wrap">
      <header><span class="logo">⇌</span><a href="${ctaHref(lang)}">Relayium</a></header>
      <h1>${esc(doc.title)}</h1>
      <p class="updated">${esc(doc.updatedLabel)}: ${esc(dateModified)}</p>
      ${langBar(slug, lang)}
      ${lead}
      ${sections}
      ${faq}
      <div class="ctacard">
        <p>${esc(doc.cta.text)}</p>
        <a class="cta" href="${doc.cta.href || ctaHref(lang)}">${esc(doc.cta.button)}</a>
      </div>
      ${relatedBlock}
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("privacy", lang)}">${esc(PRIVACY_LABELS[lang])}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
