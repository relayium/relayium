// web/scripts/pages/legal-template.mjs — renders one prose document (one language) to a
// self-contained static HTML string. No JS, no external CSS: styles are inlined so
// the page is independent of the Vite asset graph and crawlable with JS disabled.
//
// Four legal pages use it (privacy, terms, security, support) and so does
// /releases/, which is the same shape — title, lead, prose sections, a langbar
// and the shared footer — plus one list this template knows how to render. A
// second near-identical template would have meant maintaining this file's head,
// bidi handling and inlined stylesheet twice.
import { LANGS, DEFAULT_LANG, LANG_LABELS, APPS_LABELS, PRICING_LABELS, PRICING_URL, RELEASES_LABELS, BCP47, SITE, urlPath, absUrl, esc, dirAttr, rtlHead } from "./shared.mjs";

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
.releases{list-style:none;margin:16px 0 0;padding:0}
.releases li{display:flex;gap:16px;align-items:baseline;padding:9px 0;border-bottom:1px solid var(--border)}
.releases li:last-child{border-bottom:0}
.releases a{color:var(--accent-fg);text-decoration:none;font-weight:600;min-width:72px}
.releases .date{font-size:14px;font-variant-numeric:tabular-nums}
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

/** Where a version's full notes and downloads live. */
const RELEASE_TAG_URL = "https://github.com/relayium/relayium/releases/tag/";

/**
 * The version list, or "" when a document has none (every legal page).
 *
 * Both fields are wrapped in <bdi>: a version and an ISO date are Latin/digit
 * runs, and on the Arabic page they sit inside an RTL paragraph direction that
 * would otherwise reorder "v0.15.0" against its date. Isolation keeps each run
 * reading left-to-right without forcing the list itself back to LTR.
 */
function releasesHtml(doc, releases) {
  if (!releases.length) return "";
  const items = releases
    .map(
      (r) =>
        `<li><a href="${RELEASE_TAG_URL}${esc(r.version)}"><bdi>${esc(r.version)}</bdi></a>` +
        `<span class="date"><bdi>${esc(r.date)}</bdi></span></li>`
    )
    .join("");
  return `<h2>${esc(doc.releasesHeading)}</h2><p>${esc(doc.releasesNote)}</p>` +
    `<ul class="releases">${items}</ul>`;
}

export function renderLegalPage({ slug, lang, doc, releases = [] }) {
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
  // Bidi-isolated for RTL locales: the head is read by browser chrome and search
  // engines, which resolve direction from the first strong character rather than
  // from the page's dir="rtl". See rtlHead() in shared.mjs.
  const headTitle = esc(rtlHead(lang, doc.title));
  const headDesc = esc(rtlHead(lang, doc.description));
  // Above the prose sections, not below them: someone who opens /releases/ came
  // for the versions, and the three sections explaining what a version number
  // covers are context for the list rather than a preamble to it.
  //
  // Indented here rather than in the template body: interpolating an empty
  // string on its own line leaves the indentation behind as trailing
  // whitespace, on all 36 legal pages at once.
  const releaseList = releases.length ? "\n      " + releasesHtml(doc, releases) : "";

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
      <!-- The date is isolated for the same reason the release rows are: an ISO
           date is three digit runs joined by hyphens, and on the Arabic page the
           bidi algorithm lays those runs out right-to-left. "2026-08-03" was
           rendering as "03-08-2026" on all four Arabic legal pages — measured in
           a browser, not deduced. <bdi> resolves LTR (no strong character
           inside) and pins the order. -->
      <p class="updated">${esc(doc.updatedLabel)}: <bdi>${esc(doc.updated)}</bdi></p>
      ${langBar(slug, lang)}
      ${(doc.lead || []).map((p) => `<p>${esc(p)}</p>`).join("\n      ")}${releaseList}
      ${doc.sections.map(sectionHtml).join("\n      ")}
      </main>
      <footer>
        <a href="/">← ${esc(SITE.name)}</a>
        <a href="${urlPath("apps", lang)}">${esc(APPS_LABELS[lang])}</a>
        <a href="${urlPath(otherSlug, lang)}">${esc(doc.otherDocLabel)}</a>
        <a href="${PRICING_URL}">${esc(PRICING_LABELS[lang])}</a>${slug === "releases" ? "" : `
        <a href="${urlPath("releases", lang)}">${esc(RELEASES_LABELS[lang])}</a>`}
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
