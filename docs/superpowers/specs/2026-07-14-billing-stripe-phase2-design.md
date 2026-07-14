# Billing Stripe Phase-2 — Self-Serve Subscriptions + Hardening

**Date:** 2026-07-14
**Status:** Approved (autonomous, per owner delegation "do it, follow your recommendations, no questions")
**Upstream:** [2026-07-06-billing-plans-phase1-design.md](./2026-07-06-billing-plans-phase1-design.md) (plans/enforcement must exist — they do, shipped 2026-07-14).

## Goal & boundary

Let a signed-in user upgrade their plan themselves via Stripe Checkout, manage/cancel via the Stripe Billing Portal, and have their `users.plan_id` driven automatically by their subscription state (assigned on payment, reverted to `free` on cancel/lapse). Admin maps each `plans` tier to Stripe price objects. Everything is **config-gated**: with no Stripe keys the whole surface is inert (billing endpoints 404, no upgrade buttons), exactly like the existing Google-OAuth / SMTP / TURN integrations.

**In scope:** Stripe Checkout (subscription mode) + Billing Portal + signed webhook; `plans.stripe_price_{monthly,yearly}_id`; `users.stripe_customer_id` + subscription status/period; public `GET /api/plans`; account-panel upgrade/manage UI + a pricing display (6-language i18n); admin price-mapping + subscription visibility. Plus the phase-1 opus-review hardening followups.

**Out of scope (phase-3+):** metered/usage overage billing, proration UI, promo codes, tax config, multiple currencies, dunning emails beyond Stripe's own, annual→monthly proration handling beyond what the Portal does. **Overage policy this phase:** a lapsed/cancelled subscription reverts the user to `free`, whose phase-1 caps then apply — no separate overage charge.

## Design decisions (owner-delegated)

1. **No Stripe SDK dependency.** A thin hand-rolled HTTP client (`internal/account/stripe.go`) makes exactly two REST calls (create Checkout Session, create Billing Portal Session) as `application/x-www-form-urlencoded` POSTs to `api.stripe.com`, and verifies webhooks with a hand-rolled implementation of Stripe's documented scheme. All behind a `Biller` interface so tests use a fake and never hit the network. Rationale: keeps the repo dependency-light (its established style), avoids a network-dependent `go get`, and the webhook verifier — the one security-critical piece — is small, standard HMAC-SHA256, and exhaustively tested.
2. **Webhook is the source of truth.** Client-side checkout success is never trusted to grant a plan. Only a verified `checkout.session.completed` / `customer.subscription.*` webhook mutates `users.plan_id`/subscription. The success redirect just shows "thanks, provisioning…".
3. **Subscription drives plan_id.** On active subscription → `plan_id` = the plan mapped to the subscription's price. On cancel/unpaid/deleted → `plan_id` = `free`. Admin manual assignment still works and is recorded as `plan_source='admin'` so a webhook for a manually-comped account doesn't fight the admin (see §Store).
4. **Config-gated.** `RELAYIUM_STRIPE_SECRET_KEY` empty ⇒ `Biller` is nil ⇒ `/api/billing/*` return 404 and the webhook returns 400; the pricing UI renders tiers but upgrade buttons are hidden/disabled with a "not yet available" note.

## Architecture

### Config (service.go `Config` + main.go flags, settings.go untouched)
New env/flags (empty = disabled), following the existing `envStr` pattern:
- `RELAYIUM_STRIPE_SECRET_KEY` (`-stripe-secret-key`) — `sk_...`
- `RELAYIUM_STRIPE_WEBHOOK_SECRET` (`-stripe-webhook-secret`) — `whsec_...`
- `RELAYIUM_STRIPE_PORTAL_CONFIG` (`-stripe-portal-config`, optional) — a Billing Portal configuration id; empty uses the Stripe account default.
The `Service` gets a `biller Biller` field, non-nil only when the secret key is set.

