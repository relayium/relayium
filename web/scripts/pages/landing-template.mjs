// web/scripts/pages/landing-template.mjs — renders one static localized landing page.
// Self-contained: no JS, no external CSS. Styles are inlined so the page is
// independent of the Vite asset graph and fully crawlable with JS disabled.
import { LANGS, LANG_LABELS, GUIDES_LABELS, APPS_LABELS, PRICING_LABELS, PRICING_URL, BCP47, OG_LOCALE, OG_IMAGE_META, SITE, landingUrl, ctaHref, urlPath, absUrl, esc, dirAttr } from "./shared.mjs";

// Exported so mode-template.mjs (and any other landing-style page) can reuse the
// exact same inline stylesheet + page-shell classes instead of forking them.
export const STYLE = `
:root{--text:#6b6375;--text-h:#08060d;--bg:#fff;--border:#e5e4e7;--card:rgba(244,243,236,.5);--accent:#aa3bff;--accent-fg:#7e22ce;--accent-action:#6d28d9;--accent-action-deep:#4338ca;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--text:#9ca3af;--text-h:#f3f4f6;--bg:#16171d;--border:#2e303a;--card:rgba(47,48,58,.5);--accent:#c084fc;--accent-fg:#c084fc;--accent-action:#7c3aed;--accent-action-deep:#4f46e5}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 system-ui,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:820px;margin:0 auto;padding:0 20px 64px}
header{display:flex;align-items:center;gap:10px;padding:22px 0;border-bottom:1px solid var(--border)}
header .logo{width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;color:#fff;background:linear-gradient(135deg,var(--accent),#6d28d9)}
header a{color:var(--text-h);text-decoration:none;font-weight:600}
h1{color:var(--text-h);font-size:38px;letter-spacing:-.5px;margin:40px 0 12px}
h2{color:var(--text-h);font-size:24px;margin:44px 0 12px}
h3{color:var(--text-h);font-size:18px;margin:22px 0 4px}
.pitch{font-size:20px;margin:0 0 24px;max-width:42em}
p{margin:12px 0}ul{margin:12px 0;padding-inline-start:22px}li{margin:8px 0}
ol.steps{margin:12px 0;padding-inline-start:22px}ol.steps li{margin:10px 0}
.cta{display:inline-block;margin:8px 0 4px;padding:14px 28px;border-radius:10px;color:#fff;font-weight:600;font-size:17px;text-decoration:none;background:linear-gradient(135deg,var(--accent-action),var(--accent-action-deep))}
.langbar{display:flex;flex-wrap:wrap;gap:6px 12px;margin:16px 0 8px;font-size:13.5px}
.langbar a{color:var(--accent-fg);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
.why li b,.compare h3{color:var(--text-h)}
.learn{list-style:none;padding:0}.learn a{color:var(--accent-fg);text-decoration:none}
footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--border);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
footer a{color:var(--text-h);text-decoration:none}
header .logo{transition:transform .25s cubic-bezier(.22,1,.36,1)}header a:hover .logo{transform:rotate(-8deg) scale(1.08)}
.cta{transition:transform .18s ease,filter .18s ease}.cta:hover{transform:translateY(-1px);filter:brightness(1.06)}
/* Pure-CSS staggered entrance — keeps these pages JS-free and crawlable while
   still giving the content a little life on load. animation fill-mode:both ends
   fully visible, so nothing is ever stuck hidden (no-JS, old browsers, or IO
   quirks all resolve to visible). */
.reveal{animation:sec-in .55s cubic-bezier(.22,1,.36,1) both}
section.reveal:nth-of-type(1){animation-delay:.04s}
section.reveal:nth-of-type(2){animation-delay:.11s}
section.reveal:nth-of-type(3){animation-delay:.18s}
section.reveal:nth-of-type(4){animation-delay:.25s}
section.reveal:nth-of-type(5){animation-delay:.32s}
@keyframes sec-in{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.reveal{animation:none}header .logo,.cta{transition:none}header a:hover .logo,.cta:hover{transform:none}}
`;

