# Guides hub page + footer entry — design

**Date:** 2026-07-09
**Status:** Approved (pending spec review)

## Problem

The website has 11 SEO articles — generated as self-contained static HTML at build
time (`web/scripts/gen-pages.mjs` + `web/scripts/pages/`), separate from the Svelte
SPA — but there is **no front door** to them:

- The article set has no name; internally it is just `articles`.
- No index/hub page exists. There is no `/guides`, `/blog`, or `/articles` aggregate.
- The SPA footer (`web/src/App.svelte:1302-1309`) lists 6 individual article links
  (compare×3 + how-to×3) and **omits the 5 CLI guides entirely**.
- Non-English landing pages have a flat "learn" list; the `/cli` page lists the CLI
  guides separately.

Result: an English SPA visitor can reach articles only by clicking scattered footer
links or via cross-links inside an article. There is no single, labeled entry into
the content section.

## Goal

Give the content section a name — **Guides** — and a single front door:

1. A generated static **hub page** at `/guides` (and `/<lang>/guides`) that lists all
   11 articles grouped by category.
2. A single **"Guides" footer link** — in the SPA footer, the static landing footer,
   and the static article footer — pointing to that hub.

Non-goals (explicitly out of scope):
- No top-nav tab (user chose footer-only).
- No new article content; no changes to existing article bodies or slugs.
- No SPA route for the hub — it stays a static, crawlable page like landing/article
  pages.

## The 11 articles and their categories

Category is derived from the existing slug prefix — no per-article metadata added.

| Category | Slug prefix | Count | Articles |
|---|---|---|---|
| Guides | `guides/` | 5 | transfer-files-from-terminal, send-a-file-to-someone, back-up-a-server-over-ssh, server-to-server-transfers, sync-a-large-folder-between-servers |
| How-to | `how-to/` | 3 | transfer-files-android-to-iphone, send-files-pc-to-phone-wirelessly, send-large-files-without-cloud |
| Compare | `compare/` | 3 | snapdrop, airdrop, wetransfer |

All 11 already have localized `langs.{en,zh,ja,ko,de,fr}` titles.

## Design

### 1. Hub page (static, generated)

**URL:** `/guides` (en) and `/<lang>/guides` (zh, ja, ko, de, fr), following the
existing `pagePath`/`urlPath` scheme in `web/scripts/pages/shared.mjs`.

**New template:** `web/scripts/pages/guides-index-template.mjs`, exporting
`renderGuidesIndexPage({ lang, doc, groups })`. It reuses the article-template
conventions verbatim: inlined `STYLE`, self-contained HTML, logo header linking to
the app, a language bar (`langBar`), `hreflang` alternates, canonical + OG/Twitter
meta, and a footer matching the article footer. Content is:

- `<h1>` = `doc.heading` ("Guides")
- one-line intro `<p class="lead">` = `doc.intro`
- for each of the 3 groups (in fixed order Guides → How-to → Compare): an `<h2>`
  with the localized category label, then a `<ul>` of article links
  (`urlPath(slug, lang)` → localized title). A group with no articles is skipped.

**Structured data:** emit a `CollectionPage` JSON-LD whose `mainEntity` is an
`ItemList` of the 11 articles (position + url + name), mirroring how article/landing
templates emit JSON-LD. Keep it minimal.

**Shared footer label:** add a `GUIDES_LABELS` per-language constant to
`web/scripts/pages/shared.mjs` (same pattern as `PRIVACY_LABELS` in
article-template.mjs). Both the landing and article footers import it so the "Guides"
label stays in one place; the hub page uses its own `doc.heading`.

**New content module:** `web/scripts/pages/content/guides-index.mjs`, default-exporting
`{ slug: "guides", updated: "2026-07-09", langs: { en, zh, ja, ko, de, fr } }` where
each language provides: `title` (`<title>` tag), `description` (meta), `heading`
(H1), `intro` (one line), `updatedLabel`, `relatedHeading` (reused footer label if
needed), and `categories: { guides, howTo, compare }` labels. Validated by the
existing `validateLangs`.

### 2. Build wiring (pure builders + generator)

**`web/scripts/pages/build-pages.mjs`:**
- Add `articleGroupsByLang(articles)` → `{ [lang]: { guides:[…], howTo:[…], compare:[…] } }`,
  grouping by `slug.split("/")[0]` and preserving `gen-pages.mjs` array order within
  each group. Each entry is `{ slug, title }` (same shape as `articleLinksByLang`).
- Add `buildGuidesIndexPages(guidesIndex, groupsByLang)` → one page per `LANGS`,
  calling `renderGuidesIndexPage`.
