# Document CLI Cloud Async Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document the CLI cloud async transfer (`login`/`up`/`down`) on the `/cli` page and in a new standalone Guides article, in all six site languages.

**Architecture:** Content-only. A new guide article `.mjs` (six langs) registered in the static-page generator; a new section + i18n keys (six langs) on the `/cli` SPA page. No CLI/behavior changes.

**Tech Stack:** Svelte SPA (`web/src`), Node static-page generator (`web/scripts/gen-pages.mjs` + `pages/content/articles/*.mjs`), vitest.

## Global Constraints

- Six languages required everywhere: en, zh, ja, ko, de, fr. The page-gen build FAILS on a missing translation — that's the completeness gate. Author en + zh carefully; ja/ko/de/fr match the existing articles' tone and facts.
- Command blocks stay English in every language (matches every existing article).
- Framing in all copy: account binding is OPTIONAL; only `up`/`down` touch the account; `up` needs login, `down` does NOT; everything else in the CLI stays no-login and free. Zero-knowledge: key is only in the `#k=` link fragment; server stores ciphertext. Web↔CLI interop: a CLI `up` link opens in a browser; `down` accepts a browser share link.
- Correct commands/flags (from the shipped feature): `relayium login` (device-code, opens `/device`), `relayium up <src...> [--burn] [--ttl <dur>] [--max-downloads <n>] [--server <url>]` (prints `https://<origin>/d/<id>#k=<key>`), `relayium down <link|code> [destdir]`, `relayium whoami`, `relayium logout`.
- Run all commands from `web/`.

## File Structure

- Create: `web/scripts/pages/content/articles/cli-cloud-async.mjs` (new guide, 6 langs).
- Modify: `web/scripts/gen-pages.mjs` (import + register the new article).
- Modify: `web/src/lib/i18n.svelte.ts` (new `cliPage.*` keys, 6 langs).
- Modify: `web/src/lib/CliPage.svelte` (new section, mode tile, flags rows, related-guide slug).

---

## Task 1: New Guides article — `cli-cloud-async.mjs`

**Files:**
- Create: `web/scripts/pages/content/articles/cli-cloud-async.mjs`
- Modify: `web/scripts/gen-pages.mjs`

**Interfaces:**
- Consumes: the article shape + build pipeline.
- Produces: a default export `{ slug: "guides/push-to-cloud-pull-on-another-computer", category: "guides", updated: "2026-07-12", langs: { en, zh, ja, ko, de, fr } }` where each lang is `{ title, description, updatedLabel, lead:[...], sections:[{heading, body:[...], code:[...], bullets:[...]}] }`.

- [ ] **Step 1: Author the article by mirroring an existing guide**

Open `web/scripts/pages/content/articles/guides-receive-from-cli.mjs` and copy its exact structure (per-lang `const en/zh/ja/ko/de/fr`, the `sections` schema, the `updatedLabel` per lang, the default export). Write the new article with these sections (see Global Constraints for the exact commands/flags/framing):
1. **What it is & when to use** — async transfer through your account: upload on one machine now, download on another later; the two ends need not be online at the same time. Contrast: P2P `send`/`receive` needs both online; SSH `push`/`pull` needs a server you can ssh into; this needs neither — just your account.
2. **`relayium login`** — the one optional, login-requiring piece; device-code flow (prints a code + opens `relayium.com/device`); everything else in the CLI stays no-login.
   - code block: `relayium login`
3. **`relayium up`** — upload + the printed claim link; the three retention modes and the flags:
   - code block: `relayium up ./report.pdf` then a commented block showing `--burn` (one download then gone), `--ttl 7d` (keep 7 days), `--max-downloads 5` (N downloads). Note the admin default applies when none is given.
4. **`relayium down` on the other computer** — paste the link or code; NO login needed.
   - code block: `relayium down 'https://relayium.com/d/<id>#k=<key>' ./dest`
5. **Web ↔ CLI** — the `up` link opens in a browser; `down` also accepts a link created from the website's share flow.
6. **Privacy** — zero-knowledge: the decryption key lives only in the link's `#k=` fragment, never sent to the server; the server holds only ciphertext; losing the link means losing the file.

Keep `title`/`description`/`lead`/`heading`/`body`/`bullets` translated per lang; keep every `code` block identical English across langs. en + zh get careful, natural copy; ja/ko/de/fr mirror the facts and match the register of the existing articles.

- [ ] **Step 2: Register in the generator**

In `web/scripts/gen-pages.mjs`: add `import cliCloudAsync from "./pages/content/articles/cli-cloud-async.mjs";` alongside the other article imports, and add `cliCloudAsync` to the articles array that is passed to `buildArticlePages`/the build (find where `cliGettingStarted` etc. are listed and add it there, so it inherits the guides category + sitemap + hreflang).

- [ ] **Step 3: Build — the six-lang gate**

Run: `cd web && node scripts/gen-pages.mjs`
Expected: completes with no "missing translation" error; writes `public/guides/push-to-cloud-pull-on-another-computer/index.html` and the five localized copies (`public/{zh,ja,ko,de,fr}/guides/...`), and the new URL appears in the sitemap. If it errors on a missing lang, fix the gap and re-run.

