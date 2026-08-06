// web/scripts/pages/build-pages.mjs — pure builders (no disk IO).
import { LANGS, LANDING_LANGS, DEFAULT_LANG, SITE, SPA_ONLY_EN_SLUGS, pagePath, urlPath, absUrl, landingUrl, landingPath, validateLangs } from "./shared.mjs";
import { renderLegalPage } from "./legal-template.mjs";
import { renderLandingPage } from "./landing-template.mjs";
import { renderArticlePage } from "./article-template.mjs";
import { RELATED } from "./content/related-map.mjs";
import { renderGuidesIndexPage } from "./guides-index-template.mjs";
import { GROUPS, TAXONOMY } from "./content/taxonomy.mjs";
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

/**
 * /releases/, one page per language.
 *
 * It renders through the legal template because it is the same document shape,
 * with one addition the template knows about: the version list, which is shared
 * by all nine languages and so is passed once rather than per locale.
 */
export function buildReleasesPages(releasesDoc) {
  validateLangs("releases", releasesDoc.langs);
  return LANGS.map((lang) => ({
    path: pagePath(releasesDoc.slug, lang),
    html: renderLegalPage({
      slug: releasesDoc.slug,
      lang,
      doc: releasesDoc.langs[lang],
      releases: releasesDoc.releases,
    }),
  }));
}

export function buildLandingPages(landing, articleLinksByLang = {}, guidesIndex = null) {
  validateLangs("landing", landing.langs, LANDING_LANGS);
  return LANDING_LANGS.map((lang) => ({
    path: landingPath(lang),
    html: renderLandingPage({
      lang,
      doc: landing.langs[lang],
      articleLinks: articleLinksByLang[lang] ?? [],
      // 分类标题复用指南索引里已经翻译好的那三个词，不要在落地页再造一份。
      categories: guidesIndex?.langs[lang]?.categories ?? null,
      guidesHeading: guidesIndex?.langs[lang]?.heading ?? null,
    }),
  }));
}

export function buildArticlePages(articles) {
  const bySlug = new Map(articles.map((a) => [a.slug, a]));
  return articles.flatMap((a) => {
    validateLangs(a.slug, a.langs);
    return LANGS.map((lang) => ({
      path: pagePath(a.slug, lang),
      html: renderArticlePage({
        slug: a.slug,
        lang,
        doc: a.langs[lang],
        updated: a.updated,
        published: a.published,
        // Four curated links, not all 35 others. See content/related-map.mjs
        // for why, and related-map.test.mjs for the shape it has to keep.
        related: (RELATED[a.slug] ?? [])
          .map((s) => bySlug.get(s))
          .filter(Boolean)
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
const FALLBACK_GROUP = { guides: "concept", howTo: "scenario", compare: "compare" };

/**
 * Article lists for the hub, grouped two ways at once.
 *
 * The FIVE keys in GROUPS are the reading taxonomy (content/taxonomy.mjs) and
 * are what the main hub renders, ordered within each group rather than by
 * import order. The legacy howTo/compare keys are kept because /how-to and
 * /compare are real URLs whose pages render one group each — those are
 * addresses, and re-cutting them would spend redirect and SEO cost on what is
 * really a navigation change.
 */
export function articleGroupsByLang(articles) {
  return Object.fromEntries(
    LANGS.map((lang) => {
      const groups = { guides: [], howTo: [], compare: [] };
      for (const g of GROUPS) groups[g] = [];
      const ordered = [...articles].sort(
        (a, b) => (TAXONOMY[a.slug]?.[1] ?? 1e9) - (TAXONOMY[b.slug]?.[1] ?? 1e9),
      );
      for (const a of ordered) {
        const entry = { slug: a.slug, title: a.langs[lang].title };
        const legacy = CATEGORY_KEY[a.slug.split("/")[0]];
        // An article missing from the taxonomy falls back to the group its URL
        // prefix implies, rather than vanishing from the hub: being in the wrong
        // group is something someone notices, being on no page at all is not.
        // (The completeness test still fails on it, so the fallback buys a
        // readable page while the omission is fixed, not silence.)
        const g = TAXONOMY[a.slug]?.[0] ?? FALLBACK_GROUP[legacy];
        // `compare` is both a legacy bucket and a taxonomy group, so the two
        // pushes have to be deduped or every comparison appears twice.
        for (const key of new Set([legacy, g].filter(Boolean))) groups[key].push(entry);
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

/**
 * The /how-to/ and /compare/ roots, one page per language.
 *
 * `hub.langs[lang]` supplies only title/description/intro; the heading is the
 * category label the Guides hub already ships, so the two indexes can never
 * disagree about what a category is called. Each page lists exactly its own
 * category and links back up to the full index.
 */
export function buildCategoryIndexPages(hub, guidesIndex, groupsByLang) {
  validateLangs(`category-index:${hub.slug}`, hub.langs);
  return LANGS.map((lang) => {
    const guides = guidesIndex.langs[lang];
    return {
      path: pagePath(hub.slug, lang),
      html: renderGuidesIndexPage({
        lang,
        slug: hub.slug,
        only: hub.group,
        doc: { ...hub.langs[lang], heading: guides.categories[hub.group], categories: guides.categories },
        groups: groupsByLang[lang],
        backLabel: guides.heading,
      }),
    };
  });
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

export function buildSitemap(docs, { home = true, landing = null, articles = [], guidesIndex = null, categoryHubs = [], modes = [], spaPages = [], releases = null } = {}) {
  // urlPath() only keeps a mode's English URL slash-less if the slug is listed in
  // SPA_ONLY_EN_SLUGS. A mode added here but not there would emit /new-mode/ —
  // a URL with no directory behind it. Fail the build instead.
  const unlisted = modes.map((m) => m.slug).filter((s) => !SPA_ONLY_EN_SLUGS.has(s));
  if (unlisted.length) {
    throw new Error(`buildSitemap: mode slugs missing from SPA_ONLY_EN_SLUGS in shared.mjs: ${unlisted.join(", ")}`);
  }
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
      // 0.8, above the 0.6 articles it indexes. It was 0.5 — the one hub on the
      // site ranked below every page hanging off it, which is backwards for the
      // page we most want crawled often. (Google treats priority as a weak hint
      // at best; this is for internal consistency more than for Google.)
      urls.push({ loc: absUrl(urlPath("guides", lang)), lastmod: guidesIndex.updated, priority: "0.8", changefreq: "weekly" });
    }
  }
  // The category roots rank with the hub they split, not with the articles they
  // list — same reasoning as the 0.8 above.
  for (const hub of categoryHubs) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath(hub.slug, lang)), lastmod: hub.updated, priority: "0.8", changefreq: "weekly" });
    }
  }
  // /releases/ is a legal-shaped page but not a legal one: it gains a row every
  // time a version ships, so it gets the weekly changefreq the legal pages'
  // "yearly" would be wrong about, and a priority above them.
  if (releases) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath(releases.slug, lang)), lastmod: releases.updated, priority: "0.4", changefreq: "weekly" });
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
  // English-only SPA routes (/pricing, /cli). They have no localized twin and no
  // generated directory, so they carry no trailing slash and no hreflang cluster
  // — but they are public pages, and leaving them out of the sitemap is why
  // /pricing had zero coverage while the router called it "public marketing".
  for (const p of spaPages) {
    urls.push({ loc: absUrl(p.path), lastmod: p.updated ?? newest, priority: "0.7", changefreq: "monthly" });
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