- Extend `buildSitemap` to accept the hub and emit its 6 URLs (priority `0.5`,
  changefreq `monthly`).

**`web/scripts/gen-pages.mjs`:**
- Import the guides-index content module.
- Add `...buildGuidesIndexPages(guidesIndex, articleGroupsByLang(articles))` to `pages`.
- Pass the hub to `buildSitemap`.

### 3. Footer entry (the "door")

A single **"Guides"** link, localized, pointing to `pageUrl("guides", lang)`
(`urlPath("guides", lang)` in the static templates).

**SPA footer — `web/src/App.svelte`:** Replace the entire second
`<nav class="legal" aria-label="Guides">` block (the 6 scattered article links,
lines ~1302-1309) with a **single** `<a href={pageUrl("guides", lang())}>` link
labeled "Guides". This is the user-approved choice: one clean door instead of 6
partial links, and the hub now covers all 11 (including the previously-absent CLI
guides).

**i18n changes:**
- The current `learn` object (6 per-article labels) becomes unused by the SPA. Replace
  it with a single label used for the footer link. Concretely: change `learn` in all
  6 files (`web/src/lib/i18n/{en,zh,ja,ko,de,fr}.ts`) from the 6-key object to
  `learn: { hub: "Guides" }` (localized), and update `web/src/lib/i18n/types.ts`
  accordingly.
- Update the `learn strings` test in `web/src/lib/i18n.test.ts` (currently asserts
  exactly 6 keys, all non-empty) to assert the single `hub` key is present and
  non-empty across all languages.

**Static landing footer — `web/scripts/pages/landing-template.mjs`:** add a "Guides"
link to the `<footer>` (alongside Privacy/Terms/Security/GitHub), using
`urlPath("guides", lang)`. The existing in-body "learn" list stays as is.

**Static article footer — `web/scripts/pages/article-template.mjs`:** add a "Guides"
link to the `<footer>` (alongside ← Relayium / Privacy / GitHub), using
`urlPath("guides", lang)`. Label from the shared `GUIDES_LABELS` constant.

## Data flow

```
articles[] (gen-pages.mjs)
   ├─ articleGroupsByLang(articles) ──► groupsByLang
   │                                       │
guides-index.mjs (localized chrome) ───────┤
   │                                       ▼
   └────────────────► buildGuidesIndexPages() ──► /<lang?>/guides/index.html
                                                   (renderGuidesIndexPage)
   articles + hub ──► buildSitemap() ──► sitemap.xml (adds 6 hub URLs)

footers (SPA + landing + article) ──► single "Guides" link ──► /<lang?>/guides
```

## Testing

- **Unit:** extend `web/scripts/pages/build-pages.test.mjs` (or add one) to cover
  `articleGroupsByLang` (correct grouping by prefix, order preserved, all 6 langs)
  and `buildGuidesIndexPages` (one page per language, correct paths, contains all 11
  article links + the 3 category headings).
- **i18n:** update `web/src/lib/i18n.test.ts` `learn` test to the new single-key shape;
  `pageUrl("guides", …)` already covered by existing pageUrl behavior.
- **Build smoke:** `npm run gen:pages` succeeds and writes
  `public/guides/index.html` + `public/<lang>/guides/index.html`; `sitemap.xml`
  contains the hub URLs.
- **Manual/verify:** load `/guides` and `/zh/guides`, confirm all 11 links resolve,
  language bar switches, and the footer "Guides" link on the SPA + a landing page +
  an article page lands on the hub.

## Files touched

New:
- `web/scripts/pages/guides-index-template.mjs`
- `web/scripts/pages/content/guides-index.mjs`

Modified:
- `web/scripts/pages/build-pages.mjs` (+ sitemap)
- `web/scripts/gen-pages.mjs`
- `web/src/App.svelte` (footer)
- `web/src/lib/i18n/{en,zh,ja,ko,de,fr}.ts` (`learn` → single `hub` key)
- `web/src/lib/i18n/types.ts`
- `web/src/lib/i18n.test.ts`
- `web/scripts/pages/landing-template.mjs` (footer link)
- `web/scripts/pages/article-template.mjs` (footer link)
- `web/scripts/pages/build-pages.test.mjs` (if present; else add)

## Open decisions — resolved

- **Name:** Guides. URL `/guides`. (user)
- **Entry placement:** footer only, no top-nav tab. (user)
- **SPA footer:** replace the 6 scattered links with a single "Guides" link. (user)
- **Hub intro line:** include a one-line intro under the H1. (default)
