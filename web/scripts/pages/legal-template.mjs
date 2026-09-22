// web/scripts/pages/legal-template.mjs — renders one prose document (one language) to a
// self-contained static HTML string. No JS, no external CSS: styles are inlined so
// the page is independent of the Vite asset graph and crawlable with JS disabled.
//
// Four legal pages use it (privacy, terms, security, support) and so does
// /releases/, which is the same shape — title, lead, prose sections, a langbar
// and the shared footer — plus one list this template knows how to render. A
// second near-identical template would have meant maintaining this file's head,
// bidi handling and inlined stylesheet twice.
import { MAINTAINED_LANGS, DEFAULT_LANG, LANG_LABELS, APPS_LABELS, pricingLabel, PRICING_URL, RELEASES_LABELS, BCP47, OG_LOCALE, OG_IMAGE, OG_IMAGE_META, SITE, urlPath, absUrl, esc, dirAttr, rtlHead, isFrozen, archiveNotice, ARCHIVE_STYLE } from "./shared.mjs";
import { pageStyle, THEME_HEAD } from "./page-chrome.mjs";
import { appShell } from "./page-shell.mjs";

// What the legal/releases template owns; the rest is page-chrome.mjs.
const STYLE = pageStyle(`
/* The release list is the app's settings-row shape: 1px separators inside one
   card, no line under the last row (设计规范 §4). */
.releases{list-style:none;margin:18px 0 0;padding:0;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);overflow:clip}
.releases li{display:flex;gap:16px;align-items:baseline;margin:0;padding:11px 16px;border-block-end:1px solid var(--sep)}
.releases li:last-child{border-block-end:0}
.releases a{color:var(--text-h);text-decoration:underline;text-decoration-color:var(--accent-border);text-underline-offset:3px;font-weight:600;min-inline-size:72px}
.releases a:hover{color:var(--accent-fg);text-decoration-color:currentColor}
.releases .date{font-size:var(--fs-sm);font-variant-numeric:tabular-nums}
`);

// Maintained pages get the two-language selector; archived ones get the notice
// in the same slot. See article-template.mjs for why they are the same slot.
function langBar(slug, lang) {
  if (isFrozen(lang)) return archiveNotice(lang, { en: urlPath(slug, "en"), zh: urlPath(slug, "zh") });
  const links = MAINTAINED_LANGS.map((l) => {
    const cur = l === lang ? " aria-current=\"true\"" : "";
    return `<a href="${urlPath(slug, l)}"${cur}>${esc(LANG_LABELS[l])}</a>`;
  });
  return `<nav class="langbar" aria-label="Language">${links.join("")}</nav>`;
}

// The maintained cluster only — en, zh, x-default at en. Archived pages emit
// none; see article-template.mjs's alternates() for the reciprocity reasoning.
function alternates(slug) {
  const links = MAINTAINED_LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath(slug, l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath(slug, DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

// One section, one card — the app's grouped-rows shape rather than a wall of
// prose. See page-shell.mjs's `.sheet`.
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
  const archived = isFrozen(lang);
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
  //
  // The share card below reuses these two strings as they are, the way the four
  // sibling templates do: a legal page has no separate social copy, and adding
  // some would be new text to translate for a link preview. og:title follows
  // article-template.mjs — the bare title, since og:site_name carries the brand.
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
    <link rel="canonical" href="${canonical}" />${archived ? "" : "\n    " + alternates(slug)}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    ${THEME_HEAD}
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE.name}" />
    <meta property="og:title" content="${headTitle}" />
    <meta property="og:description" content="${headDesc}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${OG_IMAGE}" />
    ${OG_IMAGE_META}
    <meta property="og:locale" content="${OG_LOCALE[lang]}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${headTitle}" />
    <meta name="twitter:description" content="${headDesc}" />
    <meta name="twitter:image" content="${OG_IMAGE}" />
    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
    <style>${STYLE}${archived ? ARCHIVE_STYLE : ""}</style>
  </head>
  <body>
    ${appShell({ lang, home: "/", foot: archived ? "" : langBar(slug, lang), content: `
      <!-- The legal text is the main landmark; the rail and the footer are
           outside it. The language bar now lives in the rail's foot slot, with
           the rest of the navigation. An ARCHIVED page keeps its notice here
           instead: it is a paragraph of explanation, not a selector, and it has
           no business in a 216px rail. It is a labelled <aside>, so it is still
           a landmark of its own. -->
      <main>
      <h1>${esc(doc.title)}</h1>
      <!-- The date is isolated for the same reason the release rows are: an ISO
           date is three digit runs joined by hyphens, and on the Arabic page the
           bidi algorithm lays those runs out right-to-left. "2026-08-03" was
           rendering as "03-08-2026" on all four Arabic legal pages — measured in
           a browser, not deduced. <bdi> resolves LTR (no strong character
           inside) and pins the order. -->
      <p class="updated">${esc(doc.updatedLabel)}: <bdi>${esc(doc.updated)}</bdi></p>
      ${archived ? langBar(slug, lang) : ""}
      ${(doc.lead || []).map((p) => `<p>${esc(p)}</p>`).join("\n      ")}${releaseList}
      ${doc.sections.map((sec) => `<section class="sheet">${sectionHtml(sec)}</section>`).join("\n      ")}
      </main>
      <footer>
        <a href="/">← ${esc(SITE.name)}</a>
        <a href="${urlPath("apps", lang)}">${esc(APPS_LABELS[lang])}</a>
        <a href="${urlPath(otherSlug, lang)}">${esc(doc.otherDocLabel)}</a>
        <a href="${PRICING_URL}">${esc(pricingLabel(lang))}</a>${slug === "releases" ? "" : `
        <a href="${urlPath("releases", lang)}">${esc(RELEASES_LABELS[lang])}</a>`}
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
` })}
  </body>
</html>
`;
}
