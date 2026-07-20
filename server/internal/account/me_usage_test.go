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
	// 逐字段精确断言，而不是只判正负：免费档的存储(100 MB)与流量(1 GB)是两个**不同**
	// 的数，所以把 handler 里这两行的数据源写反会在这里失败。只判 `> 0` 的话对调后
	// 依旧全绿，而代价是免费用户的会员卡直接印出"1 GB 存储 · 100 MB/月流量"——错在
	// 变现界面上。（Task 8 在前端 perks() 上抓到过同一个 bug 类，服务端这半边同样要钉。）
	const freeStorage, freeTraffic = int64(100) << 20, int64(1) << 30
	if body.Plan.StorageBytes != freeStorage {
		t.Fatalf("plan.storageBytes = %d, want %d (free tier's 100 MB); if this equals the traffic cap, the two fields' sources are swapped",
			body.Plan.StorageBytes, freeStorage)
	}
	if body.Plan.TrafficBytes != freeTraffic {
		t.Fatalf("plan.trafficBytes = %d, want %d (free tier's 1 GB); if this equals the storage cap, the two fields' sources are swapped",
			body.Plan.TrafficBytes, freeTraffic)
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

// 同一条守卫的 DB 版：上一条走的是免费档（可能命中 freePlanFallback 的内存常量），
// 这条把一个**自定义**档写进 plans 表再断言，钉死"plan 行 → JSON 字段"这段映射本身。
// 两个额度取彼此相差一个数量级的值，且与响应里其它数字都不相同，所以任何把
// storageBytes/trafficBytes 数据源接错的改动都躲不过去。
func TestMeUsagePlanStorageAndTrafficAreNotSwapped(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "swap@b.c")
	// 刻意选互不相同、也不与 retention/price 相同的值。
	const wantStorage int64 = 7 << 30   // 7516192768
	const wantTraffic int64 = 300 << 30 // 322122547200
	const wantRetention int64 = 45 * 86400
	const wantPrice int64 = 1290
	mustPlan(t, store, Plan{
		ID: "swaptest", Name: "SwapTest", Active: true, SortOrder: 10,
		StorageBytes: wantStorage, TrafficBytes: wantTraffic, RetentionSecs: wantRetention,
		PriceMonthly: wantPrice,
	})

	u, ok, err := store.UserByCanonicalEmail(t.Context(), "swap@b.c")
	if err != nil || !ok {
		t.Fatalf("lookup user: %v ok=%v", err, ok)
	}
	// plan_started_at 取很早的时间点，避开 accrueQuotaTx 的月中折算，让这条用例只
	// 考察字段映射。
	if err := store.SetUserPlanAdmin(t.Context(), u.ID, "swaptest", 1); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
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
			StorageBytes  int64 `json:"storageBytes"`
			TrafficBytes  int64 `json:"trafficBytes"`
			RetentionSecs int64 `json:"retentionSecs"`
			PriceMonthly  int64 `json:"priceMonthly"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// 鉴别力自检：四个数必须两两不同，否则下面的断言可能被错误的源字段满足。
	fixtures := map[string]int64{
		"storageBytes": wantStorage, "trafficBytes": wantTraffic,
		"retentionSecs": wantRetention, "priceMonthly": wantPrice,
	}
	for aName, a := range fixtures {
		for bName, b := range fixtures {
			if aName < bName && a == b {
				t.Fatalf("fixture %s and %s are both %d; pick distinct values or a swapped source would still satisfy the assertions", aName, bName, a)
			}
		}
	}
	if body.Plan.StorageBytes != wantStorage {
		t.Fatalf("plan.storageBytes = %d, want %d (got the traffic cap? the two fields' sources are swapped)", body.Plan.StorageBytes, wantStorage)
	}
	if body.Plan.TrafficBytes != wantTraffic {
		t.Fatalf("plan.trafficBytes = %d, want %d (got the storage cap? the two fields' sources are swapped)", body.Plan.TrafficBytes, wantTraffic)
	}
	if body.Plan.RetentionSecs != wantRetention {
		t.Fatalf("plan.retentionSecs = %d, want %d", body.Plan.RetentionSecs, wantRetention)
	}
	if body.Plan.PriceMonthly != wantPrice {
		t.Fatalf("plan.priceMonthly = %d, want %d", body.Plan.PriceMonthly, wantPrice)
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

// isTop 必须 fail-closed：枚举不到 plans（ListPlans 出错，或 plans 表为空）时
// 判 false，而不是 true。方向写反的代价极不对称——恒 true 会让**所有**用户的
// 会员卡都显示"已是最高档"、升级入口全站消失且无人察觉。
//
// 这里走"空 plans 表"这条路径：newBillingServer 本来就不播种 plans，是天然的
// 空表场景（也正是 ListPlans 成功但无从判断档位高低的情形）。此时 GetPlan 查不
// 到用户的 free 档，handler 回落到 freePlanFallback()，依旧不得宣称最高档。
func TestMeUsageIsTopFailsClosedWithoutPlans(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "noplans@b.c")

	// 自检：这条用例的前提是 plans 表确实是空的。若将来 newBillingServer 改成
	// 自带种子数据，这里会立刻报错，而不是悄悄退化成一条测不到东西的用例。
	plans, err := store.ListPlans(t.Context())
	if err != nil {
		t.Fatalf("ListPlans: %v", err)
	}
	if len(plans) != 0 {
		t.Fatalf("fixture seeds %d plans; this case needs an empty plans table to exercise the fail-closed path", len(plans))
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
			IsTop bool `json:"isTop"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Plan.IsTop {
		t.Fatalf("plan.isTop = true with no plans enumerable; a DB hiccup would tell every user (free ones included) they are already on the top tier and hide the upgrade CTA site-wide")
	}
}

