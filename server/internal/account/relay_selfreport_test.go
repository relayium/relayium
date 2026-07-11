package account

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A forged huge single report is capped to the absolute per-allocation ceiling,
// so a malicious node can't blow a user's quota / the billing ledger with 1<<50.
func TestRecordUsageClampsForgedReport(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "c@example.com", "C")
	if err := s.RecordUsage(ctx, UsageEvent{AllocID: "huge", Token: "t", UserID: u.ID, RelayedBytes: 1 << 50, RecordedAt: 1000}); err != nil {
		t.Fatal(err)
	}
	got, _ := s.UserUsageTotal(ctx, u.ID)
	if got != maxAllocRelayBytes {
		t.Fatalf("forged report total = %d, want capped at %d", got, maxAllocRelayBytes)
	}
}

// A huge jump between two heartbeats is clamped to prior + bandwidth×elapsed +
// slack, while an in-budget report is accepted in full.
func TestRecordUsageDeltaCapBoundsGrowth(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "d@example.com", "D")
	total := func() int64 { v, _ := s.UserUsageTotal(ctx, u.ID); return v }

	// First report of 1 MiB at t=1000.
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a", Token: "t", UserID: u.ID, RelayedBytes: 1 << 20, RecordedAt: 1000})
	// 30s later, a forged 1 TiB jump is clamped to the 30s budget.
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a", Token: "t", UserID: u.ID, RelayedBytes: 1 << 40, RecordedAt: 1030})
	budget := int64(1<<20) + maxRelayBytesPerSec*30 + relayReportSlack
	if got := total(); got != budget {
		t.Fatalf("delta-capped total = %d, want %d", got, budget)
	}
	// A further in-budget report (prior + 100 MiB, 30s later) is accepted whole.
	legit := total() + (100 << 20)
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a", Token: "t", UserID: u.ID, RelayedBytes: legit, RecordedAt: 1060})
	if got := total(); got != legit {
		t.Fatalf("in-budget report not accepted: got %d want %d", got, legit)
	}
}

// A fleet node forging attribution to a user who is not the pairing code's real
// owner is dropped; a report matching the code's owner is recorded.
func TestHeartbeatDropsForgedAttribution(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	attacker, _ := st.UpsertUserByEmail(ctx, "atk@x.com", "a")
	victim, _ := st.UpsertUserByEmail(ctx, "vic@x.com", "v")
	// A fleet node (billable), authed with the shared fleet token.
	n, _ := st.UpsertNode(ctx, Node{ID: "fn", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: 1})
	s := &Service{store: st, cfg: Config{NodeToken: "fleet-secret"}, now: func() time.Time { return time.Unix(50, 0) }}
	// "goodcode" belongs to the attacker; central still resolves it live.
	s.SetPairCodeOwner(func(code string) (string, bool) {
		if code == "goodcode" {
			return attacker.ID, true
		}
		return "", false
	})
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	hb := nodeHeartbeatReq{NodeID: n.ID, Status: "ok", Usage: []nodeUsage{
		{AllocID: "a1", Username: "9999:" + attacker.ID + ".goodcode", RelayedBytes: 4000}, // legit
		{AllocID: "a2", Username: "9999:" + victim.ID + ".goodcode", RelayedBytes: 7000},   // forged: code owner != victim
	}}
	body, _ := json.Marshal(hb)
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d body=%s", w.Code, w.Body)
	}
	if q, _ := st.UserRelayedSince(ctx, attacker.ID, 0); q != 4000 {
		t.Fatalf("legit attribution: attacker quota = %d, want 4000", q)
	}
	if q, _ := st.UserRelayedSince(ctx, victim.ID, 0); q != 0 {
		t.Fatalf("forged attribution must be dropped: victim quota = %d, want 0", q)
	}
}
