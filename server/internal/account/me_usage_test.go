package account

import (
	"encoding/json"
	"net/http"
	"testing"
)

// /api/me/usage 报的必须是**当月**用量与当月上限，而不是 /api/stats 那个终身
// 累计——两者是不同的数，混淆会让用户以为自己还有额度。
func TestMeUsageReportsMonthToDate(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "a@b.c")

	u, ok, err := store.UserByCanonicalEmail(t.Context(), "a@b.c")
	if err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	if !ok {
		t.Fatalf("user a@b.c not found")
	}
	now := svc.now().Unix()
	if err := store.RecordMeter(t.Context(), u.ID, MeterUpload, 500, now); err != nil {
		t.Fatalf("RecordMeter: %v", err)
	}
	// 再记一笔上个月（必定跨 period）的用量。它存在的唯一目的是钉死
	// 「当月 vs 终身」这个区别：如果 handler 回退成终身累计，下面的
	// traffic.used 断言就会从 500 变成 7500 而失败。不要把它当无关噪音删掉。
	lastMonth := now - 40*86400
	if err := store.RecordMeter(t.Context(), u.ID, MeterUpload, 7000, lastMonth); err != nil {
		t.Fatalf("RecordMeter (last month): %v", err)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/me/usage", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var body struct {
		Period   string                    `json:"period"`
		ResetsAt int64                     `json:"resetsAt"`
		Traffic  struct{ Used, Cap int64 } `json:"traffic"`
		Storage  struct{ Used, Cap int64 } `json:"storage"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Period != periodOf(now) {
		t.Fatalf("period = %q, want %q", body.Period, periodOf(now))
	}
	_, wantEnd := monthRange(periodOf(now))
	if body.ResetsAt != wantEnd {
		t.Fatalf("resetsAt = %d, want %d (end of the current month)", body.ResetsAt, wantEnd)
	}
	if body.Traffic.Used != 500 {
		t.Fatalf("traffic.used = %d, want 500 — 上个月的 7000 字节不得计入当月用量（回归成终身累计会得到 7500）", body.Traffic.Used)
	}
	if body.Traffic.Cap != 1073741824 {
		t.Fatalf("traffic.cap = %d, want 1073741824 (free tier)", body.Traffic.Cap)
	}
	if body.Storage.Cap != 104857600 {
		t.Fatalf("storage.cap = %d, want 104857600 (free tier)", body.Storage.Cap)
	}
}

// 未登录必须 401 —— 用量是账号私有数据。
func TestMeUsageRequiresSession(t *testing.T) {
	ts, _, _, _ := newBillingServer(t)
	res, err := http.Get(ts.URL + "/api/me/usage")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.StatusCode)
	}
}

// 个人中心要展示会员等级与权益，光有 used/cap 两个数不够——用户看不出自己在哪
// 个档、这个档买到了什么。plan 块就是那份信息，且必须复用 handler 里已经查过的
// plan 行，不额外打 DB。
func TestMeUsageIncludesPlan(t *testing.T) {
	ts, svc, _, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "plan@b.c")
	// isTop 需要能看到 free 之外确实存在更高档，否则 ListPlans 空表会让 isTop
	// 恒真——newBillingServer 不自带种子数据，SeedPlans 补齐工厂四档。
	if err := svc.SeedPlans(t.Context()); err != nil {
		t.Fatalf("SeedPlans: %v", err)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/me/usage", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var body struct {
		Plan struct {
			ID                 string `json:"id"`
			Name               string `json:"name"`
			StorageBytes       int64  `json:"storageBytes"`
			TrafficBytes       int64  `json:"trafficBytes"`
			RetentionSecs      int64  `json:"retentionSecs"`
			PriceMonthly       int64  `json:"priceMonthly"`
			IsTop              bool   `json:"isTop"`
			SubscriptionStatus string `json:"subscriptionStatus"`
			SubscriptionEnd    int64  `json:"subscriptionEnd"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// 新注册用户在免费档。
	if body.Plan.ID != "free" {
		t.Fatalf("plan.id = %q, want \"free\"", body.Plan.ID)
	}
	if body.Plan.Name == "" {
		t.Fatalf("plan.name is empty; the card has nothing to show as the tier label")
	}
	if body.Plan.StorageBytes <= 0 || body.Plan.TrafficBytes <= 0 || body.Plan.RetentionSecs <= 0 {
		t.Fatalf("plan perks = storage %d / traffic %d / retention %d; free tier has finite values for all three",
			body.Plan.StorageBytes, body.Plan.TrafficBytes, body.Plan.RetentionSecs)
	}
	if body.Plan.PriceMonthly != 0 {
		t.Fatalf("plan.priceMonthly = %d, want 0 for the free tier", body.Plan.PriceMonthly)
	}
	// free 不是最高档——否则卡片会把免费用户当成"已是最高档"，把升级入口藏掉。
	if body.Plan.IsTop {
		t.Fatalf("plan.isTop = true for the free tier; the upgrade CTA would be hidden from exactly the users who need it")
	}
	if body.Plan.SubscriptionStatus != "" || body.Plan.SubscriptionEnd != 0 {
		t.Fatalf("subscription = %q/%d, want empty for a user who never checked out",
			body.Plan.SubscriptionStatus, body.Plan.SubscriptionEnd)
	}
}