function langBar(lang) {
  const links = LANGS.map((l) => {
    const cur = l === lang ? " aria-current=\"true\"" : "";
    return `<a href="${landingUrl(l)}"${cur}>${esc(LANG_LABELS[l])}</a>`;
  });
  return `<nav class="langbar" aria-label="Language">${links.join("")}</nav>`;
}

function alternates() {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(landingUrl(l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(landingUrl("en"))}" />`);
  return links.join("\n    ");
}

export function renderLandingPage({ lang, doc, articleLinks = [] }) {
  const canonical = absUrl(landingUrl(lang));
  const ogImage = SITE.origin + "/og-image.jpg";
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": ["WebApplication", "SoftwareApplication"],
        name: SITE.name,
        url: canonical,
        description: doc.description,
        applicationCategory: "UtilitiesApplication",
        operatingSystem: "Web",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        inLanguage: BCP47[lang],
      },
      {
        "@type": "FAQPage",
        inLanguage: BCP47[lang],
        mainEntity: doc.faq.items.map((f) => ({
          "@type": "Question",
          name: f.q,
          acceptedAnswer: { "@type": "Answer", text: f.a },
        })),
      },
    ],
  };

  const steps = doc.how.steps.map((s) => `<li>${esc(s)}</li>`).join("\n        ");
  const why = doc.why.items
    .map((it) => `<li><b>${esc(it.title)}</b> — ${esc(it.desc)}</li>`)
    .join("\n        ");
  const compare = doc.compare.items
    .map((it) => `<h3>${esc(it.title)}</h3>\n      <p>${esc(it.body)}</p>`)
    .join("\n      ");
  const faq = doc.faq.items
    .map((it) => `<h3>${esc(it.q)}</h3>\n      <p>${esc(it.a)}</p>`)
    .join("\n      ");
  const learn = articleLinks.length
    ? `<h2>${esc(doc.learnHeading)}</h2>\n      <ul class="learn">${articleLinks
        .map((a) => `<li><a href="${urlPath(a.slug, lang)}">${esc(a.title)}</a></li>`)
        .join("")}</ul>`
    : "";

  return `<!doctype html>
<html lang="${BCP47[lang]}"${dirAttr(lang)}>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(doc.title)}</title>
    <meta name="description" content="${esc(doc.description)}" />
    <meta name="robots" content="index, follow" />
    <link rel="canonical" href="${canonical}" />
    ${alternates()}
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#16171d" media="(prefers-color-scheme: dark)" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="${SITE.name}" />
    <meta property="og:title" content="${esc(doc.title)}" />
    <meta property="og:description" content="${esc(doc.description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:image" content="${ogImage}" />
    ${OG_IMAGE_META}
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
      <header><span class="logo" aria-hidden="true">⇌</span><a href="${ctaHref(lang)}">Relayium</a></header>
      ${langBar(lang)}
      <!-- The language bar and the footer are navigation, so the main landmark
           starts after them: a screen-reader user jumping to the main content
           should land on this page's own words, not on a row of language links. -->
      <main>
      <h1>${esc(doc.hero.h1)}</h1>
      <p class="pitch">${esc(doc.hero.pitch)}</p>
      <a class="cta" href="${ctaHref(lang)}">${esc(doc.hero.cta)}</a>

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

      <section class="reveal">
      <h2>${esc(doc.faq.heading)}</h2>
      ${faq}
      </section>

      ${learn ? `<section class="reveal">${learn}</section>` : ""}
      </main>
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("apps", lang)}">${esc(APPS_LABELS[lang])}</a>
        <a href="${urlPath("guides", lang)}">${esc(GUIDES_LABELS[lang])}</a>
        <a href="${urlPath("privacy", lang)}">${esc(doc.footer.privacy)}</a>
        <a href="${urlPath("terms", lang)}">${esc(doc.footer.terms)}</a>
        <a href="${urlPath("security", lang)}">${esc(doc.footer.security)}</a>
        <a href="${PRICING_URL}">${esc(PRICING_LABELS[lang])}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
