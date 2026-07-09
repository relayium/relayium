// web/scripts/pages/landing-template.mjs — renders one static localized landing page.
// Self-contained: no JS, no external CSS. Styles are inlined so the page is
// independent of the Vite asset graph and fully crawlable with JS disabled.
import { LANGS, LANG_LABELS, GUIDES_LABELS, BCP47, OG_LOCALE, SITE, landingUrl, ctaHref, urlPath, absUrl, esc } from "./shared.mjs";

const STYLE = `
:root{--text:#6b6375;--text-h:#08060d;--bg:#fff;--border:#e5e4e7;--card:rgba(244,243,236,.5);--accent:#aa3bff;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--text:#9ca3af;--text-h:#f3f4f6;--bg:#16171d;--border:#2e303a;--card:rgba(47,48,58,.5);--accent:#c084fc}}
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
p{margin:12px 0}ul{margin:12px 0;padding-left:22px}li{margin:8px 0}
ol.steps{margin:12px 0;padding-left:22px}ol.steps li{margin:10px 0}
.cta{display:inline-block;margin:8px 0 4px;padding:14px 28px;border-radius:10px;color:#fff;font-weight:600;font-size:17px;text-decoration:none;background:linear-gradient(135deg,var(--accent),#6d28d9)}
.langbar{display:flex;flex-wrap:wrap;gap:6px 14px;margin:24px 0 8px;font-size:14px}
.langbar a{color:var(--accent);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
.why li b,.compare h3{color:var(--text-h)}
.learn{list-style:none;padding:0}.learn a{color:var(--accent);text-decoration:none}
footer{margin-top:52px;padding-top:18px;border-top:1px solid var(--border);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
footer a{color:var(--text-h);text-decoration:none}
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
<html lang="${BCP47[lang]}">
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
      ${langBar(lang)}
      <h1>${esc(doc.hero.h1)}</h1>
      <p class="pitch">${esc(doc.hero.pitch)}</p>
      <a class="cta" href="${ctaHref(lang)}">${esc(doc.hero.cta)}</a>

      <h2>${esc(doc.how.heading)}</h2>
      <ol class="steps">
        ${steps}
      </ol>

      <h2>${esc(doc.why.heading)}</h2>
      <ul class="why">
        ${why}
      </ul>

      <h2>${esc(doc.compare.heading)}</h2>
      <div class="compare">
      ${compare}
      </div>

      <h2>${esc(doc.faq.heading)}</h2>
      ${faq}

      ${learn}
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("guides", lang)}">${esc(GUIDES_LABELS[lang])}</a>
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
