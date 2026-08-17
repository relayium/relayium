package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// 档位方向和周期方向是两条独立的轴。resolvePlanChange 之前的 resolveChange 只能
// 返回一个 bool，所以「档位要升、周期要缩」这种组合只能被压成其中一边 —— 压成
// 立即生效就是把没用完的一整年折成 credit 再按月重扣，压成期末生效就是让用户
// 现在付了钱却拿不到高档位。这一组测试把两条轴拆开后的完整矩阵钉死。

// tierCyclePlans are three tiers, priced apart so tier direction is unambiguous.
func tierCyclePlans(t *testing.T, store *SQLiteStore) {
	t.Helper()
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true,
		PriceMonthly: 390, PriceYearly: 3900,
		StripePriceMonthlyID: "price_plus_m", StripePriceYearlyID: "price_plus_y"})
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true,
		PriceMonthly: 890, PriceYearly: 8900,
		StripePriceMonthlyID: "price_pro_m", StripePriceYearlyID: "price_pro_y"})
	// max has NO yearly price id — the composite upgrade has no immediate stage
	// to bill, so it must degrade rather than half-apply.
	mustPlan(t, store, Plan{ID: "max", Name: "Max", Active: true,
		PriceMonthly: 1990, PriceYearly: 19900,
		StripePriceMonthlyID: "price_max_m"})
}

// TestResolvePlanChangeMatrix walks the whole tier×cycle matrix against the pure
// policy function, so a direction regression is caught without a live server.
func TestResolvePlanChangeMatrix(t *testing.T) {
	plus := Plan{ID: "plus", PriceMonthly: 390, StripePriceMonthlyID: "price_plus_m", StripePriceYearlyID: "price_plus_y"}
	pro := Plan{ID: "pro", PriceMonthly: 890, StripePriceMonthlyID: "price_pro_m", StripePriceYearlyID: "price_pro_y"}
	// noYearlyPro is the same tier as pro but has no yearly price configured.
	noYearlyPro := Plan{ID: "pro", PriceMonthly: 890, StripePriceMonthlyID: "price_pro_m"}
	// twinPlus is a DIFFERENT tier that happens to cost the same per month.
	twinPlus := Plan{ID: "plusx", PriceMonthly: 390, StripePriceMonthlyID: "price_plusx_m", StripePriceYearlyID: "price_plusx_y"}

	cases := []struct {
		name       string
		cur        Plan
		curCycle   string
		target     Plan
		wantCycle  string
		wantEffect planChangeEffect
		wantImmCyc string
		wantSchedP string
		wantSchedC string
	}{
		// --- tier upgrades: immediate, at the requested cycle ---
		{"tier up, monthly->monthly", plus, "monthly", pro, "monthly", effectNow, "monthly", "", ""},
		{"tier up, monthly->yearly", plus, "monthly", pro, "yearly", effectNow, "yearly", "", ""},
		{"tier up, yearly->yearly", plus, "yearly", pro, "yearly", effectNow, "yearly", "", ""},

		// --- the composite: yearly lower tier -> monthly higher tier ---
		{"tier up, yearly->monthly is composite", plus, "yearly", pro, "monthly",
			effectComposite, "yearly", "pro", "monthly"},

		// --- tier downgrades: period end, whatever the cycle does ---
		{"tier down, monthly->monthly", pro, "monthly", plus, "monthly", effectPeriodEnd, "", "plus", "monthly"},
		{"tier down, monthly->yearly still defers", pro, "monthly", plus, "yearly", effectPeriodEnd, "", "plus", "yearly"},
		{"tier down, yearly->monthly", pro, "yearly", plus, "monthly", effectPeriodEnd, "", "plus", "monthly"},

		// --- same tier: only the cycle moved ---
		{"same tier, monthly->yearly", plus, "monthly", plus, "yearly", effectNow, "yearly", "", ""},
		{"same tier, yearly->monthly", plus, "yearly", plus, "monthly", effectPeriodEnd, "", "plus", "monthly"},

		// --- edges ---
		// A row that predates the billing_cycle column: the cycle is unknown, so
		// there is nothing to split and the tier upgrade applies as asked.
		{"unknown current cycle never composites", plus, "", pro, "monthly", effectNow, "monthly", "", ""},
		// No yearly price on the target => no immediate stage to bill.
		{"composite degrades without a yearly price", plus, "yearly", noYearlyPro, "monthly", effectNow, "monthly", "", ""},
		// Distinct tiers at the same monthly price are neither up nor down.
		{"equal-priced distinct tiers apply now", plus, "yearly", twinPlus, "monthly", effectNow, "monthly", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := resolvePlanChange(tc.cur, tc.curCycle, tc.target, tc.wantCycle)
			want := planChangeDecision{
				Effect:          tc.wantEffect,
				ImmediateCycle:  tc.wantImmCyc,
				ScheduledPlanID: tc.wantSchedP,
				ScheduledCycle:  tc.wantSchedC,
			}
			if got != want {
				t.Fatalf("resolvePlanChange(%s/%s -> %s/%s) = %+v, want %+v",
					tc.cur.ID, tc.curCycle, tc.target.ID, tc.wantCycle, got, want)
			}
		})
	}
}