### `Biller` interface (`internal/account/stripe.go`)
```go
type Biller interface {
    CreateCheckoutSession(ctx context.Context, in CheckoutInput) (url string, err error)
    CreatePortalSession(ctx context.Context, customerID, returnURL string) (url string, err error)
    VerifyWebhook(payload []byte, sigHeader string, now int64) (WebhookEvent, error)
}
type CheckoutInput struct {
    PriceID, CustomerID, CustomerEmail, ClientRefUserID, SuccessURL, CancelURL string
}
type WebhookEvent struct {
    Type string // "checkout.session.completed" | "customer.subscription.updated" | "customer.subscription.deleted"
    // Parsed, minimal projection of the fields we act on:
    CustomerID, SubscriptionID, PriceID, Status, ClientRefUserID string
    CurrentPeriodEnd int64
}
```
`stripeClient` is the real impl (holds secret key + webhook secret + `*http.Client`). `VerifyWebhook` parses `Stripe-Signature: t=<ts>,v1=<hex>`, recomputes `HMAC-SHA256(secret, "<ts>.<payload>")`, `hmac.Equal` compares against every `v1`, and rejects if `|now-ts| > 300s` (replay window). Then it JSON-parses the event envelope into `WebhookEvent`.

### Store / schema (sqlite.go + store.go)
Migrations (idempotent ALTER):
```sql
ALTER TABLE plans ADD COLUMN stripe_price_monthly_id TEXT NOT NULL DEFAULT '';
ALTER TABLE plans ADD COLUMN stripe_price_yearly_id  TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN stripe_customer_id      TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN subscription_status     TEXT NOT NULL DEFAULT '';   -- '', 'active', 'canceled', ...
ALTER TABLE users ADD COLUMN subscription_end        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN plan_source             TEXT NOT NULL DEFAULT '';   -- '', 'admin', 'stripe'
```
`Plan` gains `StripePriceMonthlyID`/`StripePriceYearlyID` (UpsertPlan + scanPlan + planCols extended). `User` gains `StripeCustomerID`/`SubscriptionStatus`/`SubscriptionEnd`/`PlanSource`. New store methods:
- `SetUserStripeCustomer(ctx, userID, customerID)`
- `GetUserByStripeCustomer(ctx, customerID) (User, bool, error)`
- `SetUserSubscription(ctx, userID, planID, status string, end int64, source string)` — one UPDATE setting plan_id+subscription fields+plan_source together.
- `PlanByStripePrice(ctx, priceID) (Plan, bool, error)` — resolve a webhook's price → tier.
- `SetUserPlan` (existing) sets `plan_source='admin'` when called from the admin path (add a source param or a sibling `SetUserPlanAdmin`).

### Endpoints (handlers.go / a new billing.go)
- `POST /api/billing/checkout` (RequireSession): body `{planId, cycle}` (`cycle` ∈ `monthly|yearly`). 404 if `biller==nil`. Resolve the plan's price id for the cycle; 400 if the tier has no price id (free/unmapped). Reuse the user's `stripe_customer_id` if set, else pass `CustomerEmail`+`ClientRefUserID` so the webhook can bind the new customer. `SuccessURL = BaseURL + "/?billing=success"`, `CancelURL = BaseURL + "/?billing=cancel"`. Return `{url}`; the SPA does `location.href = url`.
- `POST /api/billing/portal` (RequireSession): 404 if unconfigured or the user has no `stripe_customer_id`; else create a portal session (`returnURL = BaseURL`) and return `{url}`.
- `POST /api/stripe/webhook` (unauthenticated, NOT behind csrfGuard/RequireSession; needs the RAW body): read the body bytes, `biller.VerifyWebhook`, then:
  - `checkout.session.completed`: bind `ClientRefUserID`→`stripe_customer_id` (from event.CustomerID), then treat like an active subscription (resolve price→plan, `SetUserSubscription(user, plan, "active", periodEnd, "stripe")`).
  - `customer.subscription.updated`: look up user by `CustomerID`; if `Status` ∈ active/trialing → assign mapped plan; else (past_due/unpaid/canceled) → revert to `free`. Update status+end.
  - `customer.subscription.deleted`: user by `CustomerID` → revert to `free`, status `canceled`.
  - Unknown event types → 200 ignore. Idempotent: all handlers are last-writer state-sets keyed by customer/user, so re-delivery is safe; additionally dedupe by storing the last processed `event.id` per customer is NOT required (state is convergent), but the webhook must return 200 quickly and 400 only on signature failure.
  - **Never** let a webhook override `plan_source='admin'`: if the target user's `plan_source=='admin'`, the subscription webhook updates subscription_status/end for record-keeping but does NOT change `plan_id` (admin comp wins). Document this.
- `GET /api/plans` (public, unauthenticated): returns active plans (id, name, storageBytes, trafficBytes, retentionSecs, priceMonthly, priceYearly, and whether each cycle is purchasable = has a price id AND biller configured). Powers the pricing UI. No secrets.
- Extend `GET /api/me` (or /api/stats) to include the current user's `planId`, `subscriptionStatus`, `subscriptionEnd`, and whether they have a Stripe customer (for the Manage-billing button).

