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

// A long-lived allocation spanning a month boundary must be billed to each
// month by the bytes it actually relayed that month — not have its whole
// cumulative reattributed to the latest heartbeat's month (the keep-max drift).
func TestRecordUsageAttributesDeltaPerMonth(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "m@example.com", "M")
	jun := time.Date(2026, 6, 15, 12, 0, 0, 0, time.UTC).Unix()
	jul := time.Date(2026, 7, 5, 12, 0, 0, 0, time.UTC).Unix()
	junStart := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC).Unix()
	julStart := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).Unix()

	// Same alloc: 100 relayed in June, then cumulative 300 by July (200 more).
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "x", Token: "c", UserID: u.ID, RelayedBytes: 100, RecordedAt: jun, Billable: true})
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "x", Token: "c", UserID: u.ID, RelayedBytes: 300, RecordedAt: jul, Billable: true})

	if got, _ := s.UserRelayedSince(ctx, u.ID, junStart); got != 300 {
		t.Fatalf("June onward = %d, want 300 (100 June + 200 July)", got)
	}
	if got, _ := s.UserRelayedSince(ctx, u.ID, julStart); got != 200 {
		t.Fatalf("July only = %d, want 200 (the July delta, not the whole 300)", got)
	}
}

// The one-time backfill on first creation of usage_periods must preserve each
// legacy allocation's total (attributed to its last-recorded month), so an
// upgrade doesn't change anyone's current billing numbers.
func TestUsagePeriodsBackfillPreservesTotals(t *testing.T) {
	ctx := context.Background()
	dsn := t.TempDir() + "/acct.db"

	s, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatal(err)
	}
	// Simulate a legacy DB: a usage_events row with no usage_periods counterpart.
	jul := time.Date(2026, 7, 10, 12, 0, 0, 0, time.UTC).Unix()
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO usage_events (alloc_id, token, user_id, relayed_bytes, recorded_at, node_id, billable)
		 VALUES ('leg', 'c', 'u', 4242, ?, 'N', 1)`, jul); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `DROP TABLE usage_periods`); err != nil {
		t.Fatal(err)
	}
	s.Close()

	// Reopen: migration recreates usage_periods and backfills from usage_events.
	s2, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	julStart := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC).Unix()
	if got, _ := s2.UserRelayedSince(ctx, "u", julStart); got != 4242 {
		t.Fatalf("backfilled July total = %d, want 4242", got)
	}
	if m, _ := s2.NodeRelayedSince(ctx, julStart); m["N"] != 4242 {
		t.Fatalf("backfilled node total = %d, want 4242", m["N"])
	}
}

// The heartbeat response must carry the node's hard caps and its
// central-authoritative month-to-date relayed total, so the node can enforce
// them locally (workstream B).
func TestHeartbeatResponseCarriesLimits(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	n, _ := st.UpsertNode(ctx, Node{
		ID: "fn", OwnerType: "fleet", URLs: []string{"turn:x:3478"}, TURNSecret: "s",
		TrafficLimitBytes: 5000, DiskLimitBytes: 9000, CreatedAt: 1, LastSeenAt: 1,
	})
	s := &Service{store: st, cfg: Config{NodeToken: "fleet-secret"}, now: func() time.Time { return time.Unix(50, 0) }}
	mux := http.NewServeMux()
	s.RegisterNodeRoutes(mux)

	// A heartbeat that also reports 1234 relayed bytes for this node.
	hb := nodeHeartbeatReq{NodeID: n.ID, Status: "ok", Usage: []nodeUsage{
		{AllocID: "a1", Username: "9999:someuser.code", RelayedBytes: 1234},
	}}
	body, _ := json.Marshal(hb)
	r := httptest.NewRequest("POST", "/api/nodes/heartbeat", bytes.NewReader(body))
	r.Header.Set("Authorization", "Bearer fleet-secret")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("heartbeat: %d body=%s", w.Code, w.Body)
	}
	var resp nodeHeartbeatResp
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.TrafficLimitBytes != 5000 || resp.DiskLimitBytes != 9000 {
		t.Fatalf("caps = traffic %d disk %d, want 5000/9000", resp.TrafficLimitBytes, resp.DiskLimitBytes)
	}
	if resp.RelayedThisMonth != 1234 {
		t.Fatalf("relayedThisMonth = %d, want 1234 (includes this heartbeat)", resp.RelayedThisMonth)
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