// changePlanJSON runs a change-plan request and decodes its JSON body, failing
// on a non-200.
func changePlanJSON(t *testing.T, ts *httptest.Server, cookie *http.Cookie, body string) map[string]string {
	t.Helper()
	resp := changePlan(t, ts, cookie, body)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("change-plan %s: want 200, got %d: %s", body, resp.StatusCode, raw)
	}
	var out map[string]string
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("decode change-plan response %q: %v", raw, err)
	}
	return out
}

// 组合操作的顺序不是随便定的：先立即换到目标档位的年付价，再排期到月付。反过来
// 先排期的话，紧接着的立即修改会撞上 Stripe「已有 schedule」的拒绝，把整个操作
// 卡死在 500。
func TestChangePlanCompositeAppliesYearlyNowAndSchedulesMonthly(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "composite@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	subscribeUserCycle(t, store, uid, "cus_comp", "plus", "yearly")

	out := changePlanJSON(t, ts, cookie, `{"planId":"pro","cycle":"monthly"}`)

	if out["effective"] != "now_then_period_end" {
		t.Fatalf("effective = %q, want now_then_period_end", out["effective"])
	}
	// Stage 1: immediate, at the target tier's YEARLY price — never the monthly
	// one, which would credit away the unused year.
	if fb.changeCalls != 1 || fb.lastChangePrice != "price_pro_y" {
		t.Fatalf("immediate stage: calls=%d price=%q, want 1 call at price_pro_y",
			fb.changeCalls, fb.lastChangePrice)
	}
	// Stage 2: the requested monthly price, at the period end.
	if fb.downgradeCalls != 1 || fb.lastDowngradePrice != "price_pro_m" {
		t.Fatalf("scheduled stage: calls=%d price=%q, want 1 call at price_pro_m",
			fb.downgradeCalls, fb.lastDowngradePrice)
	}
	// The response must name BOTH stages: a client told only "pro monthly, ok"
	// would misreport the customer as already on monthly.
	if out["immediatePlanId"] != "pro" || out["immediateCycle"] != "yearly" {
		t.Fatalf("immediate stage fields = %q/%q, want pro/yearly",
			out["immediatePlanId"], out["immediateCycle"])
	}
	if out["scheduledPlanId"] != "pro" || out["scheduledCycle"] != "monthly" {
		t.Fatalf("scheduled stage fields = %q/%q, want pro/monthly",
			out["scheduledPlanId"], out["scheduledCycle"])
	}
	// And the pending monthly stage is persisted, so the webhook can tell when it
	// lands and the pricing UI can show it meanwhile.
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.ScheduledPlanID != "pro" || u.ScheduledCycle != "monthly" {
		t.Fatalf("persisted schedule = %q/%q, want pro/monthly", u.ScheduledPlanID, u.ScheduledCycle)
	}
}

// orderRecordingBiller records the sequence of mutating calls so the composite's
// ordering can be asserted directly, and can fail a chosen stage.
type orderRecordingBiller struct {
	fakeBiller
	calls        []string
	downgradeErr error
	// priceNow is the price the "subscription" currently sits on, so a repeated
	// immediate stage can no-op exactly like the real client does.
	priceNow string
}

func (b *orderRecordingBiller) ReleaseSchedule(ctx context.Context, customerID string) error {
	b.calls = append(b.calls, "release")
	return b.fakeBiller.ReleaseSchedule(ctx, customerID)
}

