// web/scripts/pages/legal-template.mjs — renders one legal document (one language) to a
// self-contained static HTML string. No JS, no external CSS: styles are inlined so
// the page is independent of the Vite asset graph and crawlable with JS disabled.
import { LANGS, DEFAULT_LANG, LANG_LABELS, APPS_LABELS, PRICING_LABELS, PRICING_URL, BCP47, SITE, urlPath, absUrl, esc, dirAttr } from "./shared.mjs";

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
h2{color:var(--text-h);font-size:21px;margin:34px 0 10px}
.updated{color:var(--text);font-size:14px;margin:0 0 8px}
p{margin:12px 0}ul{margin:12px 0;padding-inline-start:22px}li{margin:6px 0}
.langbar{display:flex;flex-wrap:wrap;gap:6px 12px;margin:16px 0 8px;font-size:13.5px}
.langbar a{color:var(--accent-fg);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
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
  for (const p of s.body || []) out += `<p>${esc(p)}</p>`;
  if (s.bullets?.length) out += `<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`;
  return out;
}

export function renderLegalPage({ slug, lang, doc }) {
  const otherSlug = slug === "privacy" ? "terms" : "privacy";
  const canonical = absUrl(urlPath(slug, lang));
  const ld = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: `${doc.title} · ${SITE.name}`,
    description: doc.description,
    url: canonical,
    inLanguage: BCP47[lang],
    dateModified: doc.updated,
    isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.origin + "/" },
  };
  return `<!doctype html>
<html lang="${BCP47[lang]}"${dirAttr(lang)}>
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
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="wrap">
      <header><span class="logo" aria-hidden="true">⇌</span><a href="/">Relayium</a></header>
      <!-- The legal text is the main landmark. The site header and footer are
           outside it; the language bar is inside, after the h1, matching its
           visual position — it is a labelled <nav> landmark either way. -->
      <main>
      <h1>${esc(doc.title)}</h1>
      <p class="updated">${esc(doc.updatedLabel)}: ${esc(doc.updated)}</p>
      ${langBar(slug, lang)}
      ${(doc.lead || []).map((p) => `<p>${esc(p)}</p>`).join("\n      ")}
      ${doc.sections.map(sectionHtml).join("\n      ")}
      </main>
      <footer>
        <a href="/">← ${esc(SITE.name)}</a>
        <a href="${urlPath("apps", lang)}">${esc(APPS_LABELS[lang])}</a>
        <a href="${urlPath(otherSlug, lang)}">${esc(doc.otherDocLabel)}</a>
        <a href="${PRICING_URL}">${esc(PRICING_LABELS[lang])}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
