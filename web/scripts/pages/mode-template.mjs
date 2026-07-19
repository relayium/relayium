// web/scripts/pages/mode-template.mjs — renders one localized static SEO landing
// page for a product mode (e.g. /cross-network, /offline-transfer). English stays
// the SPA route, so pages exist only for LANDING_LANGS; the hreflang cluster still
// points en/x-default at the English SPA route (urlPath(slug,"en") is unprefixed).
//
// Head follows article-template.mjs's conventions (canonical, alternates, OG,
// JSON-LD). Body + styling reuse landing-template.mjs's inline STYLE and
// page-shell classes (.wrap/.pitch/.cta/ol.steps/.why/.compare/.learn/footer) so
// mode pages look like the localized home landing pages, not a bare skeleton.
import {
  LANGS,
  DEFAULT_LANG,
  BCP47,
  OG_LOCALE,
  SITE,
  urlPath,
  absUrl,
  esc,
  ctaHref,
  dirAttr,
} from "./shared.mjs";
import { STYLE } from "./landing-template.mjs";

function alternates(slug) {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath(slug, l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath(slug, DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

function jsonLd(slug, lang, doc, updated) {
  const graph = [
    {
      "@type": "WebPage",
      name: doc.title,
      description: doc.description,
      url: absUrl(urlPath(slug, lang)),
      inLanguage: BCP47[lang],
      ...(updated ? { dateModified: updated } : {}),
      publisher: { "@type": "Organization", name: SITE.name, url: SITE.origin + "/" },
    },
  ];
  if (doc.faq?.items?.length) {
    graph.push({
      "@type": "FAQPage",
      inLanguage: BCP47[lang],
      mainEntity: doc.faq.items.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c");
}

function body(slug, lang, doc, articleLinks) {
  const steps = doc.how.steps.map((s) => `<li>${esc(s)}</li>`).join("\n        ");
  const why = doc.why.items
    .map((it) => `<li><b>${esc(it.title)}</b> — ${esc(it.desc)}</li>`)
    .join("\n        ");
  const compare = doc.compare.items
    .map((it) => `<h3>${esc(it.title)}</h3>\n      <p>${esc(it.body)}</p>`)
    .join("\n      ");
  const faq = doc.faq
    ? doc.faq.items.map((it) => `<h3>${esc(it.q)}</h3>\n      <p>${esc(it.a)}</p>`).join("\n      ")
    : "";
  const learn = articleLinks?.length
    ? `<h2>${esc(doc.learnHeading)}</h2>\n      <ul class="learn">${articleLinks
        .map((a) => `<li><a href="${urlPath(a.slug, lang)}">${esc(a.title)}</a></li>`)
        .join("")}</ul>`
    : "";

  return `
      <h1>${esc(doc.hero.h1)}</h1>
      <p class="pitch">${esc(doc.hero.pitch)}</p>
      <a class="cta" href="/${slug}?lang=${lang}">${esc(doc.hero.cta)}</a>

      <section class="reveal">
      <h2>${esc(doc.how.heading)}</h2>
      <ol class="steps">
        ${steps}
      </ol>
      </section>

      <section class="reveal">
      <h2>${esc(doc.why.heading)}</h2>
      <ul class="why">
        ${why}
      </ul>
      </section>

      <section class="reveal">
      <h2>${esc(doc.compare.heading)}</h2>
      <div class="compare">
      ${compare}
      </div>
      </section>

      ${doc.faq ? `<section class="reveal"><h2>${esc(doc.faq.heading)}</h2>\n      ${faq}</section>` : ""}

      ${learn ? `<section class="reveal">${learn}</section>` : ""}`;
}

export function renderModePage({ slug, lang, doc, updated, articleLinks = [] }) {
  const canonical = absUrl(urlPath(slug, lang));
  const ogImage = SITE.origin + "/og-image.jpg";

  return `<!doctype html>
<html lang="${BCP47[lang]}"${dirAttr(lang)}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(doc.title)}</title>
    <meta name="description" content="${esc(doc.description)}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />
    ${alternates(slug)}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16171d" media="(prefers-color-scheme: dark)" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${esc(doc.title)}" />
    <meta property="og:description" content="${esc(doc.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ogImage}" />
    <meta property="og:locale" content="${OG_LOCALE[lang]}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${esc(doc.title)}" />
    <meta name="twitter:description" content="${esc(doc.description)}" />
    <meta name="twitter:image" content="${ogImage}" />
    <script type="application/ld+json">${jsonLd(slug, lang, doc, updated)}</script>
    <style>${STYLE}</style>
  </head>
  <body>
    <div class="wrap">
      <header><span class="logo">⇌</span><a href="${ctaHref(lang)}">Relayium</a></header>
      ${body(slug, lang, doc, articleLinks)}
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("apps", lang)}">Apps</a>
        <a href="${urlPath("privacy", lang)}">${esc(doc.footer.privacy)}</a>
        <a href="${urlPath("terms", lang)}">${esc(doc.footer.terms)}</a>
        <a href="${urlPath("security", lang)}">${esc(doc.footer.security)}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
