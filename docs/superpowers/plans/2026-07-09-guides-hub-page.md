# Guides Hub Page + Footer Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the 11-article content section a name ("Guides") and a single front door — a generated static `/guides` hub page listing all articles by category, reachable from a "Guides" link in every footer.

**Architecture:** The hub is a static, self-contained HTML page generated at build time by the existing `web/scripts/pages/` pipeline (inlined CSS, no JS, crawlable, independent of the Svelte SPA) — exactly like the landing and article pages. Articles are grouped by their slug prefix (`guides/`, `how-to/`, `compare/`). Footers in the SPA, landing pages, and article pages each get one localized "Guides" link pointing to the hub.

**Tech Stack:** Node ESM build scripts (`.mjs`), Vitest, Svelte 5 SPA, TypeScript i18n tables.

## Global Constraints

- Six languages everywhere, in this exact order: `en, zh, ja, ko, de, fr` (`LANGS` in `web/scripts/pages/shared.mjs`; `LANGS` array in `web/src/lib/i18n/types.ts`).
- English (`en`) URLs are unprefixed (`/guides`); other languages are prefixed (`/zh/guides`). Use `pagePath`/`urlPath` (build scripts) and `pageUrl` (SPA) — never hand-build paths.
- Static pages are self-contained: inline `<style>`, no external CSS, no JS. Follow `article-template.mjs` conventions verbatim (canonical, `hreflang` alternates, OG/Twitter meta, JSON-LD).
- Every generated doc must pass `validateLangs` (all 6 languages present) or the build fails.
- Run tests from `web/`: `npm test -- --run` (vitest). Regenerate pages with `npm run gen:pages`.
- Category → content-key mapping is fixed: slug prefix `guides` → `guides`, `how-to` → `howTo`, `compare` → `compare`. Render order is always Guides → How-to → Compare.

---

## Localized string reference (use verbatim)

**Hub "Guides" word** — used for footer link labels (`GUIDES_LABELS`, `learn.hub`) and the hub H1 (`heading`):

| lang | value |
|---|---|
| en | Guides |
| zh | 使用指南 |
| ja | ガイド |
| ko | 가이드 |
| de | Anleitungen |
| fr | Guides |

**Category labels** (`categories.guides` / `.howTo` / `.compare`):

| lang | guides | howTo | compare |
|---|---|---|---|
| en | Guides | How-to | Comparisons |
| zh | 教程 | 操作指南 | 对比 |
| ja | ガイド | ハウツー | 比較 |
| ko | 가이드 | 사용법 | 비교 |
| de | Anleitungen | How-to | Vergleiche |
| fr | Guides | Tutoriels | Comparatifs |

**Hub page `<title>`** (`title`): "Guides · Relayium" localized —
en `Guides · Relayium` · zh `使用指南 · Relayium` · ja `ガイド · Relayium` · ko `가이드 · Relayium` · de `Anleitungen · Relayium` · fr `Guides · Relayium`

**Hub meta `description`** and **intro** (`description`, `intro`):

- en — description: `Step-by-step guides and comparisons for moving files with Relayium — from the terminal, between phones, server to server, and versus other tools.` / intro: `Everything about moving files with Relayium — terminal how-tos, phone-to-phone transfers, and honest comparisons with other tools.`
- zh — description: `用 Relayium 传输文件的分步指南与对比：从终端、手机之间、服务器到服务器，以及与其它工具的对比。` / intro: `关于用 Relayium 传输文件的一切——终端操作、手机互传，以及与其它工具的坦诚对比。`
- ja — description: `Relayium でファイルを転送するためのステップバイステップのガイドと比較。ターミナル、スマホ間、サーバー間、他ツールとの比較まで。` / intro: `Relayium でのファイル転送のすべて——ターミナル操作、スマホ間転送、他ツールとの率直な比較。`
- ko — description: `Relayium으로 파일을 전송하는 단계별 가이드와 비교. 터미널, 휴대폰 간, 서버 간, 다른 도구와의 비교까지.` / intro: `Relayium으로 파일을 전송하는 모든 것 — 터미널 사용법, 휴대폰 간 전송, 다른 도구와의 솔직한 비교.`
- de — description: `Schritt-für-Schritt-Anleitungen und Vergleiche zum Übertragen von Dateien mit Relayium — vom Terminal, zwischen Handys, Server zu Server und im Vergleich zu anderen Tools.` / intro: `Alles zum Übertragen von Dateien mit Relayium — Terminal-Anleitungen, Handy-zu-Handy-Übertragungen und ehrliche Vergleiche mit anderen Tools.`
- fr — description: `Guides pas à pas et comparatifs pour transférer des fichiers avec Relayium — depuis le terminal, entre téléphones, de serveur à serveur, et face aux autres outils.` / intro: `Tout pour transférer des fichiers avec Relayium — tutoriels en terminal, transferts entre téléphones et comparatifs honnêtes avec d'autres outils.`

