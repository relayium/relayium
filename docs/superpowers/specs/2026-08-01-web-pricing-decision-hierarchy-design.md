# Web pricing decision hierarchy — batch 6

Date: 2026-08-01
Status: implemented and locally validated.
Scope owner: Web pricing page, shared Pricing component, and Pricing-route
account-control visibility. No API, Stripe rule, plan relation, checkout,
account-state, route, or pricing-copy meaning change.

## Problem

Production `/pricing` makes the visitor read the complete free-versus-paid
explanation before seeing a billing cycle or price. At 1440×900 the tier grid
starts at document y=921, entirely below the first viewport. At 390×844 the
explainer is 1100px tall and the first tier starts at y=1623.

The hierarchy defect is compounded by unfinished design-system adoption:
`PricingPage.svelte` and `Pricing.svelte` reference undefined `--fs-xl`,
`--fs-lg`, `--fs-md` and `--text-muted` variables, so every value silently uses
a page-local fallback. The rendered paid price is only about 22.5px, barely
larger than body copy, and both tier and explainer cards duplicate the shared
surface primitives that Batch 1 deliberately deferred.

## Design

### Decision before explanation

The page order becomes:

1. back action and shared page header;
2. `Pricing`: localized billing-cycle control and real tier cards;
3. the complete existing free-versus-paid explainer;
4. self-hosting option;
5. the complete existing FAQ.

The existing subtitle remains in the header, so the honest-pricing proposition
is still visible before the plans. No explainer or FAQ copy is removed or hidden.

Use a 1040px page measure so four desktop tiers have an honest decision width.
Keep mobile as one stacked column and preserve logical properties for RTL.

### Shared hierarchy and surfaces

- Add one `--fs-page-title: 34px` token and use it in the existing
  `.ui-page-head h1` rule without changing its rendered size.
- Adopt `.ui-page-head` for the pricing header.
- Use `--fs-h2` plus tabular numerals for paid prices and `--fs-h3` for tier and
  explainer headings. Remove every phantom token reference from both components.
- Add `.ui-card`/`.ui-stack` to tier and explainer cards, `.ui-badge` to the
  popular marker, `.ui-card` to self-hosting, and shared callouts to status/error
  messages. Preserve the existing `.tier`, `.ribbon`, `.selfhost` and test/state
  classes where behavior depends on them.
- Keep USD literal pricing because Stripe charges USD, but isolate the amount in
  an LTR `bdi` so `$`, digits and decimal punctuation cannot reorder in Arabic.
- Treat Pricing as a login-gated route in `Nav`: signed-out visitors must have
  an executable Sign in control before and after an Upgrade request returns 401.
  This changes no route or account behavior; it exposes the existing Account
  control on the purchase surface that already requires it.

### First-viewport loading and errors

Moving Pricing upward makes its asynchronous state load-bearing. While
`/api/plans` is pending, render four decorative skeleton cards with the same grid
footprint and a localized status announcement. On load failure, replace the
skeleton/grid with a danger callout; never render an unexplained empty decision
area. Checkout errors, change success and scheduled-plan state remain visible
without changing any purchase or subscription transition.

### Billing-cycle accessibility

Add only two billing strings in all nine locales: `cycleLabel` and
`loadingPlans`. Source the cycle group's accessible name from `cycleLabel` and
put `aria-pressed` on both cycle buttons. Keep the savings badge adjacent to the
control and the cycle actually used by displayed prices and checkout requests.

## Invariants

- `Pricing.svelte` still works both on `/pricing` and inside Account's narrow
  `.pricing-inline` mount; use responsive/container-safe layout rather than a
  page-only assumption.
- Preserve all current-plan, scheduled-plan, free, unavailable, upgrade,
  downgrade, cycle-switch, portal and preview-modal branches and re-entry guards.
- Do not change `/api/plans`, `formatSize`, retention semantics, `POPULAR_ID`,
  `planRelation`, `ChangePlanModal`, Stripe request bodies or navigation.
- Added layout uses logical properties. German/French CTA wrapping must not clip;
  Arabic price ordering and popular-marker placement must be correct.
- Skeletons are decorative, non-focusable and removed after success/failure.
  The localized loading status is the only announced loading content.

## Acceptance

- At 1440×900, the first tier begins above document y=700 (baseline 921).
- At 390×844, the first tier begins above document y=1000 (baseline 1623).
- The paid price is the largest type on the page except the h1; all phantom
  token references are gone.
- Unit tests prove Pricing precedes the explainer while all explanation,
  self-host and six FAQ entries remain; pending/success/failure rendering;
  localized group name and `aria-pressed`; monthly/yearly price/request coupling;
  every existing subscription/CTA safety branch.
- Existing Account billing tests pass unchanged in intent. Real-browser checks
  cover the Account inline mount as well as `/pricing`.
- Browser geometry covers all nine locales at 390px, desktop English, long German
  and French, dark Arabic RTL, loading/error injection, and zero internal/page
  overflow. Buttons retain coarse-pointer target size and keyboard focus.
- Svelte/TypeScript check, full Vitest, production build and complete LAN E2E pass.
- Nav tests prove Pricing exposes Account while LAN/CLI keep the established
  no-account navigation contract.
- Claude Opus reviews both the requirement and final implementation before
  delivery.

## Deferred

Global typography changes, currency localization beyond USD bidi isolation,
Apps/Me/CLI migration, PlanCard, Account redesign, SEO/static pricing pages and
any product-copy rewrite remain separate batches.
