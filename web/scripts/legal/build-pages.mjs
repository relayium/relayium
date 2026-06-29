// web/scripts/legal/build-pages.mjs — pure builders (no disk IO).
import { LANGS, SITE, pagePath, urlPath, absUrl } from "./shared.mjs";
import { renderLegalPage } from "./template.mjs";

export function buildAllPages(docs) {
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

export function buildSitemap(docs, { home = true } = {}) {
  const lastmod = "2026-06-29";
  const urls = [];
  if (home) urls.push({ loc: SITE.origin + "/", priority: "1.0", changefreq: "weekly" });
  for (const doc of docs) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath(doc.slug, lang)), priority: "0.3", changefreq: "yearly" });
    }
  }
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n` +
        `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}
