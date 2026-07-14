# Billing Stripe Phase-2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Self-serve Stripe subscriptions that drive `users.plan_id` (assign on payment, revert to Free on cancel), config-gated so it's inert without keys — plus the two phase-1 hardening followups.

**Architecture:** A hand-rolled thin Stripe client behind a `Biller` interface (checkout + portal REST calls + HMAC webhook verification), a webhook that is the sole source of truth for subscription→plan, admin price mapping, and an account/pricing upgrade UI. See spec `docs/superpowers/specs/2026-07-14-billing-stripe-phase2-design.md`.

**Tech Stack:** Go stdlib (`crypto/hmac`, `crypto/sha256`, `net/http`, `database/sql`), Svelte 5 + TS, `html/template` admin.

## Global Constraints

- **No new Go dependency.** Stripe calls are stdlib `net/http` form-POSTs; webhook verification is stdlib `crypto/hmac`+`crypto/sha256`. Everything behind `Biller` for testing.
- **Config-gated:** `Service.biller` is non-nil only when `RELAYIUM_STRIPE_SECRET_KEY` is set. When nil: `/api/billing/*` and the webhook return 404/400; `/api/plans` marks tiers non-purchasable.
- **Webhook is the only authority** for granting/revoking a plan; client success is never trusted.
- **`plan_source='admin'` wins:** a subscription webhook must NOT change `plan_id` for a user whose `plan_source=='admin'` (it may still record status/end).
- Money in US cents (int64); bytes/seconds int64; no floats.
- Webhook verification: `Stripe-Signature: t=<ts>,v1=<hex>[,v1=...]`; signed payload `"<ts>.<rawbody>"`; `HMAC-SHA256(webhookSecret, signedPayload)` hex; `hmac.Equal` (constant-time) against each `v1`; reject if `|now-ts| > 300`.
- Locales that must all carry new i18n keys: `en, de, fr, ja, ko, zh` (`web/src/lib/i18n/`). `types.ts` enforces parity via `svelte-check`.
- Run Go tests from `server/`; web from `web/` (`npm run check`, `npx vitest run`).

---

### Task 1: planForUser error propagation (fail-open hardening)

**Files:** Modify `server/internal/account/plan_enforce.go`; Test `server/internal/account/plan_enforce_test.go`.

**Interfaces:**
- Produces: `planForUser(ctx, userID string) (Plan, error)` — `(freePlanFallback(), nil)` on not-found; `(freePlanFallback(), err)` on a real store error. `over{Storage,Traffic}` propagate that err. `overGlobalStorage` unchanged (reads settings). `planRetentionCap` becomes `(int64, error)` OR keeps returning int64 by swallowing (see step 3 — keep it int64, using the plan on error is fine since retention clamp erring toward the plan cap is safe; callers of planRetentionCap ignore errors). `currentMonthTraffic` unchanged.

- [ ] **Step 1: Write failing tests**

Add to `plan_enforce_test.go`:
```go
// errStore wraps a *SQLiteStore but forces GetUserByID to error, to prove the
// enforcement gates fail OPEN (allow) on a real DB error rather than silently
// applying the Free cap.
type errUserStore struct {
	Store
}
func (e errUserStore) GetUserByID(ctx context.Context, id string) (User, error) {
	return User{}, context.DeadlineExceeded
}

func TestOverHelpersFailOpenOnStoreError(t *testing.T) {
	st := newTestStore(t)
	svc := &Service{store: errUserStore{st}, cfg: Config{}, now: func() time.Time { return time.Unix(100, 0) }}
	if err := (&Service{store: st, cfg: Config{}, now: svc.now}).SeedPlans(context.Background()); err != nil {
		t.Fatal(err)
	}
	over, err := svc.overTraffic(context.Background(), "any", 1<<60)
	if err == nil {
		t.Fatal("a store error must propagate from overTraffic (so the gate fails open)")
	}
	_ = over // gate uses `err == nil && over`, so a non-nil err means "don't block"
}
```

- [ ] **Step 2: Run to verify it fails**
Run: `go test ./internal/account/ -run TestOverHelpersFailOpenOnStoreError -v` → FAIL (planForUser currently returns no error; overTraffic returns nil err).

