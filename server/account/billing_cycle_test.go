package account

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// 计费周期（月付/年付）是和档位正交的一个维度，但原先整条链路都只认档位 ID：
// webhook 反查出 Plan 后就把「这个 price 是月付还是年付」丢掉了，users 表也没有
// 相应的列。后果是同档换周期在服务端被 `plan.ID == u.PlanID` 判成「已在该档」
// 直接 400 —— 月付用户想改成年付一次性付清，这个操作根本不存在。
//
// 这一组测试钉住修好之后的语义：**档位方向优先，档位相同时才由周期决定方向。**

func cycleOf(t *testing.T, store *SQLiteStore, customer string) string {
	t.Helper()
	u, ok, err := store.GetUserByStripeCustomer(context.Background(), customer)
	if err != nil || !ok {
		t.Fatalf("GetUserByStripeCustomer(%q): ok=%v err=%v", customer, ok, err)
	}
	return u.BillingCycle
}

// webhook 必须能从 price id 反推出周期 —— 这是周期信息唯一的来源，Stripe 不会
// 在事件里单独给一个 "interval" 字段，只能拿 price id 跟档位的两个 id 比对。
func TestWebhookRecordsYearlyCycleFromPriceID(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_cycle_y"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true,
		StripePriceMonthlyID: "price_pro_m", StripePriceYearlyID: "price_pro_y"})
	_ = loginCookie(t, ts, mail, "cycle-y@example.com")
	uid := mustUserID(t, store, "cycle-y@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_cycle_y"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_cycle_y", "sub_y", "", "active", "price_pro_y", 1700000000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if got := cycleOf(t, store, "cus_cycle_y"); got != "yearly" {
		t.Fatalf("billing cycle = %q, want yearly (price_pro_y is the yearly price)", got)
	}
}

func TestWebhookRecordsMonthlyCycleFromPriceID(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_cycle_m"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true,
		StripePriceMonthlyID: "price_pro_m", StripePriceYearlyID: "price_pro_y"})
	_ = loginCookie(t, ts, mail, "cycle-m@example.com")
	uid := mustUserID(t, store, "cycle-m@example.com")
	if err := store.SetUserStripeCustomer(context.Background(), uid, "cus_cycle_m"); err != nil {
		t.Fatal(err)
	}

	body := webhookEnv("customer.subscription.updated", "cus_cycle_m", "sub_m", "", "active", "price_pro_m", 1700000000)
	resp := postWebhook(t, ts, secret, body)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if got := cycleOf(t, store, "cus_cycle_m"); got != "monthly" {
		t.Fatalf("billing cycle = %q, want monthly", got)
	}
}