// subscriptionStatus/subscriptionEnd 是 Task 6/8 用来渲染"订阅状态 + 到期日"的
// 两个字段。之前所有用例里的用户在这两个字段上都恰好是零值，把实现硬编码成
// ""/0 也全绿——字段接错源（例如误接 u.PlanSource）不会有任何报警。这条用例给
// 用户写入非零、彼此不同、且与响应里其它数值都不相同的订阅数据，钉死透传。
func TestMeUsagePassesThroughSubscriptionFields(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "sub@b.c")
	mustPlan(t, store, Plan{
		ID: "pro", Name: "Pro", Active: true, SortOrder: 10,
		StorageBytes: 500 << 20, TrafficBytes: 500 << 20, RetentionSecs: 30 * 86400,
		PriceMonthly: 900,
	})

	u, ok, err := store.UserByCanonicalEmail(t.Context(), "sub@b.c")
	if err != nil || !ok {
		t.Fatalf("lookup user: %v ok=%v", err, ok)
	}
	// 走 Stripe webhook 的落库路径（plan_id + subscription_status +
	// subscription_end + plan_source 一次写全），而不是直接写 SQL。
	//
	// wantStatus 刻意选 "past_due" 而不是常见的 "active"：它同时不等于 plan.id
	// ("pro")、plan.name ("Pro") 和 plan_source ("stripe")，所以实现若把
	// subscriptionStatus 接到别的字符串字段上，断言必然失败。
	// wantEnd 选 1234567891——见下面的碰撞自检。
	const wantStatus = "past_due"
	const wantEnd int64 = 1234567891
	if err := store.SetUserSubscription(t.Context(), u.ID, "pro", wantStatus, wantEnd, "stripe", svc.now().Unix()); err != nil {
		t.Fatalf("SetUserSubscription: %v", err)
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
		ResetsAt int64                     `json:"resetsAt"`
		Traffic  struct{ Used, Cap int64 } `json:"traffic"`
		Storage  struct{ Used, Cap int64 } `json:"storage"`
		Plan     struct {
			ID                 string `json:"id"`
			Name               string `json:"name"`
			StorageBytes       int64  `json:"storageBytes"`
			TrafficBytes       int64  `json:"trafficBytes"`
			RetentionSecs      int64  `json:"retentionSecs"`
			PriceMonthly       int64  `json:"priceMonthly"`
			SubscriptionStatus string `json:"subscriptionStatus"`
			SubscriptionEnd    int64  `json:"subscriptionEnd"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Plan.SubscriptionStatus != wantStatus {
		t.Fatalf("plan.subscriptionStatus = %q, want %q", body.Plan.SubscriptionStatus, wantStatus)
	}
	if body.Plan.SubscriptionEnd != wantEnd {
		t.Fatalf("plan.subscriptionEnd = %d, want %d", body.Plan.SubscriptionEnd, wantEnd)
	}
	// 碰撞自检：上面两条断言只有在 wantEnd 不与响应里任何**其它**数值相等时才
	// 真正证明"接对了源"。把这个前提显式验证掉，否则将来某个字段偶然变成同一个
	// 数，断言就会被别人满足而失去鉴别力。
	others := map[string]int64{
		"resetsAt":           body.ResetsAt,
		"traffic.used":       body.Traffic.Used,
		"traffic.cap":        body.Traffic.Cap,
		"storage.used":       body.Storage.Used,
		"storage.cap":        body.Storage.Cap,
		"plan.storageBytes":  body.Plan.StorageBytes,
		"plan.trafficBytes":  body.Plan.TrafficBytes,
		"plan.retentionSecs": body.Plan.RetentionSecs,
		"plan.priceMonthly":  body.Plan.PriceMonthly,
	}
	for name, v := range others {
		if v == wantEnd {
			t.Fatalf("subscriptionEnd fixture %d collides with %s; pick a different value or the assertion could be satisfied by the wrong source field", wantEnd, name)
		}
	}
	if body.Plan.ID == wantStatus || body.Plan.Name == wantStatus {
		t.Fatalf("subscriptionStatus fixture %q collides with plan.id/%q or plan.name/%q", wantStatus, body.Plan.ID, body.Plan.Name)
	}
}

// nonNegCap 的规约：档位里用负数表示"无限"（包内内部约定），对外一律规约成 0，
// 前端只判断一个值。没有这条用例，把 nonNegCap 改成直接返回原值不会有任何测试
// 报警，前端会拿到负数并把它当成一个真实的（负的）额度渲染。
func TestMeUsageNegativePlanCapsNormalizeToZero(t *testing.T) {
	ts, _, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "unlimited@b.c")
	mustPlan(t, store, Plan{
		ID: "unlimited", Name: "Unlimited", Active: true, SortOrder: 99,
		StorageBytes: -1, TrafficBytes: -1, RetentionSecs: -1,
		PriceMonthly: 9900,
	})

	u, ok, err := store.UserByCanonicalEmail(t.Context(), "unlimited@b.c")
	if err != nil || !ok {
		t.Fatalf("lookup user: %v ok=%v", err, ok)
	}
	if err := store.SetUserPlanAdmin(t.Context(), u.ID, "unlimited", 1); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
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
			StorageBytes  int64 `json:"storageBytes"`
			TrafficBytes  int64 `json:"trafficBytes"`
			RetentionSecs int64 `json:"retentionSecs"`
		} `json:"plan"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Plan.TrafficBytes != 0 {
		t.Fatalf("plan.trafficBytes = %d, want 0 (negative means unlimited internally; the wire contract is 0)", body.Plan.TrafficBytes)
	}
	if body.Plan.RetentionSecs != 0 {
		t.Fatalf("plan.retentionSecs = %d, want 0 (negative means unlimited internally; the wire contract is 0)", body.Plan.RetentionSecs)
	}
	if body.Plan.StorageBytes != 0 {
		t.Fatalf("plan.storageBytes = %d, want 0 (negative means unlimited internally; the wire contract is 0)", body.Plan.StorageBytes)
	}
}