- [ ] **Step 3: Implement**
In `plan_enforce.go`, change `planForUser` to return `(Plan, error)`:
```go
// planForUser resolves a user's billing tier. A genuine not-found falls back to
// Free with a nil error (a user with a bogus plan_id is legitimately Free); a
// real store error is propagated so the over* gates can fail OPEN rather than
// silently enforcing the Free cap against a paid user during a DB blip.
func (s *Service) planForUser(ctx context.Context, userID string) (Plan, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		if err == ErrNotFound {
			return freePlanFallback(), nil
		}
		return freePlanFallback(), err
	}
	p, ok, err := s.store.GetPlan(ctx, u.PlanID)
	if err != nil {
		return freePlanFallback(), err
	}
	if !ok {
		return freePlanFallback(), nil
	}
	return p, nil
}
```
Update `overStorage`/`overTraffic` to propagate:
```go
func (s *Service) overTraffic(ctx context.Context, userID string, add int64) (bool, error) {
	plan, err := s.planForUser(ctx, userID)
	if err != nil {
		return false, err
	}
	if plan.TrafficBytes <= 0 {
		return false, nil
	}
	used, err := s.currentMonthTraffic(ctx, userID)
	if err != nil {
		return false, err
	}
	return used+add > plan.TrafficBytes, nil
}
```
(and the analogous `overStorage`). `planRetentionCap` keeps returning `int64` but now must call the 2-return `planForUser`:
```go
func (s *Service) planRetentionCap(ctx context.Context, userID string) int64 {
	p, _ := s.planForUser(ctx, userID)
	return p.RetentionSecs
}
```
Fix any other `planForUser` callers to the new signature (grep `planForUser`).

- [ ] **Step 4: Verify** `go test ./internal/account/ -run 'Over|Plan|Upload|Download|ICE' 2>&1 | tail -8` → PASS; full package green.
- [ ] **Step 5: Commit** `git add -A && git commit -m "harden(billing): planForUser propagates store errors so gates fail open"`

---

### Task 2: admin numeric upper bounds

**Files:** Modify `server/internal/account/admin.go` (`handleAdminUpsertPlan` + settings POST); Test `server/internal/account/admin_plans_test.go`.

**Interfaces:** Produces a shared `const maxConfigMB = int64(1) << 30` (i.e. up to ~1 PiB after `<<20`) upper bound; a helper `nnMax(k string, maxVal int64) (int64, bool)` mirroring the existing `nn` but also requiring `n <= maxVal`.

- [ ] **Step 1: Failing test**
Add to `admin_plans_test.go`:
```go
func TestAdminUpsertPlanRejectsOverflowingSize(t *testing.T) {
	ts, _, store, mail := newAdminSettingsServer(t) // match the real harness used by sibling tests
	admin := adminLogin(t, ts, store, mail)         // match the real helper
	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"999999999999999999"}, // *<<20 overflows int64
		"traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"sort_order": {"0"}, "active": {"1"},
	}
	req, _ := http.NewRequest("POST", ts.URL+"/admin/plans", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", ts.URL) // csrfGuard
	req.AddCookie(admin)
	resp, _ := ts.Client().Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("overflowing storage_mb = %d, want 400", resp.StatusCode)
	}
}
```
(Read `admin_plans_test.go` for the actual server/login helper names and match them.)

- [ ] **Step 2: Run → FAIL** (currently 302, value wraps).
- [ ] **Step 3: Implement** In `handleAdminUpsertPlan`, bound the MB/GB/day fields with a sane max before shifting (e.g. `storageMB` and `trafficGB` each `<= maxConfigMB` where `maxConfigMB = 1<<30`, `retDays <= 100*365`), returning 400 if exceeded. Apply the same bound to the settings POST's `*_mb` fields (`storage_disk_cap_mb`, `max_file_size_mb`, `daily_quota_mb`). Keep the existing non-negative checks.
- [ ] **Step 4: Verify** `go test ./internal/account/ -run 'Admin' 2>&1 | tail -5` → PASS.
- [ ] **Step 5: Commit** `git commit -am "harden(billing): reject overflowing admin size inputs before shift"`

---

### Task 3: Stripe schema + model fields + store methods

**Files:** Modify `server/internal/account/sqlite.go` (ALTERs, planCols/scanPlan/UpsertPlan, user SELECTs/scan, new methods), `server/internal/account/store.go` (struct fields + interface); Test `server/internal/account/stripe_store_test.go` (create).

