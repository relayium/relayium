// web/scripts/pages/build-pages.mjs — pure builders (no disk IO).
import { LANGS, LANDING_LANGS, SITE, pagePath, urlPath, absUrl, landingUrl, landingPath, validateLangs } from "./shared.mjs";
import { renderLegalPage } from "./legal-template.mjs";
import { renderLandingPage } from "./landing-template.mjs";

export function buildLegalPages(docs) {
  const out = [];
  for (const doc of docs) {
    for (const lang of LANGS) {
      out.push({
        path: pagePath(doc.slug, lang),
        html: renderLegalPage({ slug: doc.slug, lang, doc: doc.langs[lang] }),
      });
    }
  }
  return out;
}

export function buildLandingPages(landing, articleLinksByLang = {}) {
  validateLangs("landing", landing.langs, LANDING_LANGS);
  return LANDING_LANGS.map((lang) => ({
    path: landingPath(lang),
    html: renderLandingPage({ lang, doc: landing.langs[lang], articleLinks: articleLinksByLang[lang] ?? [] }),
  }));
}

export function buildSitemap(docs, { home = true, landing = null } = {}) {
  const urls = [];
  const newest = docs.map((d) => d.langs.en.updated).sort().at(-1);
  if (home) urls.push({ loc: SITE.origin + "/", lastmod: newest, priority: "1.0", changefreq: "weekly" });
  if (landing) {
    for (const lang of LANDING_LANGS) {
      urls.push({ loc: absUrl(landingUrl(lang)), lastmod: landing.updated, priority: "0.8", changefreq: "weekly" });
    }
  }
  for (const doc of docs) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath(doc.slug, lang)), lastmod: doc.langs.en.updated, priority: "0.3", changefreq: "yearly" });
    }
  }
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n` +
        `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
