# C-γ — SEO Mode Landing Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `/cross-network` and `/offline-transfer` crawlable SEO — localized static landing pages (zh/ja/ko/de/fr) with hreflang/canonical/JSON-LD + sitemap entries, plus per-route `<title>`/meta on the English SPA routes.

**Architecture:** Mirror the existing home-landing SSG model: English stays the SPA route (no static file), the 5 non-English langs get static landing pages at `/<lang>/<slug>`. A new `renderModePage`/`buildModePages` (modeled on `article-template.mjs`/`landing-template.mjs`) emits landing-style content at slug URLs; the hreflang cluster (`alternates(slug)`) already includes the English SPA route as `en`/`x-default`. The SPA gets a pure `pageMeta(route, m)` helper driving per-route `<title>` + `<meta description>`.

**Tech Stack:** Node ESM SSG scripts (`web/scripts/pages/*.mjs`) + Vitest; Svelte 5 SPA (`web/src`).

## Global Constraints

- Frontend `web/`. Run: `cd web && npx vitest run <spec>`, `npm run check`, `npm run build` (build runs `gen:pages`). SSG tests live beside the scripts (`.test.mjs`, run by Vitest).
- Method 1: English = the SPA route (NO static file at `/cross-network` or `/offline-transfer` — a static file would shadow the interactive SPA route). Static pages only for `LANDING_LANGS = ["zh","ja","ko","de","fr"]`.
- Slugs MUST equal the router paths: `cross-network` → router `CROSS_PATH` (`= "/cross-network"`), `offline-transfer` → `OFFLINE_PATH` (`= "/offline-transfer"`). A test asserts `"/" + slug === CROSS_PATH`/`OFFLINE_PATH`.
- Sitemap: each mode contributes the 5 localized URLs (`/<lang>/<slug>`) AND the English SPA URL (`/<slug>`), priority `0.8`, changefreq `weekly`, `lastmod` = the mode module's `updated`.
- New UI strings across all 6 locales + `types.ts` (else `npm run check` fails). Existing SSG helpers: `LANGS`, `LANDING_LANGS`, `DEFAULT_LANG`, `BCP47`, `OG_LOCALE`, `SITE`, `urlPath(slug,lang)`, `pagePath(slug,lang)`, `absUrl`, `esc`, `ctaHref(lang)` (all in `scripts/pages/shared.mjs`).
- Content facts must be ACCURATE (from the spec); do not overstate. Mode copy mirrors `content/landing.mjs`'s structure + `src/lib/i18n/*` terminology.

---

## File Structure

**New files:**
- `web/scripts/pages/mode-template.mjs` (+ `mode-template.test.mjs`) — `renderModePage` + the mode hreflang/canonical/JSON-LD/body.
- `web/scripts/pages/content/cross-network.mjs`, `web/scripts/pages/content/offline-transfer.mjs` — localized copy (5 langs).
- `web/src/lib/page-meta.ts` (+ `page-meta.test.ts`) — pure `pageMeta(route, m)`.

**Modified files:**
- `web/scripts/pages/build-pages.mjs` — `buildModePages` + `buildSitemap` mode support.
- `web/scripts/gen-pages.mjs` — import the two mode modules, add to `pages` + the `buildSitemap` call.
- `web/src/App.svelte` — drive `document.title` + `<meta name=description>` from `pageMeta`.
- `web/src/lib/i18n/types.ts` + 6 locales — `titleCross`/`titleOffline`/`descCross`/`descOffline`.

---

## Task 1: mode-landing builder + template + sitemap support (mechanism)

**Files:**
- Create: `web/scripts/pages/mode-template.mjs`
- Modify: `web/scripts/pages/build-pages.mjs`
- Test: `web/scripts/pages/mode-template.test.mjs`

**Interfaces:**
- Consumes: `shared.mjs` helpers (`LANGS`, `LANDING_LANGS`, `DEFAULT_LANG`, `BCP47`, `OG_LOCALE`, `SITE`, `urlPath`, `pagePath`, `absUrl`, `esc`, `ctaHref`).
- Produces:
  - `renderModePage({ slug, lang, doc, updated }) : string` (full HTML; canonical=`absUrl(urlPath(slug,lang))`; hreflang cluster over all `LANGS` + `x-default`=en; a `WebPage` (+ `FAQPage` if `doc.faq`) JSON-LD; landing-style body; CTA → `/${slug}?lang=${lang}`).
  - `buildModePages(modeDef, { slug }) : { path, html }[]` (one page per `LANDING_LANGS`, path `pagePath(slug, lang)`; en is skipped).
  - `buildSitemap(...)` gains a `modes` option (below).