**Interfaces:**
- `Plan` += `StripePriceMonthlyID, StripePriceYearlyID string`.
- `User` += `StripeCustomerID, SubscriptionStatus, PlanSource string; SubscriptionEnd int64`.
- `SetUserStripeCustomer(ctx, userID, customerID string) error`
- `GetUserByStripeCustomer(ctx, customerID string) (User, bool, error)`
- `SetUserSubscription(ctx, userID, planID, status string, end int64, source string) error` — one UPDATE of plan_id+subscription_status+subscription_end+plan_source.
- `PlanByStripePrice(ctx, priceID string) (Plan, bool, error)` — matches either monthly or yearly price id (priceID non-empty).
- `SetUserPlanAdmin(ctx, userID, planID string) error` — like SetUserPlan but also sets plan_source='admin', subscription cleared. (Admin path uses this; the plain `SetUserPlan` stays for internal use or is replaced — grep callers.)

- [ ] **Step 1: Failing test** (`stripe_store_test.go`): round-trip the plan price ids via UpsertPlan/GetPlan; SetUserStripeCustomer then GetUserByStripeCustomer returns the user; SetUserSubscription sets all four fields (verify via GetUserByID); PlanByStripePrice("price_x") finds the plan whose monthly OR yearly id is "price_x"; a distinct customer id → not found. Use `newTestStore(t)`.
- [ ] **Step 2: Run → FAIL** (methods/fields undefined).
- [ ] **Step 3: Implement**
Add ALTERs (idempotent slice): the 6 columns from the spec §Store. Extend `planCols` + `scanPlan` + `UpsertPlan` INSERT/args with the two price-id columns (placeholders count +2). Add the 4 new user columns to EVERY user-loading SELECT + scan (the 3 loaders from phase-1 Task 2 — by-email/by-canonical/by-id — plus verify the admin list, Task 7 handles that). Implement the 5 new methods (all parameterized). `PlanByStripePrice`: `SELECT ... FROM plans WHERE (stripe_price_monthly_id=? OR stripe_price_yearly_id=?) AND ?<>''` (guard empty). `SetUserSubscription`: single UPDATE. Add all to the `Store` interface.
- [ ] **Step 4: Verify** full package green (watch scan-arity).
- [ ] **Step 5: Commit** `git commit -am "feat(billing): Stripe customer/subscription columns + plan price ids + store methods"`

---

### Task 4: Biller interface, thin Stripe client, webhook verification, config wiring

**Files:** Create `server/internal/account/stripe.go`; Modify `server/internal/account/service.go` (Config fields + `biller Biller` + wiring in the constructor), `server/main.go` (flags); Test `server/internal/account/stripe_test.go`.

**Interfaces:** the `Biller` interface, `CheckoutInput`, `WebhookEvent` exactly as in the spec §Biller. `NewStripeClient(secretKey, webhookSecret, portalConfig string) *stripeClient`. `Service.biller Biller` (nil when unconfigured).

- [ ] **Step 1: Failing tests** (`stripe_test.go`) — focus on `VerifyWebhook` (pure, no network):
```go
func signStripe(secret, payload string, ts int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.%s", ts, payload)))
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}
func TestVerifyWebhookAcceptsValidRejectsTampered(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1"}}}`
	sig := signStripe("whsec_abc", body, 1000)
	if _, err := c.VerifyWebhook([]byte(body), sig, 1000); err != nil {
		t.Fatalf("valid sig rejected: %v", err)
	}
	// tampered body
	if _, err := c.VerifyWebhook([]byte(body+" "), sig, 1000); err == nil {
		t.Fatal("tampered payload accepted")
	}
	// expired (>300s)
	if _, err := c.VerifyWebhook([]byte(body), sig, 1000+301); err == nil {
		t.Fatal("stale timestamp accepted")
	}
	// wrong secret
	bad := NewStripeClient("sk_test", "whsec_other", "")
	if _, err := bad.VerifyWebhook([]byte(body), sig, 1000); err == nil {
		t.Fatal("wrong-secret sig accepted")
	}
}
func TestVerifyWebhookMultipleV1OneValid(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"customer.subscription.deleted","data":{"object":{"customer":"cus_9","status":"canceled"}}}`
	good := signStripe("whsec_abc", body, 2000) // "t=2000,v1=<good>"
	multi := good + ",v1=deadbeef"
	if _, err := c.VerifyWebhook([]byte(body), multi, 2000); err != nil {
		t.Fatalf("one valid v1 among many should pass: %v", err)
	}
}
func TestVerifyWebhookParsesEventProjection(t *testing.T) {
	c := NewStripeClient("sk_test", "whsec_abc", "")
	body := `{"type":"checkout.session.completed","data":{"object":{"customer":"cus_1","subscription":"sub_1","client_reference_id":"user_42"}}}`
	ev, err := c.VerifyWebhook([]byte(body), signStripe("whsec_abc", body, 3000), 3000)
	if err != nil { t.Fatal(err) }
	if ev.Type != "checkout.session.completed" || ev.CustomerID != "cus_1" || ev.ClientRefUserID != "user_42" {
		t.Fatalf("bad projection: %+v", ev)
	}
}
```