func (b *orderRecordingBiller) ChangeSubscriptionPlan(ctx context.Context, customerID, newPriceID string) error {
	if b.priceNow == newPriceID {
		// Mirrors stripeClient.ChangeSubscriptionPlan's same-price early return:
		// the retry costs nothing and charges nothing.
		b.calls = append(b.calls, "change-noop:"+newPriceID)
		return nil
	}
	b.calls = append(b.calls, "change:"+newPriceID)
	b.priceNow = newPriceID
	return b.fakeBiller.ChangeSubscriptionPlan(ctx, customerID, newPriceID)
}

func (b *orderRecordingBiller) ScheduleDowngrade(ctx context.Context, customerID, newPriceID string) error {
	if b.downgradeErr != nil {
		b.calls = append(b.calls, "schedule-fail:"+newPriceID)
		return b.downgradeErr
	}
	b.calls = append(b.calls, "schedule:"+newPriceID)
	return b.fakeBiller.ScheduleDowngrade(ctx, customerID, newPriceID)
}

func TestChangePlanCompositeCallOrder(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &orderRecordingBiller{priceNow: "price_plus_y"}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "composite-order@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_order", "plus", "yearly")

	changePlanJSON(t, ts, cookie, `{"planId":"pro","cycle":"monthly"}`)

	want := []string{"release", "change:price_pro_y", "schedule:price_pro_m"}
	if len(fb.calls) != len(want) {
		t.Fatalf("calls = %v, want %v", fb.calls, want)
	}
	for i := range want {
		if fb.calls[i] != want[i] {
			t.Fatalf("calls = %v, want %v", fb.calls, want)
		}
	}
}

