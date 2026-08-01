# Web authentication landing trust surfaces — batch 8

Date: 2026-08-01
Status: production validated at `e82c65249c25b719a11e7db2fe81b864760f6ccc`.
Scope owner: `/magic-link`, `/verify-email`, and `/reset-password` presentation,
semantics, private-route head consistency, localization, and regression coverage;
the same private-head correction also covers the existing `/me` and `/d/*` routes.
No API, token, cookie, timeout, redirect, email-template, auth-provider, account-
modal, or general navigation behavior change.

## Problem

The three pages reached from account emails do not look or read like one trusted
workflow. Magic Link is an unbordered block while verification and reset use
separate hand-built cards. Its heading references nonexistent `--fs-lg`, so the
production browser falls back to 18px. Verification and reset have no `<h1>` at
all, and their password fields rely on placeholders instead of persistent labels.

Their raw HTML shells correctly use `noindex, nofollow`, route-specific titles,
and no canonical. After the SPA boots, however, `pageMeta` falls through to the
homepage for all three routes. The rendered page therefore adopts the homepage
title and description and, after client navigation, can retain a public route's
canonical. Private token landings must not claim to be the homepage.

## Design rule

**A private authentication landing is one clear, named task in a restrained
trust surface; presentation may unify, but security transitions may not.**

## Presentation and semantics

Create one small `AuthLanding` presentation component using the existing
`ui-card`, `ui-card-raised`, `ui-stack`, shield icon, spacing, type, control,
focus, success and danger tokens. It owns the centered responsive measure,
trust mark, one localized `<h1>`, and consistent content/action geometry. It
does not own phase or authentication state.

Each route retains its own state machine and supplies its current content:

- Magic Link always names the sign-in task and keeps the explicit confirm click.
- Verify Email names verification, keeps password confirmation and the explicit
  passwordless alternative, and gives its password input a visible label.
- Reset Password names the reset task, adds a concise localized lead, and gives
  both password inputs visible labels with the minimum-length hint associated to
  the new-password field.

Primary actions fill the task measure. At coarse pointer sizes they are at least
44px tall. Inputs use the semantic control boundary and global focus ring. Status
updates use polite status semantics; actionable failures use alert semantics.
Initial explanatory text is not needlessly announced as a live update.

At 320px and 390px, every surface stays within the viewport, actions remain
usable, labels remain visible, and long localized copy wraps. Arabic uses the
document's RTL flow while email/password controls retain browser-appropriate
input behavior.

## Security invariants

This batch must preserve all of the following exactly:

- mounting Magic Link never consumes its token;
- every query token is copied to memory and removed from the URL immediately;
- Magic Link consumes only after the explicit button click;
- Verify Email requires the chosen password or the existing explicit
  passwordless action;
- Reset Password consumes only after a valid form submit;
- pending-deletion reactivation handoff remains unchanged;
- success redirects and their existing delays remain unchanged;
- errors do not disclose account existence.

The shared component receives no token and performs no request, navigation,
timer, or storage operation.

## Private-route head contract

Give the three routes localized titles and descriptions in `pageMeta` and model
their canonical path as absent. The App head synchronizer must remove a stale
canonical and `og:url` when entering a private route, and recreate the correct
elements when returning to an indexable route. Private routes emit no hreflang
cluster. Their generated English noindex shells and rendered SPA head agree on
title and description and remain `noindex, nofollow` with no canonical.
The emailed-token routes are also repeated in the generic and Bingbot
`robots.txt` disallow groups so search crawlers do not queue private links.

## Regression coverage

- Component tests retain the existing token-security assertions and add one h1,
  persistent labels, accessible status/error roles, and shared-surface adoption.
- Metadata tests cover all three private routes, absent canonicals, and
  public-private-public head transitions.
- Shell tests require matching English title/description, noindex, no canonical,
  and no hreflang for each landing.
- Browser coverage uses fake, unsubmitted tokens to exercise URL scrubbing,
  private-to-public metadata symmetry, desktop and 320px coarse-pointer geometry,
  light/dark rendering, all nine locales, and dark Arabic RTL. Component tests
  own token-absent and request-transition behavior.

## Local validation evidence

- Vitest: 117 files passed, 1 skipped; 1,226 tests passed, 1 skipped.
- `svelte-check` and TypeScript: zero errors and zero warnings.
- Isolated full browser E2E: passed auth landings, nine locales, private metadata,
  file transfer/resume, text transfer, and old-peer capability compatibility.
- Manual browser inspection: 480px desktop card, 320px mobile layout, dark Arabic
  RTL, neutral input boundaries, and public metadata restoration all matched.
- Claude Opus independently inspected the implementation and security boundaries;
  its useful late findings (redirect-timer teardown and the missing Magic Link
  crawler disallow) were incorporated before delivery.
- Production served exact assets `index-tKMTH6yd.js`, `index-Cpt-MCF4.css`,
  `AuthLanding-ED16MFNy.js`, `MagicLink-B_91i3hZ.js`,
  `VerifyEmail-B70VwT76.js`, and `ResetPassword-BBLCS63h.js`. Fresh Chrome
  confirmed token scrubbing without auth POST, private metadata, visible labels,
  nine-locale 320px geometry, dark Arabic RTL, and public-head restoration.

## Explicit non-goals

- No new sign-in or recovery method.
- No automatic magic-link submit.
- No token in DOM, logs, history, screenshots, analytics, or test fixtures used
  against production.
- No account modal redesign.
- No general marketing navigation redesign.
- No change to the queued core-transfer verification-code placement batch.