// 最高档用户不该看到"升级"引导。isTop 由 active plans 里最大的 sort_order 判定。
func TestMeUsageMarksTopTier(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "top@b.c")
	// newBillingServer 起手是空 plans 表；不种子数据 ListPlans 会返回空切片，
	// 下面 "no active plans seeded" 的兜底就会一直命中，测不到真正的 isTop 逻辑。
	if err := svc.SeedPlans(t.Context()); err != nil {
		t.Fatalf("SeedPlans: %v", err)
	}

	plans, err := store.ListPlans(t.Context())
	if err != nil {
		t.Fatalf("ListPlans: %v", err)
	}
	top := Plan{}
	for _, p := range plans {
		if p.Active && p.SortOrder >= top.SortOrder {
			top = p
		}
	}
	if top.ID == "" {
		t.Fatalf("no active plans seeded; cannot exercise isTop")
	}
	u, ok, err := store.UserByCanonicalEmail(t.Context(), "top@b.c")
	if err != nil || !ok {
		t.Fatalf("lookup user: %v ok=%v", err, ok)
	}
	// SetUserPlanAdmin（而非 SetUserPlan）：这里模拟的是管理台把用户改到最高档
	// 这个场景，与 handler 里 s.now() 用同一时钟，避免踩到 accrueQuotaTx 的月度
	// 配额分段折算边界（若两个时钟不一致，折算基准点会跟请求时的 now 对不上，
	// 让测试对时钟漂移变脆弱）。
	if err := store.SetUserPlanAdmin(t.Context(), u.ID, top.ID, svc.now().Unix()); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/me/usage", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	var body struct {
		Plan struct {
			ID    string `json:"id"`
			IsTop bool   `json:"isTop"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Plan.ID != top.ID {
		t.Fatalf("plan.id = %q, want %q", body.Plan.ID, top.ID)
	}
	if !body.Plan.IsTop {
		t.Fatalf("plan.isTop = false on the highest active tier (%q); the card would keep nagging a Max user to upgrade", top.ID)
	}
}

// 卡片宣传的是套餐的**标称**月流量上限，而不是月中改档后按段折算出来的实际
// 可用额度——否则同一档位的用户会因为改档时间不同，在卡片上看到不一样的
// "本档流量"文案。这条用例专门构造"月中改过档"的用户，让 trafficBytes 与
// traffic.cap 出现分歧，从而钉死这条设计约束：如果实现改成直接抄 trafficCap，
// 这里必须失败。
func TestMeUsagePlanTrafficBytesIsNominalNotProrated(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "prorate@b.c")
	mustPlan(t, store, Plan{
		ID: "pro", Name: "Pro", Active: true, SortOrder: 10,
		StorageBytes: 500 << 20, TrafficBytes: 500 << 20, RetentionSecs: 30 * 86400,
		PriceMonthly: 900,
	})

	u, ok, err := store.UserByCanonicalEmail(t.Context(), "prorate@b.c")
	if err != nil || !ok {
		t.Fatalf("lookup user: %v ok=%v", err, ok)
	}
	// 月中改档：把 plan_started_at 挪到本月月初之后，让 accrueQuotaTx 对当月
	// 只折算出一部分上个档的额度，从而让 traffic.cap != pro 档的标称值。
	period := periodOf(svc.now().Unix())
	monthStart, monthEnd := monthRange(period)
	mid := monthStart + (monthEnd-monthStart)/2
	if err := store.SetUserPlanAdmin(t.Context(), u.ID, "pro", mid); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/me/usage", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	var body struct {
		Traffic struct{ Cap int64 } `json:"traffic"`
		Plan    struct {
			TrafficBytes int64 `json:"trafficBytes"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Plan.TrafficBytes != 500<<20 {
		t.Fatalf("plan.trafficBytes = %d, want %d (pro tier's nominal cap)", body.Plan.TrafficBytes, 500<<20)
	}
	if body.Traffic.Cap == body.Plan.TrafficBytes {
		t.Fatalf("test setup didn't actually produce a mid-month proration (traffic.cap == plan.trafficBytes = %d); "+
			"can't tell nominal from prorated with this fixture", body.Traffic.Cap)
	}
}
