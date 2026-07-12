# Document CLI Cloud Async Transfer (frontend + tutorial) — Design

Date: 2026-07-12
Status: Approved (brainstorming), ready for implementation plan

## Goal

The CLI's account-bound cloud async transfer (`login`/`up`/`down`, shipped in
`cli-cloud-async-transfer`) is undocumented on the site. Add it to (1) the `/cli`
page and (2) a new standalone tutorial in the Guides system — in all six site
languages, so it's discoverable and matches the rest of the docs.

## Decisions (locked during brainstorming)

- **Both surfaces:** a full new section on `/cli` AND a new standalone guide
  article (chosen over extend-an-existing-article).
- **All six languages** (en/zh/ja/ko/de/fr). The static-page build enforces
  translation completeness (a missing lang fails the build). en/zh authored
  carefully; ja/ko/de/fr follow the existing articles' tone and facts.
- **Framing everywhere:** account binding is OPTIONAL; only `up`/`down` touch the
  account and only `up` needs login (`down` needs none); everything else in the
  CLI stays no-login and free. Zero-knowledge: the AES key rides in the link
  `#k=` fragment, the server only stores ciphertext. Web↔CLI interop: a CLI `up`
  link opens in a browser, and `down` accepts a browser share link.

## What exists (reused, not rebuilt)

- `web/src/lib/CliPage.svelte` — the `/cli` SPA page. Prose comes from
  `t.cliPage.*` (in `web/src/lib/i18n.svelte.ts`, per-lang objects); command
  blocks are literal English via `<CommandBlock>`. It has: install, "which mode",
  mode tiles (mode1/2/3 = push-pull / send-receive / daemon-direct), a sync
  section, a "related guides" list (`guideSlugs`), a flags table, trust +
  integrity refs.
- Guide articles: one `.mjs` per article under
  `web/scripts/pages/content/articles/`, shape
  `{ title, description, updatedLabel, lead:[...], sections:[{heading, body:[...],
  code:[...], bullets:[...]}] }` × `langs:{en,zh,ja,ko,de,fr}` + a default export
  `{ slug, category, updated, langs }`. Built by `web/scripts/gen-pages.mjs`
  (import + add to the articles array) → static HTML + hreflang cluster + sitemap.
  The Guides hub lists articles by `category`. Existing CLI cluster:
  `cli-getting-started`, `cli-send-to-someone`, `cli-server-to-server`,
  `cli-sync-large-folder`, `guides-receive-from-cli`.

## Part 1 — `/cli` page: "Cloud sync (account)" section

- New mode tile + section (place after the sync section, before "related guides")
  driven by new `t.cliPage.*` keys in all six langs:
  - `cloudH2`, `cloudTag` ("account", not "free"), `cloudIntro` (optional binding;
    only up/down; down needs no login), `cloudBody`, `cloudLoginNote`,
    `cloudInteropNote`, `cloudPrivacyNote`.
- Literal command blocks (English, in CliPage.svelte):
  - `relayium login` — "opens relayium.com/device; enter the code to bind this
    machine to your account."
  - `relayium up ./report.pdf` → prints `https://relayium.com/d/<id>#k=<key>`;
    show retention flags: `relayium up ./report.pdf --burn` /
    `--ttl 7d` / `--max-downloads 5`.
  - `relayium down 'https://relayium.com/d/<id>#k=<key>' ./dest` — no login.
  - `relayium whoami` / `relayium logout`.
- Mode tile in the feature grid: `{ g: "☁️", title: "cloud (async)",
  cmd: "relayium up … / down" }`.
- Flags table additions: `--burn` (up), `--ttl <dur>` (up), `--max-downloads <n>`
  (up), `--server <url>` (login / up / down); and add `login / up / down / whoami
  / logout` to the relevant `who` entries.
- Add the new guide slug to `guideSlugs` (related guides).

## Part 2 — new guide article `cli-cloud-async.mjs`

- File: `web/scripts/pages/content/articles/cli-cloud-async.mjs`.
- Slug: `guides/push-to-cloud-pull-on-another-computer`. Category: `guides`
  (mirror `guides-receive-from-cli.mjs`'s default-export shape).
- Title (en): "Push files to the cloud, pull them on another computer".
  Description: async transfer through your Relayium account — upload on one
  machine, download on another, end-to-end encrypted; only uploading needs login.
- Sections (each in all six langs; command blocks stay English):
  1. What it is & when to use — async (the two machines are never online at the
     same time / different times); contrast with the P2P `send`/`receive` (both
     online) and SSH `push`/`pull`.
  2. `relayium login` — bind your account (device-code flow; the one optional,
     login-requiring piece); everything else stays no-login.
  3. `relayium up` — upload + the claim link; the three retention modes
     (`--burn` = one download, `--ttl <dur>` = keep N days, `--max-downloads <n>`);
     admin default applies when none given.
  4. `relayium down` on the other computer — paste the link/code; no login.
  5. Web↔CLI interop — the link opens in a browser; `down` accepts a browser
     share link too.
  6. Privacy — zero-knowledge: the key is only in the link fragment; the server
     stores ciphertext; a lost link means a lost file.
- Register: import + add to the articles array in `gen-pages.mjs`; ensure it
  appears in the Guides hub (via `category: "guides"`) and the sitemap (automatic
  via `buildArticlePages`/`buildSitemap`).

## Build / verify

- `cd web && node scripts/gen-pages.mjs` (or the project's page-gen npm script)
  regenerates `public/**` — the build FAILS if any of the six langs is missing,
  which is the completeness gate.
- `cd web && npx vitest run` — article-template / guides-index / landing tests
  stay green; add/extend a test asserting the new guide builds with the full
  hreflang cluster if the existing tests cover a representative article.
- Launch the SPA and open `/cli` to confirm the new section, tile, and flags
  render in at least en + zh.

## Out of scope

- Homepage / three-page / nav promotion of the feature (docs pages only).
- New screenshots or diagrams.
- Documenting account deletion (separate feature) or CLI-initiated deletion (not
  built).
- Changing any CLI behavior — docs only.