// Stripe has no atomic two-stage primitive, so the partial failure has to be
// reported truthfully AND be recoverable: the caller must see an error (not a
// 200 promising a cycle change that will never fire), the DB must not advertise
// a schedule Stripe knows nothing about, and a retry must finish the job without
// charging the proration a second time.
func TestChangePlanCompositePartialFailureIsReportedAndRetryConverges(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &orderRecordingBiller{priceNow: "price_plus_y", downgradeErr: errors.New("stripe down")}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "composite-partial@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	subscribeUserCycle(t, store, uid, "cus_partial", "plus", "yearly")

	resp := changePlan(t, ts, cookie, `{"planId":"pro","cycle":"monthly"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("a half-applied composite must not report success, got %d", resp.StatusCode)
	}
	// The immediate stage DID apply, so the subscription really is on pro yearly.
	if fb.priceNow != "price_pro_y" {
		t.Fatalf("immediate stage should have applied, price is %q", fb.priceNow)
	}
	// But nothing is pending in Stripe, so nothing may be advertised as pending.
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.ScheduledPlanID != "" || u.ScheduledCycle != "" {
		t.Fatalf("failed scheduling must leave no pending marker, got %q/%q",
			u.ScheduledPlanID, u.ScheduledCycle)
	}

	// Retry with Stripe healthy again. The user row still says plus/yearly (the
	// webhook for stage 1 has not arrived), so the handler resolves the composite
	// a second time — and the immediate stage must no-op rather than re-charge.
	fb.downgradeErr = nil
	fb.calls = nil
	out := changePlanJSON(t, ts, cookie, `{"planId":"pro","cycle":"monthly"}`)

	if out["effective"] != "now_then_period_end" {
		t.Fatalf("retry effective = %q, want now_then_period_end", out["effective"])
	}
	want := []string{"release", "change-noop:price_pro_y", "schedule:price_pro_m"}
	if len(fb.calls) != len(want) {
		t.Fatalf("retry calls = %v, want %v (no second proration charge)", fb.calls, want)
	}
	for i := range want {
		if fb.calls[i] != want[i] {
			t.Fatalf("retry calls = %v, want %v (no second proration charge)", fb.calls, want)
		}
	}
	u2, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	if u2.ScheduledPlanID != "pro" || u2.ScheduledCycle != "monthly" {
		t.Fatalf("retry must finish the schedule, got %q/%q", u2.ScheduledPlanID, u2.ScheduledCycle)
	}
}

// The other convergence path: the stage-1 webhook lands before the user retries,
// so the row now reads pro/yearly and the request is an ordinary same-tier cycle
// downgrade. Different route, same destination, still no second charge.
func TestChangePlanCompositeRetryAfterWebhookLandsSchedulesOnly(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &orderRecordingBiller{priceNow: "price_pro_y"}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "composite-landed@example.com"
	cookie := loginCookie(t, ts, mail, email)
	uid := mustUserID(t, store, email)
	// Stage 1 already applied AND its webhook already recorded pro/yearly.
	subscribeUserCycle(t, store, uid, "cus_landed", "pro", "yearly")

	out := changePlanJSON(t, ts, cookie, `{"planId":"pro","cycle":"monthly"}`)

	if out["effective"] != "period_end" {
		t.Fatalf("effective = %q, want period_end", out["effective"])
	}
	want := []string{"schedule:price_pro_m"}
	if len(fb.calls) != len(want) {
		t.Fatalf("calls = %v, want %v (nothing may be charged again)", fb.calls, want)
	}
	for i := range want {
		if fb.calls[i] != want[i] {
			t.Fatalf("calls = %v, want %v (nothing may be charged again)", fb.calls, want)
		}
	}
	u, err := store.GetUserByID(context.Background(), uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.ScheduledPlanID != "pro" || u.ScheduledCycle != "monthly" {
		t.Fatalf("persisted schedule = %q/%q, want pro/monthly", u.ScheduledPlanID, u.ScheduledCycle)
	}
}

// A composite needs a yearly price for its immediate stage. When the target tier
// has none, the change must degrade to an ordinary immediate monthly upgrade —
// and crucially it must NOT reach Stripe, apply stage 1, and only then find it
// has no stage 2.
func TestChangePlanCompositeDegradesWhenTargetHasNoYearlyPrice(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &orderRecordingBiller{priceNow: "price_plus_y"}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "composite-noyear@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_noyear", "plus", "yearly")

	out := changePlanJSON(t, ts, cookie, `{"planId":"max","cycle":"monthly"}`)

	if out["effective"] != "now" {
		t.Fatalf("effective = %q, want now", out["effective"])
	}
	want := []string{"release", "change:price_max_m"}
	if len(fb.calls) != len(want) {
		t.Fatalf("calls = %v, want %v", fb.calls, want)
	}
	for i := range want {
		if fb.calls[i] != want[i] {
			t.Fatalf("calls = %v, want %v", fb.calls, want)
		}
	}
}

// 预览必须描述真正会执行的那个操作。组合升级预览的是「立即那一段」——目标档位的
// 年付价 —— 因为那才是今天要扣的钱；同时把期末那一段的档位/周期/金额一并说清楚。
func TestBillingPreviewCompositeDescribesBothStages(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{previewCents: 5000, previewPeriodEnd: 1950000000}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "preview-composite@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_pv_comp", "plus", "yearly")

	body := postJSONBody(t, ts, cookie, "/api/billing/preview", `{"planId":"pro","cycle":"monthly"}`)

	if body["effective"] != "now_then_period_end" {
		t.Fatalf("effective = %v, want now_then_period_end", body["effective"])
	}
	// Previewed against the YEARLY price, because that is the stage being billed.
	if fb.previewCalls != 1 || fb.lastPreviewPrice != "price_pro_y" {
		t.Fatalf("want one preview of price_pro_y, got calls=%d price=%q",
			fb.previewCalls, fb.lastPreviewPrice)
	}
	if body["immediateChargeCents"].(float64) != 5000 {
		t.Fatalf("immediateChargeCents = %v, want 5000", body["immediateChargeCents"])
	}
	if body["immediateCycle"] != "yearly" || body["immediatePlanId"] != "pro" {
		t.Fatalf("immediate stage = %v/%v, want pro/yearly", body["immediatePlanId"], body["immediateCycle"])
	}
	if body["immediateAmountCents"].(float64) != 8900 {
		t.Fatalf("immediateAmountCents = %v, want the pro yearly price 8900", body["immediateAmountCents"])
	}
	if body["scheduledPlanId"] != "pro" || body["scheduledCycle"] != "monthly" {
		t.Fatalf("scheduled stage = %v/%v, want pro/monthly", body["scheduledPlanId"], body["scheduledCycle"])
	}
	if body["scheduledAmountCents"].(float64) != 890 {
		t.Fatalf("scheduledAmountCents = %v, want the pro monthly price 890", body["scheduledAmountCents"])
	}
	// The date the monthly stage begins is the yearly renewal Stripe projects,
	// NOT the stored (pre-change) subscription_end of 1900000000.
	if body["effectiveDate"].(float64) != 1950000000 {
		t.Fatalf("effectiveDate = %v, want Stripe's projected 1950000000", body["effectiveDate"])
	}
}

// users.subscription_end is the anchor BEFORE the change. A monthly→yearly
// switch resets that anchor a year out, so reusing the stored value told the
// user their yearly plan renews next month.
func TestBillingPreviewUsesStripeProjectedPeriodEnd(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{previewCents: 3200, previewPeriodEnd: 1931536000}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "preview-date@example.com"
	cookie := loginCookie(t, ts, mail, email)
	// subscribeUserCycle stamps subscription_end at 1900000000.
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_pv_date", "plus", "monthly")

	body := postJSONBody(t, ts, cookie, "/api/billing/preview", `{"planId":"plus","cycle":"yearly"}`)

	if body["effective"] != "now" {
		t.Fatalf("effective = %v, want now", body["effective"])
	}
	if body["effectiveDate"].(float64) != 1931536000 {
		t.Fatalf("effectiveDate = %v, want Stripe's projected 1931536000 (not the stale 1900000000)",
			body["effectiveDate"])
	}
}

// When Stripe's preview carries no usable period, fall back to the stored
// anchor rather than reporting the epoch as a renewal date.
func TestBillingPreviewFallsBackToStoredPeriodEndWhenStripeGivesNone(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{previewCents: 100} // previewPeriodEnd deliberately 0
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "preview-nodate@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_pv_nodate", "plus", "monthly")

	body := postJSONBody(t, ts, cookie, "/api/billing/preview", `{"planId":"pro","cycle":"monthly"}`)

	if body["effectiveDate"].(float64) != 1900000000 {
		t.Fatalf("effectiveDate = %v, want the stored 1900000000 when Stripe gives no period",
			body["effectiveDate"])
	}
}

// Stripe floors amount_due at zero, so a change that nets out in the customer's
// favour reports "$0.00 due now" while the invoice total is negative and the
// difference lands on their balance. The signed total must be reported too, or
// the UI tells a customer who is owed money that the change is free.
func TestBillingPreviewReportsNegativeAdjustmentAsCredit(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{previewCents: 0, previewTotal: -1234, previewPeriodEnd: 1910000000}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "preview-credit@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_pv_credit", "plus", "monthly")

	body := postJSONBody(t, ts, cookie, "/api/billing/preview", `{"planId":"pro","cycle":"monthly"}`)

	if body["immediateChargeCents"].(float64) != 0 {
		t.Fatalf("immediateChargeCents = %v, want 0 (nothing is charged)", body["immediateChargeCents"])
	}
	if body["immediateAdjustmentCents"].(float64) != -1234 {
		t.Fatalf("immediateAdjustmentCents = %v, want -1234 (a credit, not a free change)",
			body["immediateAdjustmentCents"])
	}
}

// An ordinary charge sets both fields to the same positive number, so a client
// can render the signed field unconditionally.
func TestBillingPreviewChargeSetsBothFields(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{previewCents: 734, previewTotal: 734}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "preview-charge@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_pv_charge", "plus", "monthly")

	body := postJSONBody(t, ts, cookie, "/api/billing/preview", `{"planId":"pro","cycle":"monthly"}`)

	if body["immediateChargeCents"].(float64) != 734 || body["immediateAdjustmentCents"].(float64) != 734 {
		t.Fatalf("charge/adjustment = %v/%v, want 734/734",
			body["immediateChargeCents"], body["immediateAdjustmentCents"])
	}
}

// The period-end path performs no Stripe call at all, so it has no projection to
// report: the stored anchor IS the effective date and the adjustment is zero.
func TestBillingPreviewPeriodEndReportsZeroAdjustment(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{previewCents: 999, previewTotal: 999, previewPeriodEnd: 123}
	svc.biller = fb
	tierCyclePlans(t, store)
	email := "preview-defer@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_pv_defer", "pro", "yearly")

	body := postJSONBody(t, ts, cookie, "/api/billing/preview", `{"planId":"pro","cycle":"monthly"}`)

	if body["effective"] != "period_end" {
		t.Fatalf("effective = %v, want period_end", body["effective"])
	}
	if body["immediateAdjustmentCents"].(float64) != 0 {
		t.Fatalf("immediateAdjustmentCents = %v, want 0", body["immediateAdjustmentCents"])
	}
	if body["effectiveDate"].(float64) != 1900000000 {
		t.Fatalf("effectiveDate = %v, want the stored period end", body["effectiveDate"])
	}
	if fb.previewCalls != 0 {
		t.Fatalf("period-end preview must not call Stripe, got %d calls", fb.previewCalls)
	}
}