- [ ] **Step 2: Run → FAIL** (stripe.go absent).
- [ ] **Step 3: Implement** `stripe.go`:
  - `Biller` interface + `CheckoutInput` + `WebhookEvent` (spec).
  - `stripeClient{secretKey, webhookSecret, portalConfig string; http *http.Client; base string}` with `base = "https://api.stripe.com"` (overridable in tests via an unexported field for the two network methods — those are integration-tested lightly; the webhook verify is the heavily-tested part).
  - `VerifyWebhook(payload []byte, sigHeader string, now int64) (WebhookEvent, error)`: parse `t=` and all `v1=` from the header (split on `,`, then `=`); `strconv` the ts; if `abs(now-ts) > 300` → error; compute `expected = hex(HMAC-SHA256(webhookSecret, "<ts>.<payload>"))`; loop the v1 values, `hmac.Equal([]byte(v1), []byte(expected))`; if none match → error. Then JSON-unmarshal `payload` into an envelope struct projecting `type`, `data.object.{customer, subscription, id (price via items — see note), client_reference_id, status, current_period_end}` into `WebhookEvent`. NOTE on price: for `customer.subscription.*` the price id is at `data.object.items.data[0].price.id`; for `checkout.session.completed` there is no line price on the session — resolve the plan at handler time from the subscription via a follow-up, OR (simpler, chosen) include the price on both by having checkout set `client_reference_id=userID` and, for subscription events, read `items.data[0].price.id`; for `checkout.session.completed` set `PriceID=""` and let the handler treat completion as "active, resolve plan on the subsequent subscription.updated event" — SO the completion handler only binds customer+userID, and the subscription.updated/created event (Stripe always sends one) assigns the plan. Document this two-step. Parse defensively (missing fields → zero values, never panic).
  - `CreateCheckoutSession`/`CreatePortalSession`: `url.Values` form POST to `base+"/v1/checkout/sessions"` / `/v1/billing_portal/sessions"` with `Authorization: Bearer <secretKey>`, parse `{"url":"..."}` from the JSON response; non-2xx → error with the Stripe error body.
  - `service.go`: `Config` += `StripeSecretKey, StripeWebhookSecret, StripePortalConfig string`; in the constructor, `if cfg.StripeSecretKey != "" { s.biller = NewStripeClient(...) }`.
  - `main.go`: three `flag.String` with `envStr("RELAYIUM_STRIPE_*", "")` defaults, passed into `account.Config`.
- [ ] **Step 4: Verify** `go test ./internal/account/ -run 'Webhook|Stripe' -v 2>&1 | tail -20` → PASS; `go build ./...` clean.
- [ ] **Step 5: Commit** `git commit -am "feat(billing): Biller interface + thin Stripe client + webhook HMAC verification"`

---

### Task 5: billing endpoints (checkout, portal) + GET /api/plans + /api/me extension

**Files:** Create `server/internal/account/billing.go`; Modify `server/internal/account/handlers.go` (routes), the `/api/me` handler; Test `server/internal/account/billing_test.go`.

**Interfaces:** consumes `Biller`, the store methods (Task 3), `RequireSession`. A `fakeBiller` test double implementing `Biller` with recorded inputs + canned outputs.

