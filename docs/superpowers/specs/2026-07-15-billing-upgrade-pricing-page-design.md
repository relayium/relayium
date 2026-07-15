# Billing: in-app plan change + standalone pricing page

Date: 2026-07-15. Builds on the Stripe phase-2 billing already shipped.

## Motivation

Four asks from the product owner:

1. **Short test retention.** While Stripe is in test mode on production, shorten
   each plan's file-retention window so a stray test subscription can't leave
   files (or benefits) lingering.
2. **No upgrade path after subscribing.** The account panel only showed "Manage
   billing" (Stripe portal) once a user had a subscription — there was no way to
   move Plus→Pro→Max in-app.
3. **No pricing page.** Tiers only rendered inline inside the account modal; there
   was no linkable `/pricing` page for marketing/SEO.
4. Assorted UX polish.

## Decisions

- **Retention (test):** Free 1d, Plus 3d, Pro 7d, Max 7d — set directly in the
  `plans` table on the server (runtime config, not `defaultPlans()` in code, which
  keeps the real 30/90/180 factory values). Reversible from `/admin`.
- **Upgrade/downgrade:** in-app plan change, not just the Stripe portal.
- **Pricing page:** a standalone marketing route at `/pricing`.

## Design

### Task 2 — in-app plan change

- **Biller.ChangeSubscriptionPlan(customerID, newPriceID)** (new interface method):
  looks the customer's active subscription up by customer (we don't persist
  subscription ids), then updates its single item's price with
  `proration_behavior=create_prorations`. No-op if already on the target price.
  Stripe emits `customer.subscription.updated`, which the existing webhook turns
  into the plan reassignment — so this method never writes the DB.
- **POST /api/billing/change-plan** (session-gated) `{planId, cycle}`:
  404 unconfigured; **409** if the user has no Stripe-sourced subscription
  (`stripe_customer_id==""` or `plan_source!="stripe"` — free users and
  admin-comped accounts fall here and should use checkout / stay comped); **400**
  for the current plan or a free/unmapped target. Direction is ranked by the
  plans' **monthly** price (stable across cycles): a higher tier is an **upgrade**,
  a lower tier a **downgrade**. Returns `{status:"ok", effective:"now"|"period_end"}`.

- **Upgrade vs downgrade timing (the fix, 2026-07-15 followup):**
  - *Upgrade* → `ChangeSubscriptionPlan`: switch the price immediately with
    `proration_behavior=create_prorations` (charge the difference now).
  - *Downgrade* → `ScheduleDowngrade`: a Stripe **subscription schedule** keeps
    the current price until `current_period_end`, then switches to the new price
    (`end_behavior=release`). No refund, no proration credit — the customer keeps
    the tier they paid for until it lapses. `plan_id` only changes when the phase
    transition fires `customer.subscription.updated` at period end (the same
    webhook path). **Known limitation:** while a downgrade is pending, the
    subscription is schedule-managed, so a further in-app change 500s — the
    customer must wait it out or use the Stripe portal (followup: amend/cancel the
    schedule in place).
  - The webhook still assigns `plan_id` purely by the subscription's current
    price, so creating the schedule (price unchanged) never prematurely downgrades.
- **Pricing.svelte** becomes subscription-aware (reads the session store): each
  paid tier renders "Current plan" (the user's tier), "Upgrade" (higher), or
  "Downgrade" (lower). Subscribed users route the button to change-plan (with a
  `confirm()` proration warning); free/logged-out users route to checkout
  (unchanged, incl. the 401 → "sign in" path). On success it polls `/api/me`.

### Task 3 — /pricing page

- New `pricing` route in the SPA router (`PRICING_PATH="/pricing"`), lazy-loaded
  `PricingPage.svelte` = headline + subtitle + `<Pricing/>` + a 3-item FAQ + back
  link. `pageMeta` gives it its own title/description/canonical for SEO. Linked
  from the footer and the account panel ("Upgrade" for subscribed users navigates
  here instead of only showing the portal).

### Task 4 — polish

- Yearly savings badge ("2 months free", since yearly = 10× monthly).
- "Most popular" ribbon on the Pro tier.
- Plan-change `confirm()` dialog noting proration (prevents surprise charges).
- Footer + account entry points to /pricing.

## i18n

New `billing.*` keys (downgrade, current, popular, save2mo, changeConfirm,
changeError, changeSuccess) and a new `pricingPage` block, across all 9 locales.

## Testing

- Go: change-plan handler (404/409/400/200 + admin-source 409) and the Stripe
  client request shape (GET-then-POST, proration, same-price no-op).
- Web: Pricing renders context-aware CTAs; a subscribed user upgrades via
  change-plan (not checkout); the account panel exposes change-plan for
  subscribers. Manual: drive a real test-mode upgrade end-to-end.
