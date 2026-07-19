# Apps hub page + native macOS/iOS roadmap — design

Date: 2026-07-19
Status: approved (brainstorm)

## Scope of THIS round

Two deliverables:

1. **Buildable now** — a new website "Apps" hub page (`/apps`) that presents every
   Relayium client in one place: Web (available), CLI (available), macOS
   (Coming soon), iOS (Coming soon). No email/notify signup.
2. **Planning only** — a native-app architecture & roadmap appendix (Section B).
   No Swift code is written this round.

Explicitly **out of scope this round**: writing the macOS/iOS apps, APNs push
infrastructure, any App Store submission, an email "notify me" collector.

Deferred product decisions already made by the user:
- Native apps will be **true native Swift** (not a webview wrapper), pursued in a
  later round.
- App cards on the hub are **"Coming soon"** placeholders (disabled buttons, no
  email capture).
- Nav keeps the existing **CLI** tab and **adds a 5th tab** for the Apps hub.
- Android is **not** its own card yet — a one-line "use the web app" note. The
  `/apps` naming intentionally leaves room to add an Android APK card later.

---

## Section A — Website: the `/apps` hub page

### A.1 Naming (locked)

| Thing | Value | Why |
|---|---|---|
| Route name | `apps` | `download` is already taken by the `/d/*` recipient route |
| URL path | `/apps` | Room for an Android APK card later; distinct from `/d/*` |
| SPA component | `web/src/lib/AppsPage.svelte` | Avoids clash with existing `DownloadPage.svelte` (the `/d/` recipient page) |
| i18n message key | `appsPage` | Avoids clash with existing `download` key (recipient page copy) |
| Nav label key | `nav.appsTab` | New 5th tab |

### A.2 Page content

A hero + a responsive card grid. One card per client:

| Card | State | Primary action |
|---|---|---|
| **Web app** | Available | Link to `/` (LAN home) |
| **CLI** | Available | Link to `/cli` (deep docs); show the `curl -fsSL https://relayium.com/install.sh \| sh` one-liner |
| **macOS** | Coming soon | Disabled button + "Coming soon" badge (bundle id `com.relayium.mac` already reserved in AASA) |
| **iOS** | Coming soon | Disabled button + "Coming soon" badge (bundle id `com.relayium.app` already reserved in AASA) |

Behavior:
- Reuse the existing platform detection in `web/src/App.svelte` `deviceLabel()`
  (~lines 613–622) to **highlight the card matching the visitor's OS**. Factor
  the UA→platform check into a tiny shared helper if it isn't already reusable;
  do not duplicate the regex.
- Footer note: "On Android? Use the web app — it works in your browser." No card.

### A.3 SPA wiring (`web/src/lib/router.svelte.ts` + `web/src/App.svelte`)

1. `router.svelte.ts`: add `apps` to the `Route` union; add `APPS_PATH = "/apps"`;
   handle it in `routeFromLocation()` and in the `navigate()` switch.
2. `App.svelte`: add an entry to the `routeLoaders` map (code-split import of
   `AppsPage.svelte`) and a render branch.
3. `App.svelte`: add `apps` to the `surfaceShown` exclusion list (~line 239) so
   the drag-and-drop transfer surface stays off this marketing page.
4. `web/src/lib/page-meta.ts`: add `<title>` + meta description for the route.

### A.4 Navigation & footer

- `web/src/lib/Nav.svelte`: append a 5th entry to the `tabs` array (after `cli`):
  `apps`, label `t.nav.appsTab`. Add the `href` case at the path ternary (~line 37).
  **Keep the existing `cli` tab.**
- `web/src/lib/PageFooter.svelte`: add an "Apps" link → `/apps` alongside Pricing.
- Static-site footers (`web/scripts/pages/landing-template.mjs` ~lines 168–175 and
  the equivalent footers in `article-template.mjs`, `legal-template.mjs`,
  `guides-index-template.mjs`, `mode-template.mjs`): add an "Apps" link so the
  prerendered pages point at the hub too.

