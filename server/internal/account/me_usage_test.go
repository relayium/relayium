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
