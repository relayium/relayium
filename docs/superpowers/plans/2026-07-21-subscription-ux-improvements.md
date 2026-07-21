# Subscription UX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the `trialing`-subscription change-plan 500, make the `/me` plan card clearly show tier + cycle + next-charge state, and replace the bare `confirm()` plan-change flow with an in-app modal that previews the real prorated charge and effective date.

**Architecture:** Server exposes a new `POST /api/billing/preview` (Stripe upcoming-invoice) and enriches the `/api/me/usage` plan projection with cycle/price/scheduled fields; the Stripe client's subscription lookups stop filtering to `status=active` and upgrades charge the proration immediately. Front-end redesigns `PlanCard.svelte`, defaults the pricing cycle toggle to the user's current cycle, and adds a `ChangePlanModal.svelte` that fetches the preview before confirming.

**Tech Stack:** Go (net/http, hand-rolled Stripe REST client), Svelte 5 (runes), Vitest, TypeScript i18n with 9 languages.

## Global Constraints

- Stripe subscription events carry no interval field; a subscription's cycle is derived by matching its price id against the tier's two ids (`cycleOfPrice`, billing.go:91). Never assume a default cycle for `""`.
- The Stripe webhook is the SOLE authority that flips `plan_id`; change-plan/preview endpoints never write the plan themselves — they call Stripe and let the resulting `customer.subscription.updated` webhook reassign it. Client refreshes `/api/me` shortly after a 200.
- `plan_source == "admin"` must never be overridden by billing endpoints; change/preview already 409 when `PlanSource != "stripe"`.
- Money amounts cross the API as integer **cents**; the front-end formats/localizes.
- i18n: every new key must be added to all 9 languages (en/zh/ja/de/fr/ko/ar/es/pt). `npm run check` (svelte-check/tsc) fails the build on a missing/mistyped key — that is the forcing gate. English is the source of truth; translate idiomatically, not as a calque.
- Front-end tests use real `session`/`i18n` modules + `vi.stubGlobal("fetch", ...)`, mirroring `PlanCard.test.ts`.
- Server client tests mock Stripe with `httptest.NewServer` + `c.base = srv.URL`, mirroring `TestChangeSubscriptionPlanRequestShape` (stripe_test.go).

---

## Phase 1 — Bug fixes (ship first)

### Task 1: Stripe subscription lookups accept live non-active statuses

A `trialing` subscription is granted a plan by the webhook (billing.go:389) but is invisible to `ChangeSubscriptionPlan`/`ScheduleDowngrade`/`ReleaseSchedule`, which query `status=active` only (stripe.go:274,325,409). Changing plan as a trialing user 500s. Query `status=all` and pick the first subscription whose status is live.

**Files:**
- Modify: `server/internal/account/stripe.go` (three list calls + a new helper)
- Test: `server/internal/account/stripe_test.go`

**Interfaces:**
- Produces: `func liveSubStatus(status string) bool` (package-private) — true for `active`/`trialing`/`past_due`.

- [ ] **Step 1: Write the failing test**

Add to `stripe_test.go`:

```go
func TestChangeSubscriptionPlanFindsTrialingSubscription(t *testing.T) {
	var listQuery string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/v1/subscriptions") {
			listQuery = r.URL.RawQuery
			// A trialing subscription — the old status=active query would miss it.
			w.Write([]byte(`{"data":[{"id":"sub_t","status":"trialing","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`))
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/v1/subscriptions/sub_t" {
			w.Write([]byte(`{"id":"sub_t"}`))
			return
		}
		t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatalf("trialing subscription should be changeable: %v", err)
	}
	if strings.Contains(listQuery, "status=active") || !strings.Contains(listQuery, "status=all") {
		t.Fatalf("subscription list must query status=all, got %q", listQuery)
	}
}
```

(Ensure `strings` is imported in stripe_test.go — it already is.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestChangeSubscriptionPlanFindsTrialingSubscription -v`
Expected: FAIL — the list returns nothing under `status=active` (real code sends `status=active`), so `no active subscription`, and the query assertion fails.

- [ ] **Step 3: Add the helper and switch the three queries to status=all**

In `stripe.go`, add near the top (after imports):

```go
// liveSubStatus reports whether a Stripe subscription status is one we treat as
// a changeable live subscription. It must include every status the webhook
// grants a plan for (active, trialing — see handleStripeWebhook) plus past_due,
// so that a user shown as subscribed can always reach the change/schedule/
// release paths. A status=active-only query silently 500'd trialing users.
func liveSubStatus(status string) bool {
	switch status {
	case "active", "trialing", "past_due":
		return true
	default:
		return false
	}
}
```

In all three methods (`ChangeSubscriptionPlan`, `ScheduleDowngrade`, `ReleaseSchedule`), change the query builder from `q.Set("status", "active")` to `q.Set("status", "all")`, and after unmarshaling the list, select the first live subscription instead of blindly using `Data[0]`. For `ChangeSubscriptionPlan`, replace the `if len(list.Data) == 0 ...` block and the `subID := list.Data[0].ID` / `item := ...` lines with:

```go
	var subID string
	var item struct {
		ID    string `json:"id"`
		Price struct {
			ID string `json:"id"`
		} `json:"price"`
	}
	found := false
	for _, sub := range list.Data {
		if liveSubStatus(sub.Status) && len(sub.Items.Data) > 0 {
			subID = sub.ID
			item = sub.Items.Data[0]
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("stripe: no live subscription for customer %s", customerID)
	}
```

