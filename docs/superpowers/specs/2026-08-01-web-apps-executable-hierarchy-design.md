# Web Apps executable hierarchy — batch 7

Date: 2026-08-01
Status: production validated.
Scope owner: `/apps` SPA information hierarchy, shared primitive adoption, and
component/browser regression coverage. No route, release, download, appcast,
native-client, SEO-copy, analytics, navigation, or footer behavior change.

## Problem

Production `/apps` renders Web, CLI, macOS and iOS as four equal 228px cards at
1440×900. Web and CLI are usable now, while macOS and iOS are coming soon, but
the only accent outline follows the detected OS even when that card has no
executable action. A macOS visitor therefore sees the strongest visual signal on
the unavailable macOS card; iOS has the same dead-end behavior.

The page also predates the shared UI vocabulary: it hand-writes page header,
cards, badges and CTAs; its mobile CTA is about 41px unless coarse-pointer CSS is
active elsewhere; coming-soon cards reduce all content with `opacity: .82`; and
the long CLI command has no explicit LTR isolation, keyboard scroll affordance or
localized accessible name. `AppsPage` has no component test.

## Design rule

**Structure expresses availability, accent expresses executability, and user-
agent detection supplies only a neutral platform marker.**

## Information architecture

Build a typed card model in stable Web, CLI, macOS, iOS order and partition it
into two semantic sections:

1. available now;
2. coming soon.

Use the existing localized `availableBadge` and `comingSoonBadge` strings as
real section `<h2>` headings. Do not repeat the same status as both a per-card
badge and a disabled button.

Web and CLI are always available. macOS is available only when both
`native-releases.json.macos.available === true` and a non-empty `downloadUrl`
exist. This conservative predicate prevents a half-filled manifest from placing
an actionless card in the available section. iOS remains coming soon. The JSON
is a build-time import: the existing staging script atomically changes it and a
new build moves macOS between sections; this batch introduces no runtime release
fetch or third truth source.

Available cards have real links styled with `.btn.btn-primary` and a page-local
full-width, non-growing CTA rule. Do not use `.btn-block` in the vertical card:
its flex-grow contract is intended for action rows and would stretch the shorter
card's button along the block axis.
Coming-soon cards have no link, button or focus target; a quiet status line uses
the existing localized coming-soon string. Remove whole-card opacity so readable
prose retains its theme contrast. De-emphasize future cards through surface and
border treatment only.

## Platform marker

Preserve the existing nine-language `yourPlatformNote(os)` copy and detected OS
logic. The matching card remains visibly marked so “highlighted below” stays
true, but `.is-platform` is a neutral `--control-border` outline rather than an
accent outline. The marker never changes availability, card order, CTA or
recommendation. In particular, a macOS visitor is not falsely told that Web or
CLI is “their platform.”

The existing iPad desktop-UA heuristic remains unchanged. Its touch-point trade-
off is identification only and cannot create or remove an executable action.

## Shared primitives and responsive behavior

- Adopt `.ui-page-head` with the existing subtitle as `.tagline` and platform
  note as `.pitch`.
- Adopt `.ui-card.ui-stack` for every platform card and shared `.btn` tiers for
  executable actions.
- Keep page-local group/grid rules because availability changes the number of
  cards in each section. At the current manifest, available cards use a two-
  column desktop grid with a stronger measure than the previous 228px cards;
  future cards form a quieter two-column row. When macOS ships, the three
  available cards share one equal desktop row and the single remaining future
  card stays centered at card measure instead of stretching page-wide. Both
  sections stack to one column on mobile. Do not render an empty future section.
- Card descriptions use `.ui-card-sub`, `overflow-wrap:anywhere`, and flex growth
  so CTAs align without fixed heights across nine languages.
- Preserve logical properties and verify LTR/RTL, light/dark and long German/
  French/Arabic content without page, card or control overflow.
- Shared `.btn` supplies the 44px coarse-pointer target floor. There are no dead
  coming-soon controls to measure or focus.

## CLI command

Do not reuse `CommandBlock` in this batch: its Copy/Clipboard strings are still
hard-coded English, so importing it into a nine-language hub would expand that
debt. Keep the compact Apps command surface, but make it an explicitly LTR,
horizontally scrollable, focusable code region whose accessible name comes from
the existing localized `cliInstallLabel`. Browser evidence must show Arabic
starts at `curl`, keyboard focus is visible, and the command stays within its
card instead of widening the page.

## Static and release boundaries

The localized static `/[lang]/apps` pages and English noscript shell already read
the same manifest at build time and describe release availability in prose. This
batch changes no `scripts/pages/content/apps.mjs` copy, page metadata or static
template. Existing release-surface tests must retain their semantic guards:
macOS CTA copy exists in every locale, unpublished builds do not claim release,
and the SPA still consumes manifest availability, URL and localized CTA.

## Accessibility contracts

- One page `<h1>`, followed by localized availability `<h2>` sections and card
  `<h3>` headings.
- Only available products expose actions; future status is text, not a disabled
  control.
- The platform note remains a non-visual explanation of the neutral visual mark.
- CLI code is focusable, named, LTR and keyboard-scrollable.
- Future-card prose retains at least 4.5:1 contrast in light and dark themes.
- Available CTAs retain visible focus and at least 44px block size on coarse
  pointers.

## Test and evidence plan

Add `AppsPage.test.ts` with injected/mocked platform and release states covering:

- current manifest: Web/CLI in Available, macOS/iOS in Coming soon, two actions;
- released macOS: it moves to Available and uses the exact manifest URL;
- half-filled macOS manifest: it remains Coming soon with no action;
- macOS/iOS detection marks the matched future card neutrally and never applies
  an accent/action class to it;
- correct headings, shared primitives, no dead disabled controls, and the LTR
  named command surface;
- existing navigation semantics for Web and CLI.

Update the existing release-surface source contract without weakening its real
semantic assertions. Add a permanent browser scenario for current production-
like state: desktop and all nine 390px locales, coarse pointer, Arabic RTL/dark,
group order, action count, target size, command direction/scroll origin, and zero
overflow. Temporarily exercise released and half-filled manifest fixtures in
tests/builds, then restore the tracked manifest byte-for-byte before delivery.

Run focused and full Vitest, Svelte/TypeScript check, production build, full LAN
file/resume/text/old-peer E2E, Claude Opus review, repository hygiene, exact-
asset deployment polling and fresh production browser validation.

## Exclusions and deferred work

- No new or changed localized copy, SEO metadata or static-page prose.
- No macOS release flip, appcast edit, native build, iOS action or Android copy.
- No telemetry or recommendation algorithm.
- No `CommandBlock` localization/refactor.
- No Nav/footer changes.
- The unrelated undefined `--fs-lg` in `MagicLink.svelte` remains a separately
  recorded auth/design-system cleanup candidate.