- [ ] **Step 1: Failing tests** (`billing_test.go`, using a `fakeBiller`): checkout unconfigured (`biller==nil`) → 404; checkout for a plan with no monthly price id → 400; checkout happy path → 200 `{url}` and the fakeBiller received the plan's monthly price id + the user's email/ref; portal without a customer id → 404; portal happy path → 200 `{url}`; `GET /api/plans` (public) returns active plans with `purchasable` true only when biller set AND the tier has a price id; `/api/me` includes `planId` + `subscriptionStatus`.
- [ ] **Step 2: Run → FAIL** (routes 404 for the wrong reason / handlers absent).
- [ ] **Step 3: Implement** `billing.go`:
  - `handleBillingCheckout(w,r,u)`: `if s.biller == nil { 404 }`; decode `{planId, cycle}`; `GetPlan`; pick `StripePriceMonthlyID`/`YearlyID` by cycle; `if priceID=="" { 400 }`; build `CheckoutInput{PriceID, CustomerID: u.StripeCustomerID, CustomerEmail: u.Email, ClientRefUserID: u.ID, SuccessURL: cfg.BaseURL+"/?billing=success", CancelURL: cfg.BaseURL+"/?billing=cancel"}`; `url, err := s.biller.CreateCheckoutSession(...)`; `writeJSON({url})`.
  - `handleBillingPortal(w,r,u)`: `if s.biller==nil || u.StripeCustomerID=="" { 404 }`; `CreatePortalSession(u.StripeCustomerID, cfg.BaseURL)`; `{url}`.
  - `handlePublicPlans(w,r)`: `ListPlans`, filter `Active`, project to `{id,name,storageBytes,trafficBytes,retentionSecs,priceMonthly,priceYearly, purchasableMonthly: biller!=nil && StripePriceMonthlyID!="", purchasableYearly: ...}`. No secrets.
  - Extend `/api/me` (read the existing handler) to add `planId, subscriptionStatus, subscriptionEnd, hasBilling: u.StripeCustomerID!=""`.
  - Routes in `handlers.go`: `POST /api/billing/checkout` + `POST /api/billing/portal` behind `RequireSession`; `GET /api/plans` public (like `/api/files/{id}/meta` is public). All under `csrfGuard` except GET.
- [ ] **Step 4: Verify** `go test ./internal/account/ -run 'Billing|Plans|Me' 2>&1 | tail -8` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(billing): checkout + portal endpoints, public /api/plans, /api/me plan fields"`

---

### Task 6: Stripe webhook handler

**Files:** Modify `server/internal/account/billing.go` (handler) + `handlers.go` (route); Test `server/internal/account/webhook_test.go`.

**Interfaces:** consumes `Biller.VerifyWebhook`, `GetUserByStripeCustomer`, `SetUserStripeCustomer`, `SetUserSubscription`, `PlanByStripePrice`.