---

## File structure

New:
- `web/scripts/pages/content/guides-index.mjs` — localized chrome (title/description/heading/intro/categories) for the hub. One responsibility: hub copy.
- `web/scripts/pages/guides-index-template.mjs` — pure renderer `renderGuidesIndexPage({lang, doc, groups})` → HTML string.
- `web/scripts/pages/guides-index-template.test.mjs` — renderer unit tests.

Modified:
- `web/scripts/pages/build-pages.mjs` — add `articleGroupsByLang`, `buildGuidesIndexPages`; extend `buildSitemap`.
- `web/scripts/pages/build-pages.test.mjs` — cover the two new builders + sitemap.
- `web/scripts/gen-pages.mjs` — wire the hub into `pages` + sitemap.
- `web/scripts/pages/shared.mjs` — add `GUIDES_LABELS`.
- `web/scripts/pages/landing-template.mjs` — footer "Guides" link.
- `web/scripts/pages/article-template.mjs` — footer "Guides" link.
- `web/src/App.svelte` — SPA footer: replace 6-link block with one "Guides" link.
- `web/src/lib/i18n/{en,zh,ja,ko,de,fr}.ts` — `learn` object → `{ hub }`.
- `web/src/lib/i18n/types.ts` — `learn` interface → `{ hub: string }`.
- `web/src/lib/i18n.test.ts` — update `learn strings` test.

---

## Task 1: Group articles by category

**Files:**
- Modify: `web/scripts/pages/build-pages.mjs`
- Test: `web/scripts/pages/build-pages.test.mjs`

**Interfaces:**
- Consumes: the `articles` array (each item `{ slug, updated, langs: { <lang>: { title, … } } }`) already imported by `gen-pages.mjs`.
- Produces: `articleGroupsByLang(articles)` → `{ [lang]: { guides: {slug,title}[], howTo: {slug,title}[], compare: {slug,title}[] } }`, grouping by `slug.split("/")[0]`, preserving input order within each group.

- [ ] **Step 1: Write the failing test**

Add to `web/scripts/pages/build-pages.test.mjs` (after the existing imports, extend the `build-pages.mjs` import to include `articleGroupsByLang`):

```js
import { buildLegalPages, buildSitemap, articleGroupsByLang } from "./build-pages.mjs";

const fakeArticles = [
  { slug: "compare/snapdrop", updated: "2026-07-01", langs: Object.fromEntries(
      ["en","zh","ja","ko","de","fr"].map((l) => [l, { title: `snap-${l}` }])) },
  { slug: "how-to/x", updated: "2026-07-02", langs: Object.fromEntries(
      ["en","zh","ja","ko","de","fr"].map((l) => [l, { title: `howto-${l}` }])) },
  { slug: "guides/y", updated: "2026-07-03", langs: Object.fromEntries(
      ["en","zh","ja","ko","de","fr"].map((l) => [l, { title: `guide-${l}` }])) },
];

describe("articleGroupsByLang", () => {
  const groups = articleGroupsByLang(fakeArticles);

  it("has all six languages", () => {
    expect(Object.keys(groups).sort()).toEqual(["de","en","fr","ja","ko","zh"]);
  });

  it("buckets each article by slug prefix into guides/howTo/compare", () => {
    expect(groups.en.compare.map((a) => a.slug)).toEqual(["compare/snapdrop"]);
    expect(groups.en.howTo.map((a) => a.slug)).toEqual(["how-to/x"]);
    expect(groups.en.guides.map((a) => a.slug)).toEqual(["guides/y"]);
  });

  it("uses the language-specific title", () => {
    expect(groups.zh.guides[0].title).toBe("guide-zh");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npm test -- --run build-pages`
Expected: FAIL — `articleGroupsByLang is not a function` (or import error).