- [ ] **Step 1: Write the failing test**

`web/scripts/pages/mode-template.test.mjs` (mirror `article-template.test.mjs`, using a tiny inline fixture so this task needs no real content):
```js
import { describe, it, expect } from "vitest";
import { buildModePages } from "./build-pages.mjs";

const fixture = {
  updated: "2026-07-10",
  langs: Object.fromEntries(["zh", "ja", "ko", "de", "fr"].map((l) => [l, {
    title: `T-${l}`, description: `D-${l}`,
    hero: { h1: `H-${l}`, pitch: `P-${l}`, cta: `C-${l}` },
    how: { heading: `how-${l}`, steps: [`s1-${l}`] },
    why: { heading: `why-${l}`, items: [{ title: `wt-${l}`, desc: `wd-${l}` }] },
    compare: { heading: `cmp-${l}`, items: [{ title: `ct-${l}`, body: `cb-${l}` }] },
    faq: { heading: `faq-${l}`, items: [{ q: `q-${l}`, a: `a-${l}` }] },
    learnHeading: `learn-${l}`,
    footer: { privacy: "P", terms: "T", security: "S" },
  }])),
};

describe("buildModePages", () => {
  const pages = buildModePages(fixture, { slug: "cross-network" });

  it("emits 5 localized pages, NO english static page", () => {
    const paths = pages.map((p) => p.path).sort();
    expect(paths).toEqual([
      "de/cross-network/index.html", "fr/cross-network/index.html",
      "ja/cross-network/index.html", "ko/cross-network/index.html",
      "zh/cross-network/index.html",
    ]);
    expect(paths).not.toContain("cross-network/index.html"); // english is the SPA route
  });

  it("zh page: self-canonical + hreflang cluster incl english SPA route + x-default + JSON-LD", () => {
    const zh = pages.find((p) => p.path === "zh/cross-network/index.html").html;
    expect(zh).toContain('<link rel="canonical" href="https://relayium.com/zh/cross-network" />');
    expect(zh).toContain('hreflang="en" href="https://relayium.com/cross-network"');       // SPA route
    expect(zh).toContain('hreflang="x-default" href="https://relayium.com/cross-network"');
    expect(zh).toContain('hreflang="ja" href="https://relayium.com/ja/cross-network"');
    expect(zh).toContain('"@type":"FAQPage"');
    expect(zh).toContain('<html lang="zh"');
  });

  it("CTA links to the SPA mode route with language preset", () => {
    const de = pages.find((p) => p.path === "de/cross-network/index.html").html;
    expect(de).toContain('href="/cross-network?lang=de"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run scripts/pages/mode-template.test.mjs`
Expected: FAIL — `buildModePages` undefined.

- [ ] **Step 3: Implement `mode-template.mjs`**