- [ ] **Step 1: Failing tests** (`webhook_test.go`, real webhook body signed with the fake/real secret): 
  - unconfigured (`biller==nil`) → 404;
  - bad signature → 400 and no state change;
  - `checkout.session.completed` with `client_reference_id=<userID>` + `customer=cus_1` → user's `stripe_customer_id` set to `cus_1` (plan not yet changed — assignment happens on the subscription event);
  - `customer.subscription.updated` status `active`, price = plan `pro`'s monthly id, customer `cus_1` (already bound) → user's plan becomes `pro`, status `active`, source `stripe`;
  - `customer.subscription.updated` status `past_due` → user reverts to `free`;
  - `customer.subscription.deleted` → user `free`, status `canceled`;
  - a user with `plan_source='admin'` (set via SetUserPlanAdmin) receiving a `subscription.updated` for `pro` → plan_id STAYS at the admin value (not overridden), though status/end may update;
  - idempotent: delivering the same `subscription.updated` twice leaves the same final state.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `handleStripeWebhook(w,r)`: `if s.biller==nil { 404 }`; read the RAW body (`io.ReadAll`, cap at e.g. 1<<20); `ev, err := s.biller.VerifyWebhook(body, r.Header.Get("Stripe-Signature"), s.now().Unix())`; on err → 400. Dispatch by `ev.Type`:
  - `checkout.session.completed`: if `ev.ClientRefUserID!=""` → `SetUserStripeCustomer(ev.ClientRefUserID, ev.CustomerID)`. (Plan assignment deferred to the subscription event, which Stripe sends alongside.) 200.
  - `customer.subscription.updated`/`.created`: `u, ok := GetUserByStripeCustomer(ev.CustomerID)`; if !ok → 200 ignore. If `u.PlanSource=="admin"` → update only status/end via `SetUserSubscription(u.ID, u.PlanID, ev.Status, ev.CurrentPeriodEnd, "admin")` (keep plan_id + admin source) and 200. Else: if status ∈ {active,trialing} and `PlanByStripePrice(ev.PriceID)` resolves plan P → `SetUserSubscription(u.ID, P.ID, ev.Status, ev.CurrentPeriodEnd, "stripe")`; otherwise (inactive status or unresolved price) → `SetUserSubscription(u.ID, "free", ev.Status, ev.CurrentPeriodEnd, "stripe")`. 200.
  - `customer.subscription.deleted`: user by customer → `SetUserSubscription(u.ID, "free", "canceled", ev.CurrentPeriodEnd, "stripe")` unless admin-source (then leave plan). 200.
  - default → 200 ignore.
  Route: `POST /api/stripe/webhook` mounted OUTSIDE csrfGuard and RequireSession (raw, unauthenticated, signature-authenticated). Confirm the mux lets a raw POST through without CSRF (read csrfGuard — it checks Origin on state-changing methods; Stripe sends no Origin, so csrfGuard would ALLOW it (no Origin = not mismatched) — but to be safe mount it on a path csrfGuard skips, or confirm csrfGuard's "Origin present AND mismatched" logic lets a no-Origin POST pass. Verify and document.)
- [ ] **Step 4: Verify** `go test ./internal/account/ -run 'Webhook' -v 2>&1 | tail -20` → PASS; full package + `-race` green.
- [ ] **Step 5: Commit** `git commit -am "feat(billing): Stripe webhook — assign plan on subscription, revert on cancel, admin-source wins"`

---

### Task 7: admin price mapping + subscription visibility

**Files:** Modify `server/internal/account/admin.go` (upsert-plan price fields, user-list source; `SetUserPlanAdmin` on the assign route), `admin_templates.go`, `sqlite.go` (admin list query += subscription_status/plan_source); Test `server/internal/account/admin_plans_test.go`.

- [ ] **Step 1: Failing test:** posting `/admin/plans` with `stripe_price_monthly_id=price_M` persists it (GetPlan shows it); the admin user-list view-model carries `subscription_status`/`plan_source`; assigning a plan via `/admin/users/plan` sets `plan_source='admin'` (GetUserByID shows it).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:** add `stripe_price_monthly_id`/`_yearly_id` text inputs to the plan edit form + parse them in `handleAdminUpsertPlan` into the `Plan` (no numeric validation — free-form Stripe ids, trimmed). Change `handleAdminSetUserPlan` to call `SetUserPlanAdmin` (sets source=admin). Add `subscription_status`+`plan_source` to the admin user-list SELECT + `AdminUserRow` + the row display.
- [ ] **Step 4: Verify** `go test ./internal/account/ -run 'Admin' 2>&1 | tail -5` → PASS.
- [ ] **Step 5: Commit** `git commit -am "feat(billing): admin plan price mapping + subscription/source visibility"`

---

### Task 8: Pricing.svelte + upgrade→checkout

**Files:** Create `web/src/lib/Pricing.svelte`; Test `web/src/lib/Pricing.test.ts` (vitest). (Route wiring: mount it wherever the SPA renders sub-pages — read how existing pages like the guides/cli pages are routed and mirror; if a dedicated `/pricing` route is heavy, render Pricing inside the Account panel and/or a modal — pick the lightest integration that shows tiers + upgrade.)

- [ ] **Step 1: Failing test:** with a mocked `fetch('/api/plans')` returning two tiers (one `purchasableMonthly:true`, one `false`), Pricing renders both, a monthly/yearly toggle switches the displayed price, the purchasable tier's Upgrade button is enabled and (when clicked) POSTs `/api/billing/checkout` with `{planId, cycle}` then sets `location.href`, and the non-purchasable tier's button is disabled.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `Pricing.svelte`: `onMount` fetch `/api/plans`; `$state` monthly/yearly; render tier cards (name, formatted price cents→"$x.xx", storage/traffic/retention formatted via existing byte helpers if any); Upgrade button calls a `checkout(planId, cycle)` that POSTs and redirects; disabled + note when not purchasable. Use the i18n keys from Task 10 (stub English inline first, wire keys in Task 10). Escape nothing via `{@html}`.
- [ ] **Step 4: Verify** `npx vitest run src/lib/Pricing.test.ts 2>&1 | tail -8` → PASS; `npm run check` clean.
- [ ] **Step 5: Commit** `git commit -am "feat(web): Pricing component with monthly/yearly toggle + Stripe checkout"`

---

### Task 9: Account panel plan/upgrade/manage + billing return

**Files:** Modify `web/src/lib/Account.svelte`; Test (extend an existing Account test or add `Account.billing.test.ts`).

- [ ] **Step 1: Failing test:** with `/api/me` mocked to a free user, the panel shows the plan name + an Upgrade control; with a subscribed user (`hasBilling:true`), it shows a "Manage billing" button that POSTs `/api/billing/portal` and redirects; the `?billing=success` URL param shows a success banner.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement:** read `Account.svelte`; add a plan/usage section (reuse `/api/me` + `/api/stats`); Upgrade opens Pricing (modal or inline); Manage-billing → portal redirect; parse `location.search` for `billing=success|cancel` on mount → banner. Follow the component's existing fetch/error style.
- [ ] **Step 4: Verify** vitest + `npm run check` green.
- [ ] **Step 5: Commit** `git commit -am "feat(web): account panel plan status, upgrade, manage-billing, checkout return"`

---

### Task 10: i18n keys across all locales

**Files:** Modify `web/src/lib/i18n/{en,de,fr,ja,ko,zh}.ts` + `types.ts`.

- [ ] **Step 1:** Add a `billing` key group to `types.ts` (the type that all locales satisfy) with every string/function used by Pricing.svelte + Account.svelte billing UI (e.g. `billing: { pricing, perMonth, perYear, currentPlan, upgrade, manageBilling, checkoutSuccess, checkoutCancel, notAvailable, storage, traffic, retention, free, ... }`).
- [ ] **Step 2:** Implement the group in `en.ts` (source of truth), then translate into `de/fr/ja/ko/zh` following each file's existing tone (these files ARE fully translated — match that; do not English-fallback). Replace the inline English stubs in Pricing/Account with `t.billing.*`.
- [ ] **Step 3: Verify** `npm run check` → 0 errors (proves every locale satisfies the `types.ts` billing group), `npx vitest run 2>&1 | tail -5` green.
- [ ] **Step 4: Commit** `git commit -am "i18n(billing): pricing/account billing strings across all six locales"`

---

### Task 11: activation docs + full-suite verification

**Files:** Modify `README.md` (+ `docs/` self-host if present); Test: none new — this task is the final green-gate.

- [ ] **Step 1:** Add a README "Enabling payments (Stripe)" section: the env vars (`RELAYIUM_STRIPE_SECRET_KEY`, `_WEBHOOK_SECRET`, optional `_PORTAL_CONFIG`), creating 4 Products×2 Prices, registering the `/api/stripe/webhook` endpoint for `checkout.session.completed`+`customer.subscription.*`, and pasting each Price id into the matching plan in `/admin`. State that with the keys unset the whole feature is inert.
- [ ] **Step 2: Full verification:**
```bash
cd server && go build ./... && go vet ./... && go test ./... -race 2>&1 | tail -20
cd ../web && npm run check && npx vitest run 2>&1 | tail -6
```
All green.
- [ ] **Step 3: Commit** `git commit -am "docs(billing): Stripe activation guide; phase-2 verification"`

---

## Self-Review Notes
- Spec coverage: config-gate (T4/T5), Biller+webhook verify (T4), schema/store (T3), checkout/portal/plans/me (T5), webhook assign/revert/admin-wins/idempotent (T6), admin mapping+visibility (T7), pricing UI (T8), account UI (T9), i18n (T10), docs (T11), hardening (T1/T2). All mapped.
- Security: webhook is sole authority (T6), signature verified constant-time + replay window (T4), no secrets in `/api/plans` or client, admin-source not clobbered (T6), config-gated so inert without keys.
- Integration seams flagged for the implementer to confirm against real code: `/api/me` handler shape, csrfGuard behavior for the no-Origin webhook POST, admin harness/login helper names, SPA page/route mounting, byte-format helpers, the exact user-loading SELECTs.