- [ ] **Step 3: Write minimal implementation**

In `web/scripts/pages/build-pages.mjs`, add after the existing `articleLinksByLang` function:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npm test -- --run build-pages`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/scripts/pages/build-pages.mjs web/scripts/pages/build-pages.test.mjs
git commit -m "feat(web): group articles by category for the Guides hub"
```

---

## Task 2: Hub content module + renderer

**Files:**
- Create: `web/scripts/pages/content/guides-index.mjs`
- Create: `web/scripts/pages/guides-index-template.mjs`
- Test: `web/scripts/pages/guides-index-template.test.mjs`

**Interfaces:**
- Consumes: `shared.mjs` helpers (`LANGS`, `DEFAULT_LANG`, `LANG_LABELS`, `BCP47`, `OG_LOCALE`, `SITE`, `urlPath`, `absUrl`, `esc`, `ctaHref`).
- Produces:
  - `guides-index.mjs` default export `{ slug: "guides", updated: "2026-07-09", langs: { en, zh, ja, ko, de, fr } }`, each language `{ title, description, heading, intro, categories: { guides, howTo, compare } }`.
  - `renderGuidesIndexPage({ lang, doc, groups })` → HTML string, where `doc` is one language object above and `groups` is `groupsByLang[lang]` from Task 1 (`{ guides:[], howTo:[], compare:[] }`, each entry `{slug,title}`).

- [ ] **Step 1: Write the content module**

Create `web/scripts/pages/content/guides-index.mjs` (fill every language from the Localized string reference table — English shown; repeat the shape for zh/ja/ko/de/fr with their values):

```js
// web/scripts/pages/content/guides-index.mjs — localized copy for the Guides hub page.
// English is the master; the other five follow the identical shape.
const en = {
  title: "Guides · Relayium",
  description:
    "Step-by-step guides and comparisons for moving files with Relayium — from the terminal, between phones, server to server, and versus other tools.",
  heading: "Guides",
  intro:
    "Everything about moving files with Relayium — terminal how-tos, phone-to-phone transfers, and honest comparisons with other tools.",
  categories: { guides: "Guides", howTo: "How-to", compare: "Comparisons" },
};
const zh = {
  title: "使用指南 · Relayium",
  description:
    "用 Relayium 传输文件的分步指南与对比：从终端、手机之间、服务器到服务器，以及与其它工具的对比。",
  heading: "使用指南",
  intro: "关于用 Relayium 传输文件的一切——终端操作、手机互传，以及与其它工具的坦诚对比。",
  categories: { guides: "教程", howTo: "操作指南", compare: "对比" },
};
const ja = {
  title: "ガイド · Relayium",
  description:
    "Relayium でファイルを転送するためのステップバイステップのガイドと比較。ターミナル、スマホ間、サーバー間、他ツールとの比較まで。",
  heading: "ガイド",
  intro: "Relayium でのファイル転送のすべて——ターミナル操作、スマホ間転送、他ツールとの率直な比較。",
  categories: { guides: "ガイド", howTo: "ハウツー", compare: "比較" },
};
const ko = {
  title: "가이드 · Relayium",
  description:
    "Relayium으로 파일을 전송하는 단계별 가이드와 비교. 터미널, 휴대폰 간, 서버 간, 다른 도구와의 비교까지.",
  heading: "가이드",
  intro: "Relayium으로 파일을 전송하는 모든 것 — 터미널 사용법, 휴대폰 간 전송, 다른 도구와의 솔직한 비교.",
  categories: { guides: "가이드", howTo: "사용법", compare: "비교" },
};
const de = {
  title: "Anleitungen · Relayium",
  description:
    "Schritt-für-Schritt-Anleitungen und Vergleiche zum Übertragen von Dateien mit Relayium — vom Terminal, zwischen Handys, Server zu Server und im Vergleich zu anderen Tools.",
  heading: "Anleitungen",
  intro:
    "Alles zum Übertragen von Dateien mit Relayium — Terminal-Anleitungen, Handy-zu-Handy-Übertragungen und ehrliche Vergleiche mit anderen Tools.",
  categories: { guides: "Anleitungen", howTo: "How-to", compare: "Vergleiche" },
};
const fr = {
  title: "Guides · Relayium",
  description:
    "Guides pas à pas et comparatifs pour transférer des fichiers avec Relayium — depuis le terminal, entre téléphones, de serveur à serveur, et face aux autres outils.",
  heading: "Guides",
  intro:
    "Tout pour transférer des fichiers avec Relayium — tutoriels en terminal, transferts entre téléphones et comparatifs honnêtes avec d'autres outils.",
  categories: { guides: "Guides", howTo: "Tutoriels", compare: "Comparatifs" },
};

export default { slug: "guides", updated: "2026-07-09", langs: { en, zh, ja, ko, de, fr } };
```