`web/scripts/pages/mode-template.mjs` — build the head + landing-style body. (Reuse the head structure from `article-template.mjs` — canonical, `alternates`, OG, JSON-LD — and the body structure from `landing-template.mjs` — hero/how/why/compare/faq. Read both first and match their conventions.)
```js
// web/scripts/pages/mode-template.mjs — renders one localized static SEO landing
// page for a product mode (/cross-network, /offline-transfer). English stays the
// SPA route, so pages exist only for LANDING_LANGS; the hreflang cluster still
// points en/x-default at the English SPA route.
import { LANGS, DEFAULT_LANG, BCP47, OG_LOCALE, SITE, urlPath, absUrl, esc, ctaHref } from "./shared.mjs";

function alternates(slug) {
  const links = LANGS.map(
    (l) => `<link rel="alternate" hreflang="${BCP47[l]}" href="${absUrl(urlPath(slug, l))}" />`
  );
  links.push(`<link rel="alternate" hreflang="x-default" href="${absUrl(urlPath(slug, DEFAULT_LANG))}" />`);
  return links.join("\n    ");
}

function jsonLd(slug, lang, doc) {
  const graph = [{
    "@type": "WebPage",
    name: doc.title,
    description: doc.description,
    url: absUrl(urlPath(slug, lang)),
    inLanguage: BCP47[lang],
    publisher: { "@type": "Organization", name: SITE.name, url: SITE.origin + "/" },
  }];
  if (doc.faq?.items?.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: doc.faq.items.map((f) => ({
        "@type": "Question", name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    });
  }
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph });
}

function body(slug, lang, doc) {
  const li = (xs) => xs.map((x) => `<li>${esc(x)}</li>`).join("");
  return `
    <main>
      <h1>${esc(doc.hero.h1)}</h1>
      <p class="pitch">${esc(doc.hero.pitch)}</p>
      <a class="cta" href="/${slug}?lang=${lang}">${esc(doc.hero.cta)}</a>

      <h2>${esc(doc.how.heading)}</h2>
      <ol>${li(doc.how.steps)}</ol>

      <h2>${esc(doc.why.heading)}</h2>
      <ul class="why">${doc.why.items.map((i) => `<li><strong>${esc(i.title)}</strong> ${esc(i.desc)}</li>`).join("")}</ul>

      <h2>${esc(doc.compare.heading)}</h2>
      <ul class="compare">${doc.compare.items.map((i) => `<li><strong>${esc(i.title)}</strong> ${esc(i.body)}</li>`).join("")}</ul>

      <h2>${esc(doc.faq.heading)}</h2>
      <dl>${doc.faq.items.map((f) => `<dt>${esc(f.q)}</dt><dd>${esc(f.a)}</dd>`).join("")}</dl>
    </main>`;
}

export function renderModePage({ slug, lang, doc }) {
  const canonical = absUrl(urlPath(slug, lang));
  return `<!doctype html>
<html lang="${lang}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(doc.title)}</title>
    <meta name="description" content="${esc(doc.description)}" />
    <link rel="canonical" href="${canonical}" />
    ${alternates(slug)}
    <meta property="og:title" content="${esc(doc.title)}" />
    <meta property="og:description" content="${esc(doc.description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${canonical}" />
    <meta property="og:locale" content="${OG_LOCALE[lang]}" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <script type="application/ld+json">${jsonLd(slug, lang, doc)}</script>
  </head>
  <body>
    <header><span class="logo">⇌</span><a href="${ctaHref(lang)}">Relayium</a></header>
    ${body(slug, lang, doc)}
    <footer>
      <a href="${urlPath("privacy", lang)}">${esc(doc.footer.privacy)}</a>
      <a href="${urlPath("terms", lang)}">${esc(doc.footer.terms)}</a>
      <a href="${urlPath("security", lang)}">${esc(doc.footer.security)}</a>
    </footer>
  </body>
</html>`;
}
```
**Styling — required, not optional:** the code above is the SEO-critical skeleton; do NOT ship unstyled pages. Read `landing-template.mjs` and copy its inline `<style>` block + page-shell wrappers (header/main/footer classes, `.cta`, `.langbar` if present) into `renderModePage` so the mode pages are visually consistent with the localized home landing pages. If `landing-template.mjs`/`article-template.mjs` expose a shared head/shell helper, reuse it. The load-bearing bits the TEST checks are `<html lang>`, `<title>`, canonical, the `alternates` cluster, the JSON-LD, and the `/${slug}?lang=${lang}` CTA — but the shipped page must also carry the shared styling + shell.

- [ ] **Step 4: Add `buildModePages` + `buildSitemap` mode support (`build-pages.mjs`)**

Add:
```js
import { renderModePage } from "./mode-template.mjs";
// ...
export function buildModePages(modeDef, { slug }) {
  validateLangs(`mode:${slug}`, modeDef.langs, LANDING_LANGS);
  return LANDING_LANGS.map((lang) => ({
    path: pagePath(slug, lang),
    html: renderModePage({ slug, lang, doc: modeDef.langs[lang] }),
  }));
}
```
Extend `buildSitemap`'s options with `modes = []` (an array of `{ def, slug }`), and inside it emit, per mode, the English SPA URL + the 5 localized URLs:
```js
  for (const { def, slug } of modes) {
    urls.push({ loc: absUrl(urlPath(slug, DEFAULT_LANG)), lastmod: def.updated, priority: "0.8", changefreq: "weekly" }); // english SPA route
    for (const lang of LANDING_LANGS) {
      urls.push({ loc: absUrl(urlPath(slug, lang)), lastmod: def.updated, priority: "0.8", changefreq: "weekly" });
    }
  }
```
(Also add `modes` to the `newest` lastmod computation if you want them to influence the homepage lastmod — optional; not required.) Ensure `pagePath`, `LANDING_LANGS`, `validateLangs`, `renderModePage`, `DEFAULT_LANG`, `urlPath`, `absUrl` are imported in `build-pages.mjs`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run scripts/pages/mode-template.test.mjs`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/scripts/pages/mode-template.mjs web/scripts/pages/mode-template.test.mjs web/scripts/pages/build-pages.mjs
git commit -m "feat(seo): mode-landing page builder + sitemap support (mechanism)"
```

