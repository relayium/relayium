// web/scripts/pages/build-pages.mjs — pure builders (no disk IO).
import { LANGS, LANDING_LANGS, DEFAULT_LANG, SITE, pagePath, urlPath, absUrl, landingUrl, landingPath, validateLangs } from "./shared.mjs";
import { renderLegalPage } from "./legal-template.mjs";
import { renderLandingPage } from "./landing-template.mjs";
import { renderArticlePage } from "./article-template.mjs";
import { renderGuidesIndexPage } from "./guides-index-template.mjs";
import { renderModePage } from "./mode-template.mjs";

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

export function buildArticlePages(articles) {
  return articles.flatMap((a) => {
    validateLangs(a.slug, a.langs);
    return LANGS.map((lang) => ({
      path: pagePath(a.slug, lang),
      html: renderArticlePage({
        slug: a.slug,
        lang,
        doc: a.langs[lang],
        updated: a.updated,
        related: articles
          .filter((o) => o.slug !== a.slug)
          .map((o) => ({ slug: o.slug, title: o.langs[lang].title })),
      }),
    }));
  });
}

export function articleLinksByLang(articles) {
  return Object.fromEntries(
    LANGS.map((lang) => [lang, articles.map((a) => ({ slug: a.slug, title: a.langs[lang].title }))])
  );
}

const CATEGORY_KEY = { guides: "guides", "how-to": "howTo", compare: "compare" };

export function articleGroupsByLang(articles) {
  return Object.fromEntries(
    LANGS.map((lang) => {
      const groups = { guides: [], howTo: [], compare: [] };
      for (const a of articles) {
        const key = CATEGORY_KEY[a.slug.split("/")[0]];
        if (key) groups[key].push({ slug: a.slug, title: a.langs[lang].title });
      }
      return [lang, groups];
    })
  );
}

export function buildGuidesIndexPages(guidesIndex, groupsByLang) {
  validateLangs("guides-index", guidesIndex.langs);
  return LANGS.map((lang) => ({
    path: pagePath("guides", lang),
    html: renderGuidesIndexPage({ lang, doc: guidesIndex.langs[lang], groups: groupsByLang[lang] }),
  }));
}

export function buildModePages(modeDef, { slug, learn = null }) {
  validateLangs(`mode:${slug}`, modeDef.langs, LANDING_LANGS);
  return LANDING_LANGS.map((lang) => ({
    path: pagePath(slug, lang),
    html: renderModePage({
      slug,
      lang,
      doc: modeDef.langs[lang],
      updated: modeDef.updated,
      articleLinks: learn?.[lang] ?? [],
    }),
  }));
}

export function buildSitemap(docs, { home = true, landing = null, articles = [], guidesIndex = null, modes = [] } = {}) {
  const urls = [];
  const newest = [
    ...docs.map((d) => d.langs.en.updated),
    ...(landing ? [landing.updated] : []),
    ...articles.map((a) => a.updated),
    ...(guidesIndex ? [guidesIndex.updated] : []),
    ...modes.map((m) => m.def.updated),
  ].sort().at(-1);
  if (home) urls.push({ loc: SITE.origin + "/", lastmod: newest, priority: "1.0", changefreq: "weekly" });
  if (guidesIndex) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath("guides", lang)), lastmod: guidesIndex.updated, priority: "0.5", changefreq: "monthly" });
    }
  }
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
  for (const article of articles) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath(article.slug, lang)), lastmod: article.updated, priority: "0.6", changefreq: "monthly" });
    }
  }
  for (const { def, slug } of modes) {
    urls.push({ loc: absUrl(urlPath(slug, DEFAULT_LANG)), lastmod: def.updated, priority: "0.8", changefreq: "weekly" }); // english SPA route
    for (const lang of LANDING_LANGS) {
      urls.push({ loc: absUrl(urlPath(slug, lang)), lastmod: def.updated, priority: "0.8", changefreq: "weekly" });
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