### Frontend (web/src)
- **Pricing display** (`web/src/lib/Pricing.svelte`, used in a `/pricing` route and/or the account panel): fetch `GET /api/plans`, render the tiers with a monthly/yearly toggle (yearly shows the discount), each with an "Upgrade" button (signed-in) that `POST /api/billing/checkout` then redirects, or a "Sign in to upgrade" prompt otherwise. Current plan is marked. Buttons disabled with a note when `purchasable==false`.
- **Account panel** (`Account.svelte`): show current plan name + a compact usage summary (reuse `/api/stats`), an "Upgrade" button (opens pricing) for free users, and a "Manage billing" button (→ `/api/billing/portal`) for subscribed users. Handle the `?billing=success|cancel` return by showing a toast/banner.
- **i18n:** add a `billing` sub-object of keys to `en.ts` and every other locale (`de/fr/ja/ko/zh`) with real translations (follow the file's existing translated style; the repo translates fully, not English-fallback). `types.ts` updated so `svelte-check` enforces every locale has the keys.

### Admin (admin.go + admin_templates.go)
- Plan edit form gains `stripe_price_monthly_id` / `stripe_price_yearly_id` text inputs (persisted via the extended `UpsertPlan`).
- User list shows each user's `subscription_status` + `plan_source` (so an operator sees "pro (stripe, active)" vs "pro (admin)").

### Hardening followups (from phase-1 opus review — do FIRST, as their own tasks)
- **`planForUser` error propagation:** change it (and the `over*` helpers) so a real DB error propagates and the four enforcement gates fail **open** (allow), while a genuine not-found still falls back to Free. Concretely: `planForUser(ctx, userID) (Plan, error)` returning `(freePlanFallback(), nil)` on not-found but `(_, err)` on a real store error; `over*` return that err; the gates already use `err == nil && over`, so they fail open automatically. Update all callers.
- **Admin numeric upper bounds:** in `handleAdminUpsertPlan` (and the settings MB/GB inputs), reject values whose `<<20`/`<<30` would overflow int64 (e.g. cap MB at a sane max like `1<<40` bytes worth), so a fat-fingered huge value can't wrap negative (which reads as unlimited).

## Testing
- **Webhook verify:** valid signature accepted; tampered payload/sig rejected; expired timestamp (>300s) rejected; multiple `v1` sigs (one valid) accepted; missing header rejected. Constant-time compare used.
- **Webhook handlers (with a fake event):** `checkout.session.completed` binds customer + sets plan active; `subscription.updated` active→assigns, past_due→reverts to free; `subscription.deleted`→free; a webhook targeting an `admin`-sourced user does NOT change plan_id. Idempotent re-delivery is a no-op.
- **Endpoints:** checkout 404 when unconfigured; 400 for an unmapped/free plan; happy path (fake Biller) returns the fake URL and passes the right price id/customer. portal 404 without a customer id. `GET /api/plans` returns active tiers with correct `purchasable` flags. `/api/me` carries plan/subscription fields.
- **Store:** the new columns round-trip; `GetUserByStripeCustomer`; `PlanByStripePrice`; `SetUserSubscription` sets all fields atomically; admin-source not clobbered.
- **Hardening:** a store returning an error makes `overTraffic`/`overStorage` return an error (gates fail open); admin upper-bound rejects an overflowing value.
- **Frontend:** Pricing renders tiers from a mocked `/api/plans`; monthly/yearly toggle; purchasable=false disables the button; svelte-check passes with all locales carrying the new keys; vitest green.
- **Config-gated:** with `biller==nil`, endpoints 404 and `/api/plans` marks everything non-purchasable.

## Activation (owner action — NOT code; documented in README/self-host docs at the end)
Inert until the owner: creates a Stripe account; creates 4 Products with monthly+yearly Prices; sets `RELAYIUM_STRIPE_SECRET_KEY` + `RELAYIUM_STRIPE_WEBHOOK_SECRET`; registers the webhook endpoint (`/api/stripe/webhook`) in the Stripe dashboard for the `checkout.session.completed` + `customer.subscription.*` events; and pastes each Price id into the matching plan in `/admin`. A `docs/superpowers/specs` note + a README "Enabling payments" section lists these steps.