---

## Task 2: cross-network localized copy + wiring

**Files:**
- Create: `web/scripts/pages/content/cross-network.mjs`
- Modify: `web/scripts/pages/gen-pages.mjs`
- Test: `web/scripts/pages/mode-content.test.mjs` (a light content-shape assertion)

**Interfaces:**
- Consumes: `buildModePages`/`buildSitemap` (Task 1).
- Produces: `cross-network.mjs` default export `{ updated: "2026-07-10", langs: { zh, ja, ko, de, fr } }` with the landing-style structure (`title, description, hero{h1,pitch,cta}, how{heading,steps[]}, why{heading,items[{title,desc}]}, compare{heading,items[{title,body}]}, faq{heading,items[{q,a}]}, learnHeading, footer{privacy,terms,security}`).

- [ ] **Step 1: Write the failing test**

`web/scripts/pages/mode-content.test.mjs`:
```js
import { describe, it, expect } from "vitest";
import crossNetwork from "./content/cross-network.mjs";
import { LANDING_LANGS } from "./shared.mjs";
import { CROSS_PATH } from "../../src/lib/transfer-link";

describe("cross-network content", () => {
  it("defines all 5 non-english locales with the full structure", () => {
    expect(Object.keys(crossNetwork.langs).sort()).toEqual([...LANDING_LANGS].sort());
    for (const l of LANDING_LANGS) {
      const d = crossNetwork.langs[l];
      expect(d.title).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.hero?.h1 && d.hero?.pitch && d.hero?.cta).toBeTruthy();
      expect(d.how?.steps?.length).toBeGreaterThan(0);
      expect(d.faq?.items?.length).toBeGreaterThan(0);
    }
  });
  it("slug matches the router path", () => {
    expect("/cross-network").toBe(CROSS_PATH);
  });
});
```
(If importing the `.ts` router constant into an `.mjs` Vitest test fails in this toolchain, assert against the literal `"/cross-network"` and add the router-equality check in Task 4's `.ts` test instead.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run scripts/pages/mode-content.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `cross-network.mjs` (5 locales)**

Create `web/scripts/pages/content/cross-network.mjs` mirroring `content/landing.mjs` (read it first for tone, terminology, and the exact field shapes). Write all 5 locales (zh/ja/ko/de/fr) from this **English master** (source-of-truth; keep it in a leading comment; do NOT emit an `en` key — English is the SPA):

- **title:** "Cross-network file transfer — realtime, end-to-end encrypted, peer-to-peer (Relayium)"
- **description:** "Send files device-to-device across different networks with a 6-digit pairing code. Realtime peer-to-peer, end-to-end encrypted; a TURN relay is used only when a direct path is impossible, and it relays ciphertext only."
- **hero.h1:** "Cross-network transfer, still peer-to-peer" · **hero.pitch:** "Two devices on different networks pair with a 6-digit code (or its link/QR). Files stream directly over an encrypted WebRTC channel; only when a direct path is impossible does an encrypted TURN relay carry the ciphertext." · **hero.cta:** "Start a transfer"
- **how.steps:** ["The sender signs in and mints a 6-digit pairing code (or shares its join link / QR).", "The receiver opens the link or enters the code — no account needed to receive.", "Both sides verify the same 6-digit SAS on screen to rule out a man-in-the-middle.", "Files stream peer-to-peer, AES-256-GCM per chunk; a TURN relay carries only ciphertext if no direct path exists."]
- **why.items** (title/desc): ["End-to-end encrypted" / "X25519 key exchange + per-chunk AES-256-GCM; keys are negotiated only between the two devices, so the server can't decrypt."], ["SAS anti-MITM" / "Both screens show the same 6-digit code; matching it defeats even a compromised signaling server."], ["Direct when possible" / "Files flow device-to-device over WebRTC; the relay is a ciphertext-only fallback for symmetric-NAT cases."], ["Cross-platform" / "Windows, macOS, Linux, Android, iOS — any modern browser, nothing to install."], ["Free" / "Realtime transfer is free; minting a code needs the sender logged in (for attribution), the receiver joins anonymously."]
- **compare.items** (title/body): ["vs AirDrop" / "AirDrop is Apple-only; Relayium pairs Windows, Android, iPhone and Mac across different networks with just a browser."], ["vs Snapdrop/PairDrop" / "Those are same-network only; Relayium adds cross-network pairing plus app-layer E2E + SAS so a malicious signaling server can't eavesdrop."]
- **faq.items** (q/a): ["Do my files go through your server?" / "In realtime mode, no — files stream peer-to-peer. Only when a direct path is impossible does an encrypted TURN relay carry ciphertext it can't read."], ["Is a code required?" / "Yes: a 6-digit code (or its join link/QR), valid 15 minutes, pairs the two devices across networks."], ["Do I need an account?" / "The sender signs in to mint a code; the receiver joins anonymously."], ["Is it end-to-end encrypted?" / "Yes — X25519 + per-chunk AES-256-GCM, verified with the SAS code."]
- **learnHeading:** "Learn more" · **footer:** {privacy, terms, security} — reuse the labels from `landing.mjs`'s per-locale footer.

Translate faithfully into zh/ja/ko/de/fr, matching `src/lib/i18n/*` terminology (SAS, 端到端加密, etc.).

- [ ] **Step 4: Wire into gen-pages**

In `web/scripts/gen-pages.mjs`: `import crossNetwork from "./pages/content/cross-network.mjs";` add `...buildModePages(crossNetwork, { slug: "cross-network" })` to the `pages` array (import `buildModePages` from `build-pages.mjs`), and pass `modes: [{ def: crossNetwork, slug: "cross-network" }]` in the `buildSitemap(...)` call.

- [ ] **Step 5: Run tests + build**

Run: `cd web && npx vitest run scripts/pages/mode-content.test.mjs && npm run build`
Expected: PASS; build writes `public/{zh,ja,ko,de,fr}/cross-network/index.html` and a sitemap containing `/cross-network` + the 5 localized URLs (grep `public/sitemap.xml`).

- [ ] **Step 6: Commit**

```bash
git add web/scripts/pages/content/cross-network.mjs web/scripts/pages/gen-pages.mjs web/scripts/pages/mode-content.test.mjs
git commit -m "feat(seo): localized cross-network landing pages + sitemap"
```

---

## Task 3: offline-transfer localized copy + wiring

**Files:**
- Create: `web/scripts/pages/content/offline-transfer.mjs`
- Modify: `web/scripts/pages/gen-pages.mjs`
- Test: extend `web/scripts/pages/mode-content.test.mjs`

**Interfaces:**
- Consumes: `buildModePages`/`buildSitemap` (Task 1); same content shape as Task 2.

- [ ] **Step 1: Write the failing test**

Extend `mode-content.test.mjs` with an `offline-transfer` block mirroring the cross-network one (all 5 locales present + full structure; `"/offline-transfer"` slug). Import `offlineTransfer from "./content/offline-transfer.mjs"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run scripts/pages/mode-content.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `offline-transfer.mjs` (5 locales)**

Create `web/scripts/pages/content/offline-transfer.mjs`, same structure, from this **English master** (async zero-knowledge download-link mode):

- **title:** "Encrypted file link — upload now, download later, zero-knowledge (Relayium)"
- **description:** "Upload a file encrypted in your browser and share a download link. The server stores only ciphertext it can't decrypt — the key lives in the link. Optional burn-after-read and expiry."
- **hero.h1:** "Send a file as an encrypted link" · **hero.pitch:** "When the other side isn't online, upload now and share a link. Your browser encrypts before upload; the server keeps only ciphertext it can't read — the key never leaves the link." · **hero.cta:** "Upload a file"
- **how.steps:** ["Sign in and pick a file — your browser encrypts it locally before anything leaves the device.", "The server stores only the ciphertext; the decryption key stays in the link fragment and is never sent to the server.", "Share the download link (optionally burn-after-read, with an expiry you choose).", "The recipient opens the link; their browser fetches the ciphertext and decrypts it with the key from the link."]
- **why.items:** ["Zero-knowledge" / "The file is encrypted in the browser; the server only ever holds ciphertext it cannot decrypt."], ["Key in the link" / "The decryption key lives in the URL fragment (after #), which browsers never send to the server."], ["Burn-after-read + expiry" / "Optionally delete the file on first download, and set a time-to-live after which it's gone."], ["No recipient account" / "Anyone with the link can download; only the uploader needs to sign in."], ["Async complement" / "Use this when the other side isn't online right now; use realtime cross-network transfer when both are present."]
- **compare.items:** ["vs WeTransfer/Dropbox links" / "Those can read your files server-side; Relayium's server only holds ciphertext it can't decrypt — the key stays in the link."], ["vs realtime mode" / "Realtime is peer-to-peer and needs both sides online; this stores encrypted so the recipient can fetch later."]
- **faq.items:** ["Can the server read my file?" / "No — it's encrypted in your browser; the server stores only ciphertext and the key never reaches it."], ["Where is the key?" / "In the link's fragment (after #). Browsers don't send fragments to servers, so only someone with the full link can decrypt."], ["Do I need an account?" / "To upload, yes (it uses storage). To download, no — just the link."], ["Can I make it one-time?" / "Yes — enable burn-after-read, and set an expiry."]
- **learnHeading / footer:** as in Task 2.

Translate into zh/ja/ko/de/fr, matching `src/lib/i18n/*` terminology.

- [ ] **Step 4: Wire into gen-pages**

In `gen-pages.mjs`: `import offlineTransfer from "./pages/content/offline-transfer.mjs";`, add `...buildModePages(offlineTransfer, { slug: "offline-transfer" })` to `pages`, and add `{ def: offlineTransfer, slug: "offline-transfer" }` to the `modes` array in the `buildSitemap(...)` call.

- [ ] **Step 5: Run tests + build**

Run: `cd web && npx vitest run scripts/pages/mode-content.test.mjs && npm run build`
Expected: PASS; build writes the 5 `offline-transfer` pages; sitemap contains `/offline-transfer` + 5 localized URLs.

- [ ] **Step 6: Commit**

```bash
git add web/scripts/pages/content/offline-transfer.mjs web/scripts/pages/gen-pages.mjs web/scripts/pages/mode-content.test.mjs
git commit -m "feat(seo): localized offline-transfer landing pages + sitemap"
```

---

## Task 4: SPA per-route title + meta description

**Files:**
- Create: `web/src/lib/page-meta.ts` (+ `page-meta.test.ts`)
- Modify: `web/src/App.svelte` (title effect), `web/src/lib/i18n/types.ts` + 6 locales

**Interfaces:**
- Consumes: the `Route` type + `CROSS_PATH`/`OFFLINE_PATH` (`web/src/lib/router.svelte.ts`); `Messages`.
- Produces: `pageMeta(route: Route, m: Messages): { title: string; description: string }`.

- [ ] **Step 1: Write the failing test**

`web/src/lib/page-meta.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { pageMeta } from "./page-meta";
import { CROSS_PATH, OFFLINE_PATH } from "./router.svelte";
import { messages } from "./i18n.svelte";

const m = messages.en;

describe("pageMeta", () => {
  it("distinct per-route title + description for cross/offline/lan", () => {
    const c = pageMeta("cross", m), o = pageMeta("offline", m), lan = pageMeta("lan", m);
    expect(c.title).toBe(m.titleCross);
    expect(o.title).toBe(m.titleOffline);
    expect(c.title).not.toBe(o.title);
    expect(lan.title).toBe(m.titleDefault);
    expect(c.description).toBe(m.descCross);
    expect(o.description).toBe(m.descOffline);
  });
});

describe("SSG slugs match router paths", () => {
  it("cross-network / offline-transfer equal the router constants", () => {
    expect("/cross-network").toBe(CROSS_PATH);
    expect("/offline-transfer").toBe(OFFLINE_PATH);
  });
});
```
(If `CROSS_PATH`/`OFFLINE_PATH` are re-exported from `router.svelte.ts` — they are — import from there; `messages` from `i18n.svelte`. Match the existing `router.test.ts` import style.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/page-meta.test.ts`
Expected: FAIL — `page-meta` / `titleCross` undefined.

- [ ] **Step 3: Add i18n keys (6 locales) + implement `page-meta.ts`**

Add flat keys to `types.ts`: `titleCross: string; titleOffline: string; descCross: string; descOffline: string;` and to all 6 locales (concise, accurate, matching each mode; e.g. en `titleCross: "Cross-network file transfer — realtime, E2E-encrypted P2P | Relayium"`, `descCross: "Send files across networks with a 6-digit code — realtime peer-to-peer, end-to-end encrypted, relay carries only ciphertext."`, `titleOffline: "Encrypted file link — upload now, download later | Relayium"`, `descOffline: "Upload a browser-encrypted file and share a zero-knowledge download link; the server stores only ciphertext."`; translate the four for zh/ja/ko/de/fr).

`web/src/lib/page-meta.ts`:
```ts
import type { Route } from "./router.svelte";
import type { Messages } from "./i18n/types";

// pageMeta returns the per-route <title> + <meta description>. Only the two
// cross-network product modes get bespoke copy; every other route uses the
// default home title/description.
export function pageMeta(route: Route, m: Messages): { title: string; description: string } {
  if (route === "cross") return { title: m.titleCross, description: m.descCross };
  if (route === "offline") return { title: m.titleOffline, description: m.descOffline };
  return { title: m.titleDefault, description: m.descDefault ?? m.titleDefault };
}
```
(If a `descDefault` key already exists use it; otherwise fall back to `titleDefault` as shown — or add `descDefault` too if the home lacks a description key. Keep it consistent with what `types.ts` already defines.)

- [ ] **Step 4: Wire into App.svelte's title effect**

The title effect (App.svelte ~224) currently sets `document.title` from `messages[lang()].titleDefault` on the home route. Change it to use `pageMeta(route(), messages[lang()])` for the base title/description (still override with the live transfer status `x` when a transfer is active, as today), and also set the meta description:
```ts
  // in the reactive title effect:
  const meta = pageMeta(route(), messages[lang()]);
  document.title = x ? `${x} · Relayium` : meta.title; // keep the existing active-transfer override
  const md = document.querySelector('meta[name="description"]');
  if (md) md.setAttribute("content", meta.description);
```
(Match the existing effect's exact shape — it already reads `x` (active status) and `messages[lang()]`; just swap the base title source to `pageMeta` and add the description line. `route()` is the reactive route accessor from `router.svelte.ts`.)

- [ ] **Step 5: Run tests + check + build**

Run: `cd web && npx vitest run src/lib/page-meta.test.ts && npm run check && npm run build`
Expected: PASS + clean type-check (all 6 locales satisfy `Messages`) + build.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/page-meta.ts web/src/lib/page-meta.test.ts web/src/App.svelte web/src/lib/i18n/
git commit -m "feat(web): per-route title + meta description for cross-network/offline-transfer"
```

---

## Self-Review Notes

**Spec coverage:** Component 1 (localized copy) → Tasks 2+3; Component 2 (builder+template) → Task 1; Component 3 (gen-pages+sitemap) → Task 1 (mechanism) + Tasks 2/3 (wiring); Component 4 (SPA per-route meta) → Task 4. hreflang cluster incl English SPA route + x-default → Task 1's `alternates`. slug==router-path → Tasks 2/4.

**Cross-task consistency:** `renderModePage`/`buildModePages` (Task 1) consumed by Tasks 2/3's gen-pages wiring; the content module shape (`{updated, langs:{...}}` with hero/how/why/compare/faq) is identical across Tasks 1 (fixture), 2, 3; `pageMeta(route,m)` (Task 4) is self-contained; the i18n keys (`titleCross/titleOffline/descCross/descOffline`) are added in Task 4 across 6 locales. Slugs `cross-network`/`offline-transfer` are used identically in Tasks 1/2/3 and asserted against `CROSS_PATH`/`OFFLINE_PATH` in Task 4.

**Details the implementer confirms:** whether `article-template.mjs`/`landing-template.mjs` expose a reusable page-shell/`<style>` helper to reuse instead of the minimal head in Task 1 (prefer reuse for visual consistency); whether importing a `.ts` router constant into an `.mjs` Vitest works in this toolchain (Task 2 has a fallback; Task 4's `.ts` test covers the router-equality either way); whether a `descDefault` i18n key exists (Task 4 falls back to `titleDefault` if not). Content accuracy (the per-mode facts) is the load-bearing review criterion for Tasks 2/3 — they must not overstate (realtime = P2P + ciphertext-only relay fallback; offline = zero-knowledge, key-in-fragment, upload needs login).