This requires adding `Status string json:"status"` to the `list.Data` struct literal in `ChangeSubscriptionPlan`. Apply the analogous change in `ScheduleDowngrade` (its `subs.Data` struct already lacks `Status` — add it, and pick the first `liveSubStatus` sub instead of `subs.Data[0]`) and in `ReleaseSchedule` (add `Status`, iterate to the first live sub, use its `Schedule`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestChangeSubscriptionPlan -v`
Expected: PASS (new test + existing `TestChangeSubscriptionPlanRequestShape`/`...NoopWhenSamePrice` still green).

- [ ] **Step 5: Run the whole package**

Run: `cd server && go test ./internal/account/`
Expected: `ok`.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/stripe.go server/internal/account/stripe_test.go
git commit -m "fix(billing): change/schedule/release find trialing and past_due subscriptions, not just active"
```

---

### Task 2: Checkout success/cancel returns to /me

**Files:**
- Modify: `server/internal/account/billing.go:53-54`
- Test: `server/internal/account/billing_test.go`

- [ ] **Step 1: Write the failing test**

Add to `billing_test.go`:

```go
func TestCheckoutSuccessURLReturnsToMe(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	fb := &fakeBiller{checkoutURL: "https://checkout.stripe.com/x"}
	svc.biller = fb
	cookie := signupAndLogin(t, ts, store, "a@b.c") // existing helper in billing_test.go
	seedPaidPlan(t, store)                            // existing helper: a "plus" plan with price ids
	res := postJSON(t, ts, cookie, "/api/billing/checkout", `{"planId":"plus","cycle":"monthly"}`)
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", res.StatusCode)
	}
	if !strings.HasSuffix(fb.lastCheckout.SuccessURL, "/me?billing=success") {
		t.Fatalf("success_url must land on /me, got %q", fb.lastCheckout.SuccessURL)
	}
}
```

Before writing, open `billing_test.go` and reuse the ACTUAL helper names it already uses to log in + seed a plan (e.g. the setup inside `TestCheckoutCreatesSession`). If the helper names differ from `signupAndLogin`/`seedPaidPlan`/`postJSON`, copy the exact setup those existing tests use instead — do not invent helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestCheckoutSuccessURLReturnsToMe -v`
Expected: FAIL — success URL ends with `/?billing=success`.

- [ ] **Step 3: Change the URLs**

In `billing.go`:

```go
		SuccessURL:      s.cfg.BaseURL + "/me?billing=success",
		CancelURL:       s.cfg.BaseURL + "/me?billing=cancel",
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestCheckout -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/billing.go server/internal/account/billing_test.go
git commit -m "fix(billing): return to /me after Stripe Checkout, not the home page"
```

---

## Phase 2 — Current-plan visibility

### Task 3: Enrich the /api/me/usage plan projection

Add the fields `PlanCard` needs from its "fresh" data source: billing cycle, yearly price, and the scheduled-downgrade target (id + name).

**Files:**
- Modify: `server/internal/account/handlers.go:492-502` (the `"plan"` map in `handleMeUsage`)
- Test: `server/internal/account/billing_test.go` (or a usage-focused test file if one exists)

**Interfaces:**
- Produces: `/api/me/usage`'s `plan` object gains `billingCycle` (string), `priceYearly` (int64 cents), `scheduledPlanId` (string), `scheduledPlanName` (string).

- [ ] **Step 1: Write the failing test**

Add a test that logs in a user on a yearly `plus` subscription with a scheduled downgrade to `free`, calls `/api/me/usage`, and asserts the new fields. Reuse the login/seed helpers already in `billing_test.go`:

```go
func TestMeUsageExposesCycleAndScheduledPlan(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	svc.biller = &fakeBiller{}
	cookie := /* existing login helper */
	seedPaidPlan(t, store) // "plus" with PriceYearly and price ids; and ensure a "free" plan row exists
	uid := /* the logged-in user's id from the helper */
	// Put the user on plus/yearly with a pending downgrade to free.
	must(store.SetUserSubscription(ctx, uid, "plus", "active", 1789999999, "stripe", "yearly", now))
	must(store.SetScheduledPlan(ctx, uid, "free"))

	body := getJSON(t, ts, cookie, "/api/me/usage")
	plan := body["plan"].(map[string]any)
	if plan["billingCycle"] != "yearly" {
		t.Fatalf("billingCycle: got %v", plan["billingCycle"])
	}
	if plan["scheduledPlanId"] != "free" || plan["scheduledPlanName"] == "" {
		t.Fatalf("scheduled fields: got %v / %v", plan["scheduledPlanId"], plan["scheduledPlanName"])
	}
	if _, ok := plan["priceYearly"]; !ok {
		t.Fatal("priceYearly missing")
	}
}
```

Adapt helper names to the real ones in `billing_test.go`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestMeUsageExposesCycleAndScheduledPlan -v`
Expected: FAIL — fields absent (nil).

- [ ] **Step 3: Add the fields in handleMeUsage**

Before the final `writeJSON` in `handleMeUsage`, resolve the scheduled plan's name:

```go
	// Scheduled-downgrade target name for the card's "pending downgrade" line.
	// Best-effort: an unresolvable id just yields an empty name, never an error.
	scheduledName := ""
	if u.ScheduledPlanID != "" {
		if sp, ok, _ := s.store.GetPlan(ctx, u.ScheduledPlanID); ok {
			scheduledName = sp.Name
		}
	}
```

Then extend the `"plan"` map:

```go
		"plan": map[string]any{
			"id":                 plan.ID,
			"name":               plan.Name,
			"storageBytes":       nonNegCap(plan.StorageBytes),
			"trafficBytes":       nonNegCap(plan.TrafficBytes),
			"retentionSecs":      nonNegCap(plan.RetentionSecs),
			"priceMonthly":       plan.PriceMonthly,
			"priceYearly":        plan.PriceYearly,
			"isTop":              isTop,
			"subscriptionStatus": u.SubscriptionStatus,
			"subscriptionEnd":    u.SubscriptionEnd,
			"billingCycle":       u.BillingCycle,
			"scheduledPlanId":    u.ScheduledPlanID,
			"scheduledPlanName":  scheduledName,
		},
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestMeUsageExposesCycleAndScheduledPlan -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/handlers.go server/internal/account/billing_test.go
git commit -m "feat(billing): expose billing cycle, yearly price, and scheduled downgrade on /api/me/usage"
```

---

### Task 4: Redesign PlanCard into an info card (+ i18n keys)

**Files:**
- Modify: `web/src/lib/usage.svelte.ts` (extend `PlanInfo`)
- Modify: `web/src/lib/PlanCard.svelte`
- Modify: `web/src/lib/i18n/types.ts` and all 9 `web/src/lib/i18n/<lang>.ts`
- Test: `web/src/lib/PlanCard.test.ts`

**Interfaces:**
- Consumes: `/api/me/usage` `plan.billingCycle|priceYearly|scheduledPlanId|scheduledPlanName` (Task 3).
- Produces: extended `PlanInfo` type; new `t.billing` keys: `cycleMonthly`/`cycleYearly` (badge), `renewsOn(date)`, `trialEndsOn(date)`, `pastDueNotice`, `canceledUntil(date)`, `changePlan` (CTA), `scheduledDowngradeRow(name, date)`.

- [ ] **Step 1: Extend the PlanInfo type**

In `usage.svelte.ts`, add to `PlanInfo`:

```ts
  priceYearly: number; // 美分
  billingCycle?: string; // 'monthly' | 'yearly' | ''（未知）
  scheduledPlanId?: string; // 排期期末降级的目标档 id，'' 无
  scheduledPlanName?: string; // 该目标档的展示名
```

- [ ] **Step 2: Add the i18n keys (type + all langs)**

In `i18n/types.ts` `billing` block, add:

```ts
    cycleMonthly: string; // 周期徽章：月付
    cycleYearly: string; // 周期徽章：年付
    changePlan: string; // 会员卡 CTA：更改套餐（可升可降可换周期）
    renewsOn: (date: string) => string; // active：下次续费 {date}
    trialEndsOn: (date: string) => string; // trialing：试用中 · {date} 到期
    pastDueNotice: string; // past_due：扣款失败 · 请更新支付方式
    canceledUntil: (date: string) => string; // canceled：已取消 · {date} 前有效
    scheduledDowngradeRow: (name: string, date: string) => string; // 已排期：{date} 期末降到 {name}
```

Add the English values to `i18n/en.ts` `billing`:

```ts
    cycleMonthly: "Monthly",
    cycleYearly: "Yearly",
    changePlan: "Change plan",
    renewsOn: (date) => `Renews ${date}`,
    trialEndsOn: (date) => `Trial · ends ${date}`,
    pastDueNotice: "Payment failed · update your payment method",
    canceledUntil: (date) => `Canceled · active until ${date}`,
    scheduledDowngradeRow: (name, date) => `Scheduled: downgrades to ${name} on ${date}`,
```

Add the Chinese values to `i18n/zh.ts` `billing`:

```ts
    cycleMonthly: "月付",
    cycleYearly: "年付",
    changePlan: "更改套餐",
    renewsOn: (date) => `下次续费 ${date}`,
    trialEndsOn: (date) => `试用中 · ${date} 到期`,
    pastDueNotice: "扣款失败 · 请更新支付方式",
    canceledUntil: (date) => `已取消 · ${date} 前有效`,
    scheduledDowngradeRow: (name, date) => `已排期：${date} 期末降到 ${name}`,
```

Add the same keys to the other 7 language files (`ja/de/fr/ko/ar/es/pt`), translated idiomatically into each language (English above is the source). `npm run check` fails until every file has all keys with matching types.

- [ ] **Step 3: Write the failing PlanCard tests**

In `PlanCard.test.ts`, extend the `plan()` factory defaults with `priceYearly: 0, billingCycle: "", scheduledPlanId: "", scheduledPlanName: ""`, then add:

```ts
it("yearly paid plan shows the yearly badge, price and renewal date", async () => {
  await mountWith(plan({
    id: "plus", name: "Plus", priceMonthly: 199, priceYearly: 1999,
    billingCycle: "yearly", subscriptionStatus: "active", subscriptionEnd: 1789999999,
  }));
  const text = target.textContent ?? "";
  expect(text).toContain("Yearly");
  expect(text).toContain("$19.99");
  expect(text).toMatch(/Renews/);
  expect(buttons()).toContain("Change plan");
});

it("shows the scheduled-downgrade row when one is pending", async () => {
  await mountWith(plan({
    id: "plus", name: "Plus", billingCycle: "monthly",
    subscriptionStatus: "active", subscriptionEnd: 1789999999,
    scheduledPlanId: "free", scheduledPlanName: "Free",
  }));
  expect(target.textContent ?? "").toMatch(/downgrades to Free/);
});

it("free plan shows no cycle badge and only an upgrade CTA", async () => {
  await mountWith(plan()); // free defaults
  expect(target.textContent ?? "").not.toContain("Yearly");
  expect(buttons()).not.toContain("Change plan");
});
```

- [ ] **Step 4: Run to verify they fail**

Run: `cd web && npx vitest run src/lib/PlanCard.test.ts`
Expected: FAIL — new assertions unmet (no badge/price/renewal/change CTA yet).

- [ ] **Step 5: Rewrite PlanCard.svelte body**

Replace the `{#if plan}` … `</section>` markup with the info-card layout. Add derived helpers in `<script>`:

```svelte
  const isPaid = $derived(!!plan && plan.priceMonthly > 0);
  const cycleLabel = $derived(
    plan?.billingCycle === "yearly" ? t.billing.cycleYearly
    : plan?.billingCycle === "monthly" ? t.billing.cycleMonthly : "",
  );
  const priceLine = $derived(() => {
    if (!plan || !isPaid) return "";
    const cents = plan.billingCycle === "yearly" ? plan.priceYearly : plan.priceMonthly;
    const suffix = plan.billingCycle === "yearly" ? t.billing.perYear : t.billing.perMonth;
    return `$${(cents / 100).toFixed(2)}${suffix}`;
  });
  const statusLine = $derived(() => {
    if (!plan) return "";
    switch (plan.subscriptionStatus) {
      case "active": return t.billing.renewsOn(subEnd);
      case "trialing": return t.billing.trialEndsOn(subEnd);
      case "past_due": return t.billing.pastDueNotice;
      case "canceled": return t.billing.canceledUntil(subEnd);
      default: return "";
    }
  });
  const scheduledLine = $derived(
    plan?.scheduledPlanId && plan.scheduledPlanName
      ? t.billing.scheduledDowngradeRow(plan.scheduledPlanName, subEnd) : "",
  );
```

Markup (keep the existing `.plan-card` shell and `onManageBilling`):

```svelte
{#if plan}
  <section class="plan-card">
    <div class="head">
      <h3>{t.billing.currentPlan}</h3>
      <span class="badge">{plan.name}{#if cycleLabel} · {cycleLabel}{/if}</span>
    </div>

    {#if priceLine()}<p class="price">{priceLine()}{#if statusLine()} · {statusLine()}{/if}</p>
    {:else if statusLine()}<p class="sub">{statusLine()}</p>{/if}

    <p class="perks">{t.me.plan.perks(cap(plan.storageBytes), cap(plan.trafficBytes), retention)}</p>

    {#if scheduledLine}<p class="sched">⏳ {scheduledLine}</p>{/if}

    <div class="actions">
      {#if plan.isTop}
        <span class="hint">{t.me.plan.topTier}</span>
      {:else}
        <button class="btn btn-primary" onclick={() => navigate("pricing")}>
          {isPaid ? t.billing.changePlan : t.billing.upgrade}
        </button>
      {/if}
      {#if isPaid}
        <button class="btn" disabled={portalBusy} onclick={onManageBilling}>{t.billing.manageBilling}</button>
      {/if}
    </div>
    {#if portalError}<p class="err">{portalError}</p>{/if}
  </section>
{/if}
```

Add `.price` and `.sched` styles alongside the existing ones:

```css
  .price { margin: var(--space-2) 0 0; color: var(--text-h); font-weight: 600; }
  .sched { margin: var(--space-3) 0 0; color: var(--text); font-size: var(--fs-xs); }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/PlanCard.test.ts && npm run check`
Expected: PASS + type-check clean (proves all 9 langs have the keys).

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/usage.svelte.ts web/src/lib/PlanCard.svelte web/src/lib/i18n
git commit -m "feat(web): redesign the plan card to show tier, cycle, price and renewal state"
```

---

## Phase 3 — Change experience

### Task 5: Extract the change-direction decision into a pure function

**Files:**
- Modify: `server/internal/account/billing.go` (extract from `handleBillingChangePlan:196-205`)
- Test: `server/internal/account/billing_test.go`

**Interfaces:**
- Produces: `func resolveChange(cur, target Plan, wantCycle string) (downgrade bool)`.

- [ ] **Step 1: Write the failing test**

```go
func TestResolveChangeDirection(t *testing.T) {
	plus := Plan{ID: "plus", PriceMonthly: 199}
	pro := Plan{ID: "pro", PriceMonthly: 999}
	// higher tier -> upgrade
	if resolveChange(plus, pro, "monthly") {
		t.Fatal("plus->pro should be an upgrade")
	}
	// lower tier -> downgrade
	if !resolveChange(pro, plus, "yearly") {
		t.Fatal("pro->plus should be a downgrade even billed yearly")
	}
	// same tier, monthly->yearly -> upgrade
	if resolveChange(plus, plus, "yearly") {
		t.Fatal("plus/mo->plus/yr should be an upgrade")
	}
	// same tier, yearly->monthly -> downgrade
	if !resolveChange(plus, plus, "monthly") {
		t.Fatal("plus/yr->plus/mo should be a downgrade")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestResolveChangeDirection -v`
Expected: FAIL — `resolveChange` undefined.

- [ ] **Step 3: Extract the function and call it from the handler**

Add to `billing.go`:

```go
// resolveChange decides whether moving the subscription from cur to target at
// wantCycle is a downgrade (defer to period end) or an upgrade (apply now).
// Tier direction outranks cycle: a lower-priced tier is always a downgrade even
// when the new cycle costs more up front. On the same tier only the cycle moved,
// and shortening the commitment (yearly->monthly) is the downgrade. Two distinct
// tiers that happen to share a monthly price fall through as "not a downgrade"
// (apply now) — the same choice the inline logic made. Kept in step with the
// front-end's plan-relation.ts.
func resolveChange(cur, target Plan, wantCycle string) (downgrade bool) {
	switch {
	case target.PriceMonthly != cur.PriceMonthly:
		return target.PriceMonthly < cur.PriceMonthly
	case target.ID == cur.ID:
		return wantCycle == "monthly"
	default:
		return false
	}
}
```

In `handleBillingChangePlan`, replace the inline `downgrade := false; if cur, ok, err := ...` block (billing.go:196-205) with:

```go
	downgrade := false
	if cur, ok, err := s.store.GetPlan(r.Context(), u.PlanID); err == nil && ok {
		downgrade = resolveChange(cur, plan, wantCycle)
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run 'TestResolveChangeDirection|Billing|Cycle'`
Expected: PASS (existing change-plan/cycle tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/billing.go server/internal/account/billing_test.go
git commit -m "refactor(billing): extract resolveChange so preview and change-plan share one direction rule"
```

---

### Task 6: Upgrades charge the proration immediately; add PreviewChange

**Files:**
- Modify: `server/internal/account/stripe.go` (`Biller` interface, `ChangeSubscriptionPlan` proration, new `PreviewChange`)
- Modify: `server/internal/account/billing_test.go` (`fakeBiller` gains `PreviewChange`)
- Test: `server/internal/account/stripe_test.go`

**Interfaces:**
- Produces: `Biller.PreviewChange(ctx context.Context, customerID, newPriceID string) (immediateChargeCents int64, err error)`.

- [ ] **Step 1: Write the failing tests**

Add to `stripe_test.go`:

```go
func TestChangeSubscriptionPlanChargesProrationNow(t *testing.T) {
	var prorationBehavior string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			w.Write([]byte(`{"data":[{"id":"sub_1","status":"active","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`))
			return
		}
		r.ParseForm()
		prorationBehavior = r.FormValue("proration_behavior")
		w.Write([]byte(`{"id":"sub_1"}`))
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	if err := c.ChangeSubscriptionPlan(context.Background(), "cus_1", "price_new"); err != nil {
		t.Fatal(err)
	}
	if prorationBehavior != "always_invoice" {
		t.Fatalf("upgrade must invoice the proration now, got %q", prorationBehavior)
	}
}

func TestPreviewChangeReturnsImmediateCharge(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/subscriptions"):
			w.Write([]byte(`{"data":[{"id":"sub_1","status":"active","items":{"data":[{"id":"si_1","price":{"id":"price_old"}}]}}]}`))
		case strings.HasPrefix(r.URL.Path, "/v1/invoices/upcoming"):
			if got := r.URL.Query().Get("subscription_proration_behavior"); got != "always_invoice" {
				t.Errorf("preview must use always_invoice, got %q", got)
			}
			w.Write([]byte(`{"amount_due":734}`))
		default:
			t.Errorf("unexpected %s", r.URL.Path)
		}
	}))
	defer srv.Close()
	c := NewStripeClient("sk_test", "whsec", "")
	c.base = srv.URL
	cents, err := c.PreviewChange(context.Background(), "cus_1", "price_new")
	if err != nil {
		t.Fatal(err)
	}
	if cents != 734 {
		t.Fatalf("want 734, got %d", cents)
	}
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && go test ./internal/account/ -run 'TestChangeSubscriptionPlanChargesProrationNow|TestPreviewChangeReturnsImmediateCharge' -v`
Expected: FAIL — proration is `create_prorations`; `PreviewChange` undefined (compile error).

- [ ] **Step 3: Add PreviewChange to the interface and both implementations**

In the `Biller` interface (stripe.go:22), add:

```go
	// PreviewChange returns the amount (cents) that switching the customer's live
	// subscription to newPriceID would charge immediately, via a Stripe upcoming-
	// invoice preview with the same always_invoice proration the real change uses.
	// Used by the confirmation modal so the operator sees the real number first.
	PreviewChange(ctx context.Context, customerID, newPriceID string) (immediateChargeCents int64, err error)
```

Change `ChangeSubscriptionPlan`'s proration line (stripe.go:309) to:

```go
	form.Set("proration_behavior", "always_invoice")
```

Add the client method (reuse the `findLiveSubscription` selection from Task 1 — factor the list+select into a small `func (c *stripeClient) liveSubscription(ctx, customerID) (subID, itemID, currentPriceID string, err error)` helper if it reduces duplication; otherwise inline the same status=all + liveSubStatus scan):

```go
// PreviewChange previews an upcoming invoice for switching the live subscription
// to newPriceID with always_invoice proration, returning amount_due in cents.
func (c *stripeClient) PreviewChange(ctx context.Context, customerID, newPriceID string) (int64, error) {
	subID, itemID, _, err := c.liveSubscription(ctx, customerID)
	if err != nil {
		return 0, err
	}
	q := url.Values{}
	q.Set("customer", customerID)
	q.Set("subscription", subID)
	q.Set("subscription_items[0][id]", itemID)
	q.Set("subscription_items[0][price]", newPriceID)
	q.Set("subscription_proration_behavior", "always_invoice")
	body, err := c.request(ctx, http.MethodGet, "/v1/invoices/upcoming?"+q.Encode(), nil)
	if err != nil {
		return 0, err
	}
	var inv struct {
		AmountDue int64 `json:"amount_due"`
	}
	if err := json.Unmarshal(body, &inv); err != nil {
		return 0, fmt.Errorf("stripe: preview invoice: parse response: %w", err)
	}
	return inv.AmountDue, nil
}
```

Add `liveSubscription` (extract the status=all list + `liveSubStatus` scan that Task 1 put in `ChangeSubscriptionPlan`; have `ChangeSubscriptionPlan` call it too so there is one copy). In `billing_test.go`, add to `fakeBiller`:

```go
	previewCents     int64
	previewErr       error
	lastPreviewPrice string
	previewCalls     int
```

```go
func (f *fakeBiller) PreviewChange(ctx context.Context, customerID, newPriceID string) (int64, error) {
	f.previewCalls++
	f.lastPreviewPrice = newPriceID
	return f.previewCents, f.previewErr
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/`
Expected: `ok` (new tests pass; the package compiles now that both Billers implement `PreviewChange`).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/stripe.go server/internal/account/stripe_test.go server/internal/account/billing_test.go
git commit -m "feat(billing): charge upgrade proration immediately and add PreviewChange (upcoming-invoice)"
```

---

### Task 7: POST /api/billing/preview endpoint

**Files:**
- Modify: `server/internal/account/billing.go` (new `handleBillingPreview`)
- Modify: `server/internal/account/handlers.go:161-164` (register route)
- Test: `server/internal/account/billing_test.go`

**Interfaces:**
- Consumes: `resolveChange` (Task 5), `Biller.PreviewChange` (Task 6), `u.SubscriptionEnd`, `plan.PriceMonthly|PriceYearly`.
- Produces: `POST /api/billing/preview` → JSON `{effective, immediateChargeCents, nextAmountCents, nextCycle, effectiveDate}`.

- [ ] **Step 1: Write the failing tests**

Add to `billing_test.go`:

```go
func TestBillingPreviewUpgradeShowsImmediateCharge(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	svc.biller = &fakeBiller{previewCents: 734}
	cookie := /* login helper */
	seedPaidPlan(t, store) // "plus" 199/1999, "pro" 999/9999, both with price ids; "free" exists
	uid := /* user id */
	must(store.SetUserStripeCustomer(ctx, uid, "cus_1"))
	must(store.SetUserSubscription(ctx, uid, "plus", "active", 1789999999, "stripe", "monthly", now))

	body := postJSONBody(t, ts, cookie, "/api/billing/preview", `{"planId":"pro","cycle":"yearly"}`)
	if body["effective"] != "now" {
		t.Fatalf("upgrade should be effective now, got %v", body["effective"])
	}
	if body["immediateChargeCents"].(float64) != 734 {
		t.Fatalf("immediate charge: got %v", body["immediateChargeCents"])
	}
	if body["nextCycle"] != "yearly" {
		t.Fatalf("nextCycle: got %v", body["nextCycle"])
	}
}

func TestBillingPreviewDowngradeIsPeriodEndNoCharge(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	svc.biller = &fakeBiller{previewCents: 999} // must be ignored on the downgrade path
	cookie := /* login helper */
	seedPaidPlan(t, store)
	uid := /* user id */
	must(store.SetUserStripeCustomer(ctx, uid, "cus_1"))
	must(store.SetUserSubscription(ctx, uid, "pro", "active", 1789999999, "stripe", "yearly", now))

	body := postJSONBody(t, ts, cookie, "/api/billing/preview", `{"planId":"plus","cycle":"monthly"}`)
	if body["effective"] != "period_end" {
		t.Fatalf("downgrade should be period_end, got %v", body["effective"])
	}
	if body["immediateChargeCents"].(float64) != 0 {
		t.Fatalf("downgrade must not charge now, got %v", body["immediateChargeCents"])
	}
	if body["effectiveDate"].(float64) != 1789999999 {
		t.Fatalf("effectiveDate should be the current period end, got %v", body["effectiveDate"])
	}
}

func TestBillingPreviewNoSubscription409(t *testing.T) {
	ts, svc, store, _ := newBillingServer(t)
	svc.biller = &fakeBiller{}
	cookie := /* login helper for a free user, no customer */
	seedPaidPlan(t, store)
	res := postJSON(t, ts, cookie, "/api/billing/preview", `{"planId":"pro","cycle":"monthly"}`)
	defer res.Body.Close()
	if res.StatusCode != http.StatusConflict {
		t.Fatalf("free user preview should 409, got %d", res.StatusCode)
	}
}
```

(`postJSONBody` = post + decode JSON into `map[string]any`; if `billing_test.go` lacks it, add a small local helper mirroring its existing `getJSON`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && go test ./internal/account/ -run TestBillingPreview -v`
Expected: FAIL — route/handler missing (404).

- [ ] **Step 3: Implement the handler**

Add to `billing.go`:

```go
// handleBillingPreview returns what changing to {planId,cycle} would do BEFORE
// the user commits: for an upgrade, the immediate prorated charge (via Stripe
// upcoming invoice) and the next full amount; for a downgrade, that it takes
// effect at period end with no charge now. Same auth/preconditions as
// change-plan; it performs no state change. amounts are cents.
func (s *Service) handleBillingPreview(w http.ResponseWriter, r *http.Request, u User) {
	if s.biller == nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var in struct {
		PlanID string `json:"planId"`
		Cycle  string `json:"cycle"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if u.StripeCustomerID == "" || u.PlanSource != "stripe" {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no_active_subscription"})
		return
	}
	plan, ok, err := s.store.GetPlan(r.Context(), in.PlanID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	wantCycle := "monthly"
	if in.Cycle == "yearly" {
		wantCycle = "yearly"
	}
	priceID := plan.StripePriceMonthlyID
	nextAmount := plan.PriceMonthly
	if wantCycle == "yearly" {
		priceID = plan.StripePriceYearlyID
		nextAmount = plan.PriceYearly
	}
	if priceID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "plan not purchasable"})
		return
	}
	downgrade := false
	if cur, ok, err := s.store.GetPlan(r.Context(), u.PlanID); err == nil && ok {
		downgrade = resolveChange(cur, plan, wantCycle)
	}
	resp := map[string]any{
		"effective":            "now",
		"immediateChargeCents": int64(0),
		"nextAmountCents":      nextAmount,
		"nextCycle":            wantCycle,
		"effectiveDate":        u.SubscriptionEnd,
	}
	if downgrade {
		resp["effective"] = "period_end"
		writeJSON(w, http.StatusOK, resp)
		return
	}
	cents, err := s.biller.PreviewChange(r.Context(), u.StripeCustomerID, priceID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	resp["immediateChargeCents"] = cents
	writeJSON(w, http.StatusOK, resp)
}
```

Register the route in `handlers.go` next to the other billing routes:

```go
	mux.HandleFunc("POST /api/billing/preview", s.RequireSession(s.handleBillingPreview))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run TestBillingPreview -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/billing.go server/internal/account/handlers.go server/internal/account/billing_test.go
git commit -m "feat(billing): add POST /api/billing/preview for pre-confirmation charge/effective preview"
```

---

### Task 8: Pricing page defaults to the current cycle and marks current plan+cycle

**Files:**
- Modify: `web/src/lib/Pricing.svelte`
- Test: `web/src/lib/Pricing.test.ts`

- [ ] **Step 1: Write the failing test**

In `Pricing.test.ts`, add a case that logs a user in on `plus/yearly` and asserts the cycle toggle initializes to yearly (mirror the file's existing mount/session setup):

```ts
it("defaults the cycle toggle to the subscriber's current cycle", async () => {
  await mountPricing({ planId: "plus", hasBilling: true, billingCycle: "yearly" });
  const yearlyBtn = [...target.querySelectorAll(".toggle-btn")].find((b) => /year/i.test(b.textContent ?? ""));
  expect(yearlyBtn?.classList.contains("active")).toBe(true);
});
```

Use the real setup helper already in `Pricing.test.ts` for logging in with billing fields; adapt the name if it differs.

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/lib/Pricing.test.ts`
Expected: FAIL — toggle starts on monthly.

- [ ] **Step 3: Initialize cycle from the session**

In `Pricing.svelte`, change the `cycle` initializer (line 26) to seed from the current subscription, defaulting to monthly:

```ts
  const initialCycle = (): "monthly" | "yearly" =>
    session().user?.billingCycle === "yearly" ? "yearly" : "monthly";
  let cycle = $state<"monthly" | "yearly">(initialCycle());
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd web && npx vitest run src/lib/Pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/Pricing.svelte web/src/lib/Pricing.test.ts
git commit -m "feat(web): pricing cycle toggle defaults to the subscriber's current cycle"
```

---

### Task 9: ChangePlanModal replaces confirm() with a previewed confirmation

**Files:**
- Create: `web/src/lib/ChangePlanModal.svelte`
- Modify: `web/src/lib/Pricing.svelte` (open the modal instead of `confirm()`)
- Modify: `web/src/lib/i18n/types.ts` + all 9 `i18n/<lang>.ts`
- Test: `web/src/lib/ChangePlanModal.test.ts`

**Interfaces:**
- Consumes: `POST /api/billing/preview` (Task 7), `POST /api/billing/change-plan`.
- Produces: new `t.billing` keys `previewLoading`, `upgradeSummary(charge, next, cycle, date)`, `downgradeSummary(date)`, `confirmChange`, `cancel`, `previewError`; `ChangePlanModal` props `{ planId, planName, cycle, onclose }`.

- [ ] **Step 1: Add the i18n keys (type + all langs)**

`i18n/types.ts` `billing`:

```ts
    previewLoading: string; // 弹窗加载预览时
    upgradeSummary: (charge: string, next: string, cycle: string, date: string) => string;
    downgradeSummary: (date: string) => string;
    confirmChange: string; // 弹窗确认按钮
    cancel: string; // 弹窗取消按钮
    previewError: string; // 预览请求失败
```

`i18n/en.ts`:

```ts
    previewLoading: "Calculating…",
    upgradeSummary: (charge, next, cycle, date) =>
      `You'll be charged ${charge} now, then ${next}/${cycle} starting ${date}.`,
    downgradeSummary: (date) => `Takes effect ${date} at period end. You keep your current plan until then — no refund.`,
    confirmChange: "Confirm change",
    cancel: "Cancel",
    previewError: "Couldn't load the change preview. Please try again.",
```

`i18n/zh.ts`:

```ts
    previewLoading: "正在计算…",
    upgradeSummary: (charge, next, cycle, date) =>
      `现在扣款 ${charge}，之后自 ${date} 起 ${next}/${cycle}。`,
    downgradeSummary: (date) => `将于 ${date} 期末生效。在那之前保持当前套餐，不退款。`,
    confirmChange: "确认变更",
    cancel: "取消",
    previewError: "加载变更预览失败，请重试。",
```

Add the same keys to the other 7 languages (translate; English is source). Note: `cycle` passed to `upgradeSummary` is already a localized word (`t.billing.cycleMonthly/cycleYearly`).

- [ ] **Step 2: Write the failing modal tests**

Create `ChangePlanModal.test.ts` (mirror `PlanCard.test.ts` mounting):

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ChangePlanModal from "./ChangePlanModal.svelte";
import { loadLang } from "./i18n.svelte";

let target: HTMLDivElement;
let app: unknown;

async function mountModal(preview: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/billing/preview") return { ok: true, status: 200, json: async () => preview };
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch);
  await loadLang("en");
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(ChangePlanModal, { target, props: { planId: "pro", planName: "Pro", cycle: "yearly", onclose: () => {} } });
  await new Promise((r) => setTimeout(r, 0)); flushSync();
  await new Promise((r) => setTimeout(r, 0)); flushSync();
}

afterEach(() => { if (app) unmount(app as never); target?.remove(); vi.restoreAllMocks(); });

it("shows the immediate charge for an upgrade", async () => {
  await mountModal({ effective: "now", immediateChargeCents: 734, nextAmountCents: 9999, nextCycle: "yearly", effectiveDate: 1789999999 });
  expect(target.textContent ?? "").toContain("$7.34");
});

it("shows a period-end summary with no charge for a downgrade", async () => {
  await mountModal({ effective: "period_end", immediateChargeCents: 0, nextAmountCents: 199, nextCycle: "monthly", effectiveDate: 1789999999 });
  const text = target.textContent ?? "";
  expect(text).toMatch(/period end|Takes effect/i);
  expect(text).not.toContain("charged");
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd web && npx vitest run src/lib/ChangePlanModal.test.ts`
Expected: FAIL — component does not exist.

- [ ] **Step 4: Create ChangePlanModal.svelte**

```svelte
<script lang="ts">
  import { lang, messages, type Messages } from "./i18n.svelte";
  const t = $derived<Messages>(messages[lang()]);

  let { planId, planName, cycle, onclose }: {
    planId: string; planName: string; cycle: "monthly" | "yearly"; onclose: (changed: boolean) => void;
  } = $props();

  interface Preview {
    effective: "now" | "period_end";
    immediateChargeCents: number;
    nextAmountCents: number;
    nextCycle: string;
    effectiveDate: number;
  }

  let preview = $state<Preview | null>(null);
  let loadFailed = $state(false);
  let submitting = $state(false);
  let submitError = $state("");

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const date = (secs: number) => (secs ? new Date(secs * 1000).toLocaleDateString(lang()) : "");
  const cycleWord = (c: string) => (c === "yearly" ? t.billing.cycleYearly : t.billing.cycleMonthly);

  const summary = $derived(() => {
    if (!preview) return "";
    if (preview.effective === "period_end") return t.billing.downgradeSummary(date(preview.effectiveDate));
    return t.billing.upgradeSummary(
      money(preview.immediateChargeCents), money(preview.nextAmountCents),
      cycleWord(preview.nextCycle), date(preview.effectiveDate),
    );
  });

  $effect(() => {
    fetch("/api/billing/preview", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planId, cycle }),
    }).then(async (r) => {
      if (!r.ok) { loadFailed = true; return; }
      preview = (await r.json()) as Preview;
    }).catch(() => { loadFailed = true; });
  });

  async function confirm() {
    if (submitting) return;
    submitting = true; submitError = "";
    try {
      const r = await fetch("/api/billing/change-plan", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId, cycle }),
      });
      if (!r.ok) { submitError = t.billing.changeError; return; }
      onclose(true);
    } catch {
      submitError = t.billing.changeError;
    } finally {
      submitting = false;
    }
  }
</script>

<div class="backdrop" role="dialog" aria-modal="true">
  <div class="modal">
    <h3>{t.billing.changePlan} · {planName} {cycleWord(cycle)}</h3>
    {#if loadFailed}
      <p class="err">{t.billing.previewError}</p>
    {:else if !preview}
      <p class="muted">{t.billing.previewLoading}</p>
    {:else}
      <p class="summary">{summary()}</p>
    {/if}
    {#if submitError}<p class="err">{submitError}</p>{/if}
    <div class="actions">
      <button class="btn btn-primary" disabled={!preview || submitting} onclick={confirm}>{t.billing.confirmChange}</button>
      <button class="btn" disabled={submitting} onclick={() => onclose(false)}>{t.billing.cancel}</button>
    </div>
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--space-5); max-width: 420px; width: calc(100% - var(--space-4)); }
  .modal h3 { margin: 0 0 var(--space-3); font-size: var(--fs-h3); color: var(--text-h); }
  .summary { margin: 0 0 var(--space-4); color: var(--text-h); }
  .muted { margin: 0 0 var(--space-4); color: var(--text); }
  .err { color: var(--danger); font-size: var(--fs-xs); margin: 0 0 var(--space-3); }
  .actions { display: flex; gap: var(--space-2); }
</style>
```

- [ ] **Step 5: Wire the modal into Pricing.svelte**

Replace `changePlan`'s `confirm()`-based flow. Add modal state and a launcher; keep the async refresh polling in the modal's `onclose(true)` handler:

```svelte
<script lang="ts">
  import ChangePlanModal from "./ChangePlanModal.svelte";
  // ...existing imports...
  let modalTier = $state<Tier | null>(null);

  function act(tier: Tier) {
    if (isSubscribed) modalTier = tier; // open the modal (preview + confirm)
    else checkout(tier.id);
  }

  function onModalClose(changed: boolean) {
    modalTier = null;
    if (changed) {
      changeMsg = t.billing.changeSuccess;
      setTimeout(() => refreshSession(), 1500);
      setTimeout(() => refreshSession(), 4000);
    }
  }
</script>

<!-- near the end of the markup, after </div> of .pricing -->
{#if modalTier}
  <ChangePlanModal planId={modalTier.id} planName={modalTier.name} {cycle} onclose={onModalClose} />
{/if}
```

Delete the now-unused `changePlan` function and its `confirm()`/`downgradeConfirm`/`changeConfirm` usages. (Leave the `changeConfirm`/`downgradeConfirm` i18n keys in place for now — removing keys touches all 9 langs and is not needed; a later cleanup can drop them.)

- [ ] **Step 6: Run tests + type-check**

Run: `cd web && npx vitest run src/lib/ChangePlanModal.test.ts src/lib/Pricing.test.ts && npm run check`
Expected: PASS + clean (all 9 langs have the new keys).

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/ChangePlanModal.svelte web/src/lib/ChangePlanModal.test.ts web/src/lib/Pricing.svelte web/src/lib/i18n
git commit -m "feat(web): in-app change-plan modal with real charge/effective-date preview"
```

---

### Task 10: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Server**

Run: `cd server && go build ./... && go vet ./... && go test ./...`
Expected: all `ok`.

- [ ] **Step 2: Web**

Run: `cd web && npm run check && npx vitest run`
Expected: type-check clean, all tests pass.

- [ ] **Step 3: Build the web bundle**

Run: `cd web && npm run build`
Expected: build succeeds (no unused-import/type errors from the modal wiring).

- [ ] **Step 4: Commit any lint/format fixups if needed**

```bash
git add -A && git commit -m "chore: subscription UX pass — build/test verification fixups" || echo "nothing to commit"
```

---

## Self-Review notes

- **Spec coverage:** A1→Task 1; A4→Task 2; A3→Task 3; A2→Tasks 5 (resolveChange), 6 (PreviewChange + always_invoice), 7 (endpoint); B1→Task 4; B2→Task 8; B3→Task 9; C→folded into Tasks 4 & 9; D→each task's TDD steps + Task 10.
- **Decision applied:** upgrade proration is charged immediately (`always_invoice`, Task 6) per user decision, and the preview uses the same behavior so the number shown matches what is charged.
- **Type consistency:** `PreviewChange` signature identical in interface, `stripeClient`, and `fakeBiller`; `resolveChange(cur, target, wantCycle)` used identically in change-plan and preview; preview JSON field names (`effective/immediateChargeCents/nextAmountCents/nextCycle/effectiveDate`) identical in Task 7 handler, Task 9 `Preview` interface, and tests.
- **Out of scope (unchanged):** Stripe portal for payment method/invoices; pricing/quota values; multi-currency; `ScheduleDowngrade` stacking-schedule error.