### A.5 i18n (both subsystems, all 9 languages: en, zh, ja, ko, de, fr, ar, es, pt)

- **SPA runtime i18n**: add the `appsPage` object + `nav.appsTab` string to the
  `Messages` interface in `web/src/lib/i18n/types.ts`, then fill all 9 tables in
  `web/src/lib/i18n/*.ts` (TypeScript enforces completeness — build fails if any
  key is missing). ar is RTL: use logical properties / existing `dir` mechanism.
- **Static-page i18n**: the prerendered version's copy lives inline in its content
  module as a `langs: { en, zh, … }` map (Section A.6); `validateLangs()` in
  `web/scripts/pages/shared.mjs` fails the build if a language is missing.

### A.6 Static prerendered version (SEO)

Add a prerendered `/apps` landing so the hub is crawlable:
- Create a content module under `web/scripts/pages/content/` (e.g. `apps.mjs`)
  with the `langs` copy map.
- Register it in `web/scripts/pages/gen-pages.mjs` (the `articles` array) and add
  the URL to `buildSitemap`.
- Reuse `landing-template.mjs` (or `mode-template.mjs`) as the shell.

The SPA route serves interactively for in-app navigation; the prerendered file
gives crawlers/first-paint a static page. `server/spa.go` needs no change (a real
file with `index.html` is served automatically; unknown extensionless paths fall
back to the SPA).

### A.7 Server

No server changes required. The Apple `wellknown.go` AASA / native-auth /
Sign-in-with-Apple handlers already exist and stay dormant behind env config; the
hub page does not depend on them being enabled.

---

## Section B — Native app architecture & roadmap (planning only)

Recorded now so the hub's "Coming soon" has a real plan behind it. No code this round.

### B.1 What already exists on the backend (reuse, don't rebuild)

- **Native login**: `server/internal/account/native.go` — `POST /api/auth/native/login`
  mints `rlm_cli_…` bearer tokens and creates a `Device{Kind:"app"}`.
- **Sign in with Apple**: `server/internal/account/apple.go` (native) + `apple_web.go`
  (web). Routes at `handlers.go:109/114/115`.
- **Universal Links**: `server/wellknown.go` serves the AASA + domain-association
  from `RELAYIUM_APPLE_APP_IDS` (`<TeamID>.<BundleID>`), dormant (404) until set.
  Committed placeholder AASA already reserves `com.relayium.app` (iOS) and
  `com.relayium.mac` (macOS) and hands off `/d/*` and `/cross-network`.

### B.2 Proposed architecture

- **Shared core**: a Swift Package `RelayiumKit` holding transfer, signaling,
  crypto and wire-protocol logic. iOS and macOS each add a thin SwiftUI UI layer.
  Goal: write the core once, not twice.
- **WebRTC**: use native WebRTC (SPM `stasel/WebRTC`) as just another peer against
  the existing WS signaling server + pion. **Must match the existing DataChannel
  ACK credit-window flow control and `WireVersion`** or interop with browser/CLI
  peers breaks. Validate with the existing headless WebRTC E2E harness.
- **Auth**: reuse native bearer login + native Sign in with Apple (B.1).
- **Deep links**: enable Universal Links by setting `RELAYIUM_APPLE_APP_IDS`; the
  AASA already routes `/d/*` and `/cross-network` into the app.

### B.3 Known gaps / new work for the app rounds

- **APNs push**: none today. Needed for offline "someone wants to send you a file"
  wake-ups. New server-side APNs service + push entitlement/cert. Independent item.
- **Distribution**: macOS → Developer ID signing + notarization for direct `.dmg`
  download from the site (optionally also Mac App Store); iOS → App Store only.

### B.4 Suggested sequence (to be confirmed in a later round, NOT decided now)

macOS first (verify interop, lowest App Store friction) → extract `RelayiumKit`
shared core → iOS reuses the core. When the apps ship, the hub's "Coming soon"
cards flip to real download / App Store links, and the Android decision is
revisited.

---

## Implementation note

The implementation plan produced from this spec covers **Section A only** (the
website). Section B is a roadmap appendix for future rounds.
