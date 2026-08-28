# `web/` — the Relayium web client

The Svelte 5 single-page app served at [relayium.com](https://relayium.com/),
plus the static-page generator that prerenders ~450 crawler-facing pages into
`public/`. It is built with Vite and TypeScript, and licensed **AGPL-3.0** (see
[`LICENSE`](LICENSE)) — unlike `apps/`, which is Apache-2.0.

The Go server in [`../server`](../server) serves the built `dist/` directory as
well as the API and WebSocket signaling, so a real two-device transfer is tested
against that binary rather than against the Vite dev server. See the
[Quick start](../README.md#quick-start-run-it-locally) in the root README.

## Commands

Every command below is a script in [`package.json`](package.json); run them from
this directory.

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies (Node 20+). |
| `npm run dev` | Generate static pages, then start the Vite dev server. Good for UI work; signaling is same-origin, so it cannot complete a real transfer on its own. |
| `npm run build` | Generate static pages, then build into `dist/`. |
| `npm run preview` | Serve a build that has already been produced. |
| `npm run check` | `svelte-check` over `tsconfig.app.json`, then `tsc -p tsconfig.node.json`. |
| `npm test` | Vitest in watch mode. `npx vitest run` for a single pass. |
| `npm run gen:pages` | Write the static pages, `sitemap.xml` and `client-policy.json` into `public/`. Also runs automatically before `dev` and `build`. |

Cross-language wire vectors, which the Swift clients read as fixtures:

| Command | What it does |
| --- | --- |
| `npm run test:vectors` | Re-run the generators twice and fail if the tracked bytes moved. Restores what it found, so it never edits your tree. CI runs this form. |
| `npm run gen:vectors` | The writing form. Run it and commit the result with the change that moved the wire. |

Browser-driven checks. Each drives real Chrome and needs a running server, so
none of them is part of `npm test`:

| Command | What it does |
| --- | --- |
| `npm run test:e2e` | Same-network transfer between two real browser contexts. |
| `npm run test:e2e:mixed` | Mixed stored-link flow. |
| `npm run test:e2e:code-room` | Cross-network pairing-code room. |
| `npm run test:e2e:share-target` | PWA share-target entry. |
| `npm run test:device-inbox` | Device Inbox delivery, end to end. |
| `npm run test:device-inbox-entry` | The `/device-inbox` entry points. |
| `npm run test:device-discovery` | LAN peer discovery. |
| `npm run test:a11y` | axe-core scan over the generated pages. |
| `npm run test:interop` | Device-seal interop against the Go implementation (`RELAYIUM_GO_INTEROP=1`). |

## Layout

- `src/` — the SPA. `src/lib/` holds the crypto, transport and protocol modules
  (`crypto.ts`, `webrtc.ts`, `signaling.ts`, `transfer.ts`, `device-inbox.ts`)
  alongside the components; `src/lib/i18n/` holds the message tables.
- `scripts/pages/` — the static-page generator and, next to it, the tests that
  hold the generated pages and the SPA to the same product facts.
- `public/` — committed generated output plus static assets. Do not hand-edit a
  file the generator owns; change its source under `scripts/pages/content/` and
  run `npm run gen:pages`.
- `e2e/` — the browser-driven harnesses listed above.
- `native-releases.json`, `mac-app-store-release.json`, `native-client-policy.json`
  — the canonical release records the app and the pages read from. Each has one
  owner; nothing else may restate a version they carry.

## Languages

The product is maintained in **English and Simplified Chinese**. Seven earlier
locales stay published as archived translations and are not updated with product
changes — see [Translations](../CONTRIBUTING.md#ways-to-contribute) before
touching any locale.
