# Web UI Refresh + Legal Pages (Privacy & Terms) — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorming) → ready for implementation plan
**Scope:** Frontend only (`web/`). No server, protocol, auth, or metering changes.
**Milestone:** Mid-size visual refresh of the single-page transfer app, plus a
build-time-generated set of crawlable legal pages (Privacy Policy + Terms of
Service) in all 6 supported languages.

## Summary

Two deliverables, one frontend slice:

1. **UI refresh (medium):** keep the existing structure and all interactions
   (LAN discovery, send/receive, SAS, i18n, dark mode), but lift the visual
   quality to a "real product / landing page" feel — refined design tokens, a
   polished hero, a new trust/feature strip (which doubles as crawlable SEO/GEO
   content), a responsive device grid, nicer transfer cards, and a footer that
   links to the new legal pages.

2. **Legal pages:** Privacy Policy and Terms of Service as **independent,
   crawlable static HTML documents** (no Svelte mount), generated at build time
   from a structured content source, in all 6 languages, with correct
   `canonical` / `hreflang` / JSON-LD and entries in `sitemap.xml`.

Honest SEO framing (agreed during brainstorming): legal pages do **not** lift
keyword rankings directly. Their value is trust/E-E-A-T signals, compliance, and
on-brand GEO content (a privacy policy that truthfully says "we never touch your
files" reinforces the core story). The feature strip is the part that adds
genuinely citable, indexable prose.

## Red line (unchanged)

No change to data handling. The privacy policy only *describes* the existing
behavior; it must stay factually accurate to the code, which it is grounded in
(see "Privacy facts" below). The server still never touches file content, file
names, or keys.

## Part A — UI refresh

### A1. Cleanup & design tokens
- Remove unused Vite-template CSS from `web/src/app.css`: `.hero`, `#next-steps`,
  `#docs`, `#spacer`, `.ticks`, `#center`, `.counter` and related selectors that
  no longer correspond to any rendered markup. Keep `#app`, base typography, and
  the `:root` token block.
- Extend the token set: a more layered surface/elevation scale, refined spacing
  and radius steps, and a tightened type rhythm. Keep the existing purple brand
  accent and the full light/dark theming via `prefers-color-scheme`.

### A2. Layout (still a single page)
Top-to-bottom composition in `App.svelte`:
- **Hero** — logo, "Relayium", tagline, and the connection-status pill, with
  stronger visual treatment.
- **Feature strip (NEW)** — 3–4 trust cards: end-to-end encrypted · files never
  touch the server (P2P) · SAS man-in-the-middle check · cross-platform. This is
  product polish *and* indexable SEO/GEO content.
- **Device grid** — the peer list as a responsive card grid with a friendlier
  empty state.
- **Transfer cards** — refined progress bar / speed / done-state visuals and
  transitions.
- **Guide** — re-laid-out, lighter.
- **Footer** — add **Privacy** / **Terms** / **GitHub** links (Privacy & Terms
  resolve in the visitor's current UI language; see B3).

### A3. Componentization
- Extract `Hero.svelte` and `FeatureStrip.svelte` to keep `App.svelte` lean.
  Existing `Account.svelte` and `CrossNetwork.svelte` are unchanged in behavior
  (may receive matching style polish only).
- All new copy goes through `i18n.svelte.ts`, filled for all 6 languages
  (zh, en, ja, ko, de, fr). No new i18n machinery — same `messages[lang()]`
  pattern.

### A4. Constraints
- No new runtime dependencies; no router library; no SSR/framework migration.
- Preserve every existing behavior: hash transfer-token (`location.hash`),
  busy-state gating, accept/reject, save-target picker, title progress, language
  switch, unsupported-browser banner.
- Stay responsive; keep the `max-width: 1024px` breakpoint conventions.

## Part B — Legal pages

### B1. Content source
- New `web/src/legal/` directory holding structured content: per document
  (`privacy`, `terms`) × per language, as data (sections with headings +
  paragraphs/lists). Authored and translated for all 6 languages.

### B2. Generation
- A build-time generator (a small Node/TS script wired into the `build` step, or
  a tiny Vite plugin) renders each (document × language) pair to a standalone
  static HTML file using one shared template. **No Svelte mount** — these are
  plain documents, so crawlers read full prose with zero JS.
- The template reuses the site stylesheet, a simple shared header (logo links
  home) and footer, and emits per-page `<title>`, `meta description`,
  `canonical`, `hreflang` alternates, and `Article`/`WebPage` JSON-LD.

### B3. URL structure (decided)
- Language-prefix style. English is canonical at the unprefixed path; other
  languages are prefixed:
  - Privacy: `/privacy` (en, canonical + `x-default`), `/zh/privacy`,
    `/ja/privacy`, `/ko/privacy`, `/de/privacy`, `/fr/privacy`
  - Terms: `/terms` (en, canonical + `x-default`), `/zh/terms`, … (same set)
- Pretty URLs via per-path `index.html` in `dist/` (e.g.
  `dist/zh/privacy/index.html`).
- All 6 variants of each document cross-link via `hreflang`; every page is added
  to `web/public/sitemap.xml`; `robots.txt` allows them.
- Footer links from the app point to the file matching the current UI language.

### B4. Document content (drafted here, engineer-honest, NOT lawyer-reviewed)
Each page shows a normal **"Last updated: 2026-06-29"** line and uses confident,
final-sounding prose — **no "draft" wording is visible to visitors** (a published
"draft" stamp would look unprofessional and weaken the trust/SEO value). The
"engineer-drafted, not lawyer-reviewed, review before relying on it" caveat lives
**only in this spec and in code comments**, for the maintainer — never on the page.

**Privacy Policy** — grounded in the verified facts below:
- LAN transfers collect nothing server-side; files stream peer-to-peer.
- Optional account (only gates cross-network features) stores: email, display
  name, user id; external identity (Google `sub` or email); an httpOnly session
  cookie; magic-link tokens stored **only as a hash**; a registered device
  (random id + `navigator.platform` name).
- **Never collected/stored:** file contents, file names, or encryption keys.
- TURN relay (cross-network only): the relay meters **relayed byte counts only**
  (`RelayedBytes`); content is never inspected (still E2E encrypted).
- Client storage: `localStorage` key `relayium_device_id` (a random UUID).
- Third parties: Google OAuth (sign-in), transactional email (magic links).
- Retention / deletion / contact (`support@relayium.com`); GDPR basics.

**Terms of Service:**
- Free, open-source (MIT), provided "as is"; acceptable use; no warranty;
  limitation of liability; account terms; changes-to-terms clause.
- **No governing-law / jurisdiction clause** (intentionally omitted this round).
- Contact: `support@relayium.com`.

### Privacy facts (verified against the code, 2026-06-29)
- `server/internal/account/store.go`: `User` = ID, Email, DisplayName, CreatedAt
  ("PII is limited to email + display name"); `MagicToken` stores `TokenHash`
  only; `Device` = id + name + timestamps; `Transfer` = token + userId, "never
  holds file content or keys"; `UsageEvent` = relayed bytes, "the server never
  inspects relayed content".
- `web/src/lib/auth.svelte.ts`: magic-link + Google OAuth; session via
  `credentials: include` cookie; `relayium_device_id` in localStorage.
- `web/src/lib/ice.ts`: TURN only for token-rooms; LAN is STUN-only.

## Out of scope (YAGNI)
- No frontend router library, no SSR migration, no PWA/offline changes beyond
  existing manifest.
- No account-system, signaling, protocol, or metering changes.
- No new legal clauses beyond Privacy + Terms (e.g. no separate cookie banner /
  consent manager this round).
- Governing-law / jurisdiction text.

## Testing & verification
- `npm run check` (svelte-check + tsc) passes; existing vitest suite still green.
- `npm run build` succeeds and emits all 12 legal HTML files at the expected
  paths; spot-check that each contains its prose with JS disabled.
- `sitemap.xml` includes all new URLs; each page's `hreflang` set resolves.
- Manual visual pass in light + dark, desktop + mobile widths; language switch
  still updates all copy including the new feature strip.

## Open items for the user (post-implementation)
- Review the legal copy (engineer-drafted, not lawyer-reviewed) before relying
  on it in production. No public "draft" note exists to remove; just update the
  "Last updated" date if you revise the text.
- Governing law / jurisdiction can be added later if desired.