func effectiveOf(t *testing.T, resp *http.Response) string {
	t.Helper()
	var out struct {
		Effective string `json:"effective"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode change-plan response: %v", err)
	}
	return out.Effective
}

// 用户报的那个 bug：月付想换年付，一次性扣款。这是升级语义 —— 立即生效，Stripe
// 按比例把没用完的那个月折抵到年费里。
func TestChangePlanSameTierMonthlyToYearlyChargesNow(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{}
	svc.biller = fb
	mustTwoPlans(t, store)
	email := "cycle-up@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_cyc_up", "plus", "monthly")

	resp := changePlan(t, ts, cookie, `{"planId":"plus","cycle":"yearly"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 switching plus/monthly -> plus/yearly, got %d", resp.StatusCode)
	}
	if got := effectiveOf(t, resp); got != "now" {
		t.Fatalf("effective = %q, want now (a cycle upgrade charges immediately)", got)
	}
	if fb.changeCalls != 1 || fb.downgradeCalls != 0 {
		t.Fatalf("want 1 immediate change and 0 scheduled downgrades, got change=%d downgrade=%d",
			fb.changeCalls, fb.downgradeCalls)
	}
	// 必须用年付的 price，否则「换成年付」实际还是按月扣。
	if fb.lastChangePrice != "price_plus_y" {
		t.Fatalf("changed to price %q, want price_plus_y", fb.lastChangePrice)
	}
}

// 年付换回月付：按降级处理，延到期末 —— 用户已经付掉的那一年要用完，不退款、
// 不产生 Stripe credit 余额。
func TestChangePlanSameTierYearlyToMonthlyDefersToPeriodEnd(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{}
	svc.biller = fb
	mustTwoPlans(t, store)
	email := "cycle-down@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_cyc_dn", "plus", "yearly")

	resp := changePlan(t, ts, cookie, `{"planId":"plus","cycle":"monthly"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 switching plus/yearly -> plus/monthly, got %d", resp.StatusCode)
	}
	if got := effectiveOf(t, resp); got != "period_end" {
		t.Fatalf("effective = %q, want period_end", got)
	}
	if fb.downgradeCalls != 1 || fb.changeCalls != 0 {
		t.Fatalf("want 1 scheduled downgrade and 0 immediate changes, got change=%d downgrade=%d",
			fb.changeCalls, fb.downgradeCalls)
	}
}

// 同档同周期才算「已在该档」。这是原来的守卫，必须保住 —— 修 bug 时最容易顺手
// 把它一起删掉，那样重复点击就会反复打 Stripe。
func TestChangePlanRejectsIdenticalTierAndCycle(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{}
	svc.biller = fb
	mustTwoPlans(t, store)
	email := "cycle-same@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_cyc_same", "plus", "monthly")

	resp := changePlan(t, ts, cookie, `{"planId":"plus","cycle":"monthly"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for the exact same tier AND cycle, got %d", resp.StatusCode)
	}
	if fb.changeCalls != 0 || fb.downgradeCalls != 0 {
		t.Fatalf("a no-op change must not touch Stripe, got change=%d downgrade=%d",
			fb.changeCalls, fb.downgradeCalls)
	}
}

// 跨档位又跨周期时，档位方向说了算。pro/monthly -> plus/yearly 掏的现金更多，
// 但档位是降的，按降级延到期末处理，避免「降档」反而立刻扣一大笔。
func TestChangePlanTierDirectionOutranksCycle(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{}
	svc.biller = fb
	mustTwoPlans(t, store)
	email := "cycle-cross@example.com"
	cookie := loginCookie(t, ts, mail, email)
	subscribeUserCycle(t, store, mustUserID(t, store, email), "cus_cyc_x", "pro", "monthly")

	resp := changePlan(t, ts, cookie, `{"planId":"plus","cycle":"yearly"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200, got %d", resp.StatusCode)
	}
	if got := effectiveOf(t, resp); got != "period_end" {
		t.Fatalf("effective = %q, want period_end (tier went down, so it defers)", got)
	}
	if fb.downgradeCalls != 1 {
		t.Fatalf("want 1 scheduled downgrade, got %d", fb.downgradeCalls)
	}
}

// 存量用户的 billing_cycle 是空串（迁移前就有订阅，没人记录过周期）。这时不能
// 把「空 != monthly」当成一次周期变更去打 Stripe：应当只按档位判断，同档同样
// 走 400。否则迁移当天每个老用户点一下当前档就会触发一次无谓的订阅修改。
func TestChangePlanUnknownCycleFallsBackToTierOnly(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	fb := &fakeBiller{}
	svc.biller = fb
	mustTwoPlans(t, store)
	email := "cycle-legacy@example.com"
	cookie := loginCookie(t, ts, mail, email)
	// 注意：用不带周期的旧 helper，模拟迁移前就存在的订阅行。
	subscribeUser(t, store, mustUserID(t, store, email), "cus_cyc_legacy", "plus")

	resp := changePlan(t, ts, cookie, `{"planId":"plus","cycle":"monthly"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400 for a legacy row with an unknown cycle on the same tier, got %d", resp.StatusCode)
	}
	if fb.changeCalls != 0 || fb.downgradeCalls != 0 {
		t.Fatalf("legacy unknown cycle must not trigger a Stripe call, got change=%d downgrade=%d",
			fb.changeCalls, fb.downgradeCalls)
	}
}

// P1-2 regression: a SAME-TIER cycle downgrade (pro yearly -> pro monthly) has
// scheduled_plan_id == the current tier, so the webhook's "landed" clear used to
// fire on the intermediate updated event Stripe emits when the schedule is first
// attached (price still yearly), wiping the marker seconds after it was set and
// wedging every later in-app plan change at 500. The clear now also requires the
// CYCLE to match, so the marker survives until the change actually lands.
func TestWebhookSameTierCycleDowngradeMarkerSurvivesUntilLanded(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	secret := "whsec_cycle_sched"
	svc.biller = newWebhookFixtureClient(secret)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true,
		StripePriceMonthlyID: "price_pro_m", StripePriceYearlyID: "price_pro_y"})
	_ = loginCookie(t, ts, mail, "cyc-sched@example.com")
	uid := mustUserID(t, store, "cyc-sched@example.com")
	ctx := context.Background()

	// On pro yearly, with a pending same-tier downgrade to pro monthly recorded.
	if err := store.SetUserStripeCustomer(ctx, uid, "cus_cyc"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserSubscription(ctx, uid, "pro", "active", 1900000000, "stripe", "yearly", time.Now().Unix(), 0); err != nil {
		t.Fatal(err)
	}
	if err := store.SetScheduledPlan(ctx, uid, "pro", "monthly"); err != nil {
		t.Fatal(err)
	}

	// Pre-landing event: tier matches (pro) but the price is still YEARLY. The
	// marker must NOT be cleared.
	resp := postWebhook(t, ts, secret,
		webhookEnv("customer.subscription.updated", "cus_cyc", "sub_1", "", "active", "price_pro_y", 1900000000))
	resp.Body.Close()
	u, err := store.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.ScheduledPlanID != "pro" || u.ScheduledCycle != "monthly" {
		t.Fatalf("pending cycle-downgrade marker cleared prematurely by the pre-landing (yearly) event: plan=%q cycle=%q",
			u.ScheduledPlanID, u.ScheduledCycle)
	}

	// Landing event: the price is now MONTHLY — tier AND cycle match, so the
	// marker clears.
	resp2 := postWebhook(t, ts, secret,
		webhookEnv("customer.subscription.updated", "cus_cyc", "sub_1", "", "active", "price_pro_m", 1900000000))
	resp2.Body.Close()
	u2, err := store.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	if u2.ScheduledPlanID != "" || u2.ScheduledCycle != "" {
		t.Fatalf("marker must clear once the downgrade lands (monthly price): plan=%q cycle=%q",
			u2.ScheduledPlanID, u2.ScheduledCycle)
	}
}