- [ ] **Step 4: Verify it's in the hub + tests green**

Run: `cd web && npx vitest run`
Expected: PASS (article-template / guides-index / sitemap tests). Confirm the generated Guides hub (`public/guides/index.html`) links the new article under the Guides category. If an existing test enumerates the article set, update it to include the new one.

- [ ] **Step 5: Commit**

```bash
git add web/scripts/pages/content/articles/cli-cloud-async.mjs web/scripts/gen-pages.mjs web/public
git commit -m "docs(guides): add cloud async transfer guide (up/down, 6 langs)"
```

---

## Task 2: `/cli` page — "Cloud sync (account)" section

**Files:**
- Modify: `web/src/lib/i18n.svelte.ts` (new `cliPage.*` keys, all six lang objects)
- Modify: `web/src/lib/CliPage.svelte` (section, mode tile, flags rows, related-guide slug)

**Interfaces:**
- Consumes: `t.cliPage.*`, `<CommandBlock>`, the mode-tile array, the flags array, `guideSlugs`.
- Produces: rendered cloud-async section on `/cli`.

- [ ] **Step 1: Add i18n keys (six langs)**

In `web/src/lib/i18n.svelte.ts`, find the `cliPage` object inside each of the six language message objects (en/zh/ja/ko/de/fr) and add the SAME new keys to each (translated): `cloudH2`, `cloudTag` (e.g. en "account"), `cloudIntro` (optional binding; only up/down; down needs no login; everything else no-login & free), `cloudBody`, `cloudLoginNote` (device-code → relayium.com/device), `cloudInteropNote` (link opens in a browser; down accepts a web share link), `cloudPrivacyNote` (zero-knowledge, key in the fragment). Match the tone of the neighboring `mode1/2/3` keys. Missing a key in any lang is a TypeScript error (the `Messages` type) — add to all six.

- [ ] **Step 2: Render the section + tile + flags in CliPage.svelte**

- Add literal command constants near the other `const …Cmd` blocks:
  ```js
  const loginCmd = `relayium login   # opens relayium.com/device — enter the code to bind this machine`;
  const upCmd = `# upload from one machine (needs login)
  relayium up ./report.pdf
  #   → https://relayium.com/d/<id>#k=<key>

  # retention (defaults to the server's policy)
  relayium up ./report.pdf --burn            # one download, then gone
  relayium up ./report.pdf --ttl 7d          # keep for 7 days
  relayium up ./report.pdf --max-downloads 5 # allow 5 downloads`;
  const downCmd = `# on another machine — no login needed
  relayium down 'https://relayium.com/d/<id>#k=<key>' ./dest`;
  ```
- Add a new `<section>` (after the sync section, before the guides section) using `t.cliPage.cloudH2`/`cloudIntro`/`cloudBody`/`cloudLoginNote`/`cloudInteropNote`/`cloudPrivacyNote` and three `<CommandBlock>`s (`title="login"`, `title="up"`, `title="down"`). Mirror the markup of the existing `mode2`/sync sections (including the tag span using `t.cliPage.cloudTag`).
- Add a feature-grid tile to the modes array: `{ g: "☁️", title: "cloud (async)", cmd: "relayium up … / down" }`.
- Add flags rows to the flags array: `{ flag: "--burn", who: "up" }`, `{ flag: "--ttl <dur>", who: "up" }`, `{ flag: "--max-downloads <n>", who: "up" }`, `{ flag: "--server <url>", who: "login / up / down" }`. (Leave existing rows; these document the new verbs.)
- Add the new guide slug to `guideSlugs`: `"guides/push-to-cloud-pull-on-another-computer"`.

- [ ] **Step 3: Typecheck + tests**

Run: `cd web && npx svelte-check` (or the project's typecheck script) and `npx vitest run`.
Expected: no type error (all six langs have the new keys), tests PASS.

- [ ] **Step 4: Visual check**

Run the SPA (project's dev/preview command) and open `/cli` and `/zh/cli` (or `/?lang=zh`). Confirm the cloud section, the ☁️ tile, and the new flags rows render, and the "related guides" list shows the new guide. (If a headless check isn't available, build the SPA and grep the built bundle for `cloudH2`'s value to confirm it's included.)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/i18n.svelte.ts web/src/lib/CliPage.svelte
git commit -m "docs(cli-page): document cloud async (login/up/down) section + flags"
```

---

## Self-Review Notes

- **Spec coverage:** Guide article (6 langs) + registration → Task 1. `/cli` section + i18n + tile + flags + related-guide link → Task 2. Build/completeness gate → Task 1 Step 3 + Task 2 Step 3.
- **Consistency:** the guide slug `guides/push-to-cloud-pull-on-another-computer` is identical in Task 1's default export, Task 2's `guideSlugs`, and any test. Commands/flags match the Global Constraints (and the shipped feature) in both the guide and the `/cli` blocks. The `#k=` link format matches what `relayium up` actually prints.
- **No placeholders:** the copy is the deliverable, authored at implementation against the section outlines above; command blocks are given verbatim.
- **Out of scope (unchanged from spec):** homepage/nav promotion, screenshots, account-deletion docs, any behavior change.