- [ ] **Step 2: Write the failing renderer test**

Create `web/scripts/pages/guides-index-template.test.mjs`:

```js
import { describe, it, expect } from "vitest";
import { renderGuidesIndexPage } from "./guides-index-template.mjs";
import guidesIndex from "./content/guides-index.mjs";

const groups = {
  guides: [{ slug: "guides/y", title: "Guide Y" }],
  howTo: [{ slug: "how-to/x", title: "Howto X" }],
  compare: [{ slug: "compare/snapdrop", title: "vs Snapdrop" }],
};

describe("renderGuidesIndexPage", () => {
  const en = renderGuidesIndexPage({ lang: "en", doc: guidesIndex.langs.en, groups });
  const zh = renderGuidesIndexPage({ lang: "zh", doc: guidesIndex.langs.zh, groups });

  it("renders the H1 heading and the three category headings", () => {
    expect(en).toContain("<h1>Guides</h1>");
    expect(en).toContain(">Guides</h2>");
    expect(en).toContain(">How-to</h2>");
    expect(en).toContain(">Comparisons</h2>");
  });

  it("links every article with the language-correct URL", () => {
    expect(en).toContain('href="/guides/y"');
    expect(en).toContain('href="/how-to/x"');
    expect(en).toContain('href="/compare/snapdrop"');
    expect(zh).toContain('href="/zh/guides/y"');
  });

  it("sets canonical + hreflang for the hub", () => {
    expect(en).toContain('<link rel="canonical" href="https://relayium.com/guides" />');
    expect(en).toContain('href="https://relayium.com/zh/guides"');
  });

  it("skips an empty category", () => {
    const html = renderGuidesIndexPage({
      lang: "en", doc: guidesIndex.langs.en,
      groups: { guides: [], howTo: [{ slug: "how-to/x", title: "Howto X" }], compare: [] },
    });
    expect(html).not.toContain(">Guides</h2>");
    expect(html).not.toContain(">Comparisons</h2>");
    expect(html).toContain(">How-to</h2>");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npm test -- --run guides-index-template`
Expected: FAIL — cannot import `renderGuidesIndexPage`.

- [ ] **Step 4: Write the renderer**

Create `web/scripts/pages/guides-index-template.mjs`:

```js
// web/scripts/pages/guides-index-template.mjs — renders the Guides hub (one language)
// to a self-contained static HTML string. Same inlined-style, no-JS approach as
// article-template.mjs so it is crawlable and independent of the Vite asset graph.
import { LANGS, DEFAULT_LANG, LANG_LABELS, BCP47, OG_LOCALE, SITE, urlPath, absUrl, esc, ctaHref } from "./shared.mjs";

// Copy this verbatim from article-template.mjs:7-10 (same six labels).
const PRIVACY_LABELS = {
  en: "Privacy", zh: "隐私政策", ja: "プライバシーポリシー",
  ko: "개인정보 처리방침", de: "Datenschutz", fr: "Confidentialité",
};

const STYLE = `
:root{--text:#6b6375;--text-h:#08060d;--bg:#fff;--border:#e5e4e7;--card:rgba(244,243,236,.5);--accent:#aa3bff;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--text:#9ca3af;--text-h:#f3f4f6;--bg:#16171d;--border:#2e303a;--card:rgba(47,48,58,.5);--accent:#c084fc}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:17px/1.6 system-ui,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:0 20px 64px}
header{display:flex;align-items:center;gap:10px;padding:22px 0;border-bottom:1px solid var(--border)}
header .logo{width:30px;height:30px;line-height:30px;text-align:center;border-radius:8px;color:#fff;background:linear-gradient(135deg,var(--accent),#6d28d9)}
header a{color:var(--text-h);text-decoration:none;font-weight:600}
h1{color:var(--text-h);font-size:34px;letter-spacing:-.5px;margin:36px 0 6px}
h2{color:var(--text-h);font-size:23px;margin:38px 0 10px}
.lead{font-size:19px}
p{margin:12px 0}ul{margin:12px 0;padding-left:0}
.langbar{display:flex;flex-wrap:wrap;gap:6px 14px;margin:24px 0 8px;font-size:14px}
.langbar a{color:var(--accent);text-decoration:none}.langbar a[aria-current]{color:var(--text);font-weight:600}
.guidelist{list-style:none;padding:0}.guidelist li{margin:8px 0}.guidelist a{color:var(--accent);text-decoration:none;font-size:18px}
footer{margin-top:48px;padding-top:18px;border-top:1px solid var(--border);font-size:14px;display:flex;gap:16px;flex-wrap:wrap}
footer a{color:var(--text-h);text-decoration:none}
`;

function langBar(lang) {
  const links = LANGS.map((l) => {
    const cur = l === lang ? " aria-current=\"true\"" : "";
    return `<a href="${urlPath("guides", l)}"${cur}>${esc(LANG_LABELS[l])}</a>`;
  });
  return `<nav class="langbar" aria-label="Language">${links.join("")}</nav>`;
}

function alternates() {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath("guides", l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath("guides", DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

function groupSection(label, items, lang) {
  if (!items.length) return "";
  const lis = items
    .map((a) => `<li><a href="${urlPath(a.slug, lang)}">${esc(a.title)}</a></li>`)
    .join("");
  return `<h2>${esc(label)}</h2>\n      <ul class="guidelist">${lis}</ul>`;
}

export function renderGuidesIndexPage({ lang, doc, groups }) {
  const canonical = absUrl(urlPath("guides", lang));
  const ogImage = SITE.origin + "/og-image.jpg";
  const ordered = [
    [doc.categories.guides, groups.guides],
    [doc.categories.howTo, groups.howTo],
    [doc.categories.compare, groups.compare],
  ];
  const flat = ordered.flatMap(([, items]) => items);
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "CollectionPage",
        name: doc.heading,
        description: doc.description,
        inLanguage: BCP47[lang],
        url: canonical,
        mainEntity: {
          "@type": "ItemList",
          itemListElement: flat.map((a, i) => ({
            "@type": "ListItem",
            position: i + 1,
            url: absUrl(urlPath(a.slug, lang)),
            name: a.title,
          })),
        },
      },
    ],
  };
  const sections = ordered.map(([label, items]) => groupSection(label, items, lang)).filter(Boolean).join("\n      ");

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
      <h1>${esc(doc.heading)}</h1>
      <p class="lead">${esc(doc.intro)}</p>
      ${langBar(lang)}
      ${sections}
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("privacy", lang)}">${esc(PRIVACY_LABELS[lang])}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
    </div>
  </body>
</html>
`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npm test -- --run guides-index-template`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/scripts/pages/content/guides-index.mjs web/scripts/pages/guides-index-template.mjs web/scripts/pages/guides-index-template.test.mjs
git commit -m "feat(web): add Guides hub page content + renderer"
```

---

## Task 3: Generate the hub pages + sitemap wiring

**Files:**
- Modify: `web/scripts/pages/build-pages.mjs`
- Modify: `web/scripts/gen-pages.mjs`
- Test: `web/scripts/pages/build-pages.test.mjs`

**Interfaces:**
- Consumes: `articleGroupsByLang` (Task 1), `renderGuidesIndexPage` + `guides-index.mjs` (Task 2).
- Produces:
  - `buildGuidesIndexPages(guidesIndex, groupsByLang)` → `[{ path, html }]`, one per `LANGS`, `path` = `pagePath("guides", lang)`.
  - `buildSitemap(docs, { home, landing, articles, guidesIndex })` — now also emits 6 hub URLs (priority `0.5`, changefreq `monthly`) when `guidesIndex` is passed, and includes `guidesIndex.updated` in the newest-lastmod calc.

- [ ] **Step 1: Write the failing tests**

In `web/scripts/pages/build-pages.test.mjs`, extend the `build-pages.mjs` import to add `buildGuidesIndexPages`, import the content module and Task-1 helper, then add:

```js
import { buildLegalPages, buildSitemap, articleGroupsByLang, buildGuidesIndexPages } from "./build-pages.mjs";
import guidesIndex from "./content/guides-index.mjs";

describe("buildGuidesIndexPages", () => {
  const pages = buildGuidesIndexPages(guidesIndex, articleGroupsByLang(fakeArticles));

  it("produces one page per language at the guides path", () => {
    expect(pages.length).toBe(6);
    expect(pages.map((p) => p.path)).toContain("guides/index.html");
    expect(pages.map((p) => p.path)).toContain("zh/guides/index.html");
  });

  it("renders the localized H1 and links the grouped articles", () => {
    const zh = pages.find((p) => p.path === "zh/guides/index.html");
    expect(zh.html).toContain("<h1>使用指南</h1>");
    expect(zh.html).toContain('href="/zh/guides/y"');
    expect(zh.html).toContain('href="/zh/compare/snapdrop"');
  });
});

describe("buildSitemap with guidesIndex", () => {
  const xml = buildSitemap(docs, { home: true, guidesIndex });
  it("adds the six hub URLs", () => {
    expect(xml).toContain("<loc>https://relayium.com/guides</loc>");
    expect(xml).toContain("<loc>https://relayium.com/fr/guides</loc>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npm test -- --run build-pages`
Expected: FAIL — `buildGuidesIndexPages is not a function`; hub URL not in sitemap.

- [ ] **Step 3: Implement the builder + sitemap extension**

In `web/scripts/pages/build-pages.mjs`, add the import at the top (next to the other template imports):

```js
import { renderGuidesIndexPage } from "./guides-index-template.mjs";
```

Add the builder (after `articleGroupsByLang`):

```js
export function buildGuidesIndexPages(guidesIndex, groupsByLang) {
  validateLangs("guides-index", guidesIndex.langs);
  return LANGS.map((lang) => ({
    path: pagePath("guides", lang),
    html: renderGuidesIndexPage({ lang, doc: guidesIndex.langs[lang], groups: groupsByLang[lang] }),
  }));
}
```

Update `buildSitemap`'s signature and body. Change the destructure to include `guidesIndex`, add its date to `newest`, and push its URLs:

```js
export function buildSitemap(docs, { home = true, landing = null, articles = [], guidesIndex = null } = {}) {
  const urls = [];
  const newest = [
    ...docs.map((d) => d.langs.en.updated),
    ...(landing ? [landing.updated] : []),
    ...articles.map((a) => a.updated),
    ...(guidesIndex ? [guidesIndex.updated] : []),
  ].sort().at(-1);
  if (home) urls.push({ loc: SITE.origin + "/", lastmod: newest, priority: "1.0", changefreq: "weekly" });
  if (guidesIndex) {
    for (const lang of LANGS) {
      urls.push({ loc: absUrl(urlPath("guides", lang)), lastmod: guidesIndex.updated, priority: "0.5", changefreq: "monthly" });
    }
  }
  if (landing) {
```

(Leave the rest of `buildSitemap` — landing loop, docs loop, articles loop, body join — unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test -- --run build-pages`
Expected: PASS.

- [ ] **Step 5: Wire into the generator**

In `web/scripts/gen-pages.mjs`:

Add the content import (next to the `landing` import):

```js
import guidesIndex from "./pages/content/guides-index.mjs";
```

Extend the builders import block to include the two new functions:

```js
import {
  buildLegalPages,
  buildLandingPages,
  buildArticlePages,
  buildGuidesIndexPages,
  buildSitemap,
  articleLinksByLang,
  articleGroupsByLang,
} from "./pages/build-pages.mjs";
```

Add the hub pages to the `pages` array (after the articles line):

```js
    ...buildArticlePages(articles),
    ...buildGuidesIndexPages(guidesIndex, articleGroupsByLang(articles)),
```

Pass `guidesIndex` to the sitemap call:

```js
    buildSitemap(legalDocs, { home: true, landing, articles, guidesIndex }),
```

- [ ] **Step 6: Regenerate and verify the files land**

Run: `cd web && npm run gen:pages`
Expected: prints `gen-pages: wrote <N> pages + sitemap.xml`, where N increased by 6.

Run: `ls web/public/guides/index.html web/public/zh/guides/index.html && grep -c "relayium.com/guides<" web/public/sitemap.xml`
Expected: both files listed; grep prints `1`.

- [ ] **Step 7: Commit**

```bash
git add web/scripts/pages/build-pages.mjs web/scripts/pages/build-pages.test.mjs web/scripts/gen-pages.mjs web/public/guides web/public/*/guides web/public/sitemap.xml
git commit -m "feat(web): generate /guides hub pages + list them in sitemap"
```

---

## Task 4: Footer "Guides" link on static landing + article pages

**Files:**
- Modify: `web/scripts/pages/shared.mjs`
- Modify: `web/scripts/pages/landing-template.mjs`
- Modify: `web/scripts/pages/article-template.mjs`
- Test: `web/scripts/pages/landing-template.test.mjs`, `web/scripts/pages/article-template.test.mjs`

**Interfaces:**
- Consumes: `urlPath` (existing).
- Produces: `GUIDES_LABELS` (per-language "Guides" word) exported from `shared.mjs`, used by both static footers.

- [ ] **Step 1: Add the shared label constant**

In `web/scripts/pages/shared.mjs`, add after `LANG_LABELS`:

```js
// Footer link label for the Guides hub, per language.
export const GUIDES_LABELS = {
  en: "Guides", zh: "使用指南", ja: "ガイド", ko: "가이드", de: "Anleitungen", fr: "Guides",
};
```

- [ ] **Step 2: Write the failing footer tests**

In `web/scripts/pages/article-template.test.mjs`, add (adjust the render call to match how the existing tests in that file call `renderArticlePage` — reuse their fixture):

```js
it("links the Guides hub in the footer", () => {
  // `html` here is a rendered en article from the existing test setup.
  expect(html).toContain('href="/guides">Guides<');
});
```

In `web/scripts/pages/landing-template.test.mjs`, add (reuse that file's existing rendered-page fixture; use a non-en lang if the fixture is zh):

```js
it("links the Guides hub in the footer", () => {
  // `html` is a rendered zh landing page from the existing test setup.
  expect(html).toContain('href="/zh/guides">使用指南<');
});
```

If a suitable `html` fixture variable does not already exist in the test file, render one at the top of the new test using the same content import and `renderArticlePage`/`renderLandingPage` call the file already demonstrates.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npm test -- --run article-template landing-template`
Expected: FAIL — footer does not contain the Guides link.

- [ ] **Step 4: Add the link to the article footer**

In `web/scripts/pages/article-template.mjs`, add `GUIDES_LABELS` to the `shared.mjs` import, then in the `<footer>` block insert the Guides link between the Relayium and Privacy links:

```js
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("guides", lang)}">${esc(GUIDES_LABELS[lang])}</a>
        <a href="${urlPath("privacy", lang)}">${esc(PRIVACY_LABELS[lang])}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
```

- [ ] **Step 5: Add the link to the landing footer**

In `web/scripts/pages/landing-template.mjs`, add `GUIDES_LABELS` to the `shared.mjs` import, then insert the Guides link into the `<footer>` right after the Relayium link and before Privacy — matching the article footer's placement so both footers group Guides with the brand link, ahead of the legal cluster:

```js
      <footer>
        <a href="${ctaHref(lang)}">← ${esc(SITE.name)}</a>
        <a href="${urlPath("guides", lang)}">${esc(GUIDES_LABELS[lang])}</a>
        <a href="${urlPath("privacy", lang)}">${esc(doc.footer.privacy)}</a>
        <a href="${urlPath("terms", lang)}">${esc(doc.footer.terms)}</a>
        <a href="${urlPath("security", lang)}">${esc(doc.footer.security)}</a>
        <a href="https://github.com/relayium/relayium">GitHub</a>
      </footer>
```

- [ ] **Step 6: Run tests + regenerate**

Run: `cd web && npm test -- --run article-template landing-template`
Expected: PASS.

Run: `cd web && npm run gen:pages`
Expected: succeeds (regenerates footers into `public/`).

- [ ] **Step 7: Commit**

```bash
git add web/scripts/pages/shared.mjs web/scripts/pages/article-template.mjs web/scripts/pages/landing-template.mjs web/scripts/pages/*.test.mjs web/public
git commit -m "feat(web): link the Guides hub from article + landing footers"
```

---

## Task 5: SPA footer single "Guides" link + i18n

**Files:**
- Modify: `web/src/lib/i18n/types.ts`
- Modify: `web/src/lib/i18n/{en,zh,ja,ko,de,fr}.ts`
- Modify: `web/src/App.svelte:1302-1309`
- Test: `web/src/lib/i18n.test.ts`

**Interfaces:**
- Consumes: `pageUrl` (existing, from `i18n.svelte.ts`).
- Produces: `Messages["learn"]` is now `{ hub: string }`; SPA footer renders one `<a href={pageUrl("guides", lang())}>{t.learn.hub}</a>`.

- [ ] **Step 1: Update the i18n type**

In `web/src/lib/i18n/types.ts`, replace the `learn` interface (lines ~298-305):

```ts
  // Footer link label for the generated static Guides hub page.
  learn: { hub: string };
```

- [ ] **Step 2: Update the failing i18n test**

In `web/src/lib/i18n.test.ts`, replace the `learn strings` describe block with:

```ts
describe("learn strings", () => {
  it("every language has a non-empty hub label", () => {
    for (const { code } of LANGS) {
      expect(messages[code].learn.hub.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npm test -- --run i18n`
Expected: FAIL — `learn.hub` is undefined (tables still have the 6-key object) and/or type error.

- [ ] **Step 4: Update every language table**

In each of `web/src/lib/i18n/{en,zh,ja,ko,de,fr}.ts`, replace the whole `learn: { … }` object with the single-key form, using the language's value from the reference table:

```ts
// en.ts
  learn: { hub: "Guides" },
// zh.ts
  learn: { hub: "使用指南" },
// ja.ts
  learn: { hub: "ガイド" },
// ko.ts
  learn: { hub: "가이드" },
// de.ts
  learn: { hub: "Anleitungen" },
// fr.ts
  learn: { hub: "Guides" },
```

- [ ] **Step 5: Replace the SPA footer block**

In `web/src/App.svelte`, replace the second footer nav (the 6 `<a>` links, lines ~1302-1309) with a single link:

```svelte
      <nav class="legal" aria-label="Guides">
        <a href={pageUrl("guides", lang())}>{t.learn.hub}</a>
      </nav>
```

- [ ] **Step 6: Run tests + typecheck**

Run: `cd web && npm test -- --run i18n`
Expected: PASS.

Run: `cd web && npx svelte-check --threshold error 2>&1 | tail -5`
Expected: no errors referencing `learn` or `App.svelte` footer. (If the project has no `svelte-check` script, `npm run build` must still succeed — run it in Step 7.)

- [ ] **Step 7: Full test + build gate**

Run: `cd web && npm test -- --run && npm run build`
Expected: all tests pass; build completes (build runs `gen:pages` first, so the hub pages + footers regenerate into `dist/`).

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/i18n web/src/App.svelte web/public web/dist
git commit -m "feat(web): replace scattered footer links with one Guides entry"
```

(If `web/dist` is git-ignored, omit it from the add — check `git status` first.)

---

## Final verification

- [ ] `cd web && npm test -- --run` — all suites green.
- [ ] `cd web && npm run gen:pages` — writes `public/guides/index.html` + `public/<lang>/guides/index.html` for all 5 non-en langs, and `sitemap.xml` lists all 6 hub URLs.
- [ ] Manual (from `web/`, `npm run dev`): open `/guides` and `/zh/guides` — H1 + intro render, all 11 articles appear under the right category headings, every link resolves, the language bar switches languages.
- [ ] Manual: the SPA homepage footer shows a single "Guides" link that lands on `/guides`; an article page footer and a landing page footer each show a "Guides" link that lands on the hub.

---

## Self-review notes

- **Spec coverage:** hub page (Task 2+3), grouping by prefix (Task 1), sitemap (Task 3), `GUIDES_LABELS` shared constant (Task 4), SPA footer replacement + i18n `learn`→`hub` + test update (Task 5), landing/article footers (Task 4), one-line intro (Task 2). All spec items mapped.
- **Type consistency:** `articleGroupsByLang` returns `{guides,howTo,compare}` keys used identically by `renderGuidesIndexPage` (`groups.guides/howTo/compare`) and `buildGuidesIndexPages`. `guides-index.mjs` `doc.categories.{guides,howTo,compare}` matches the renderer's `doc.categories.*` reads. `learn.hub` type (types.ts) matches all six tables and `t.learn.hub` in App.svelte.
- **No placeholders:** all localized strings are provided verbatim in the reference table and Task 2 content module.
