package account

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestICEWithholdsFleetNodeOverTrafficLimit(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1_700_000_000, 0) // some month; NodeRelayedSince uses its month start

	owner, _ := st.UpsertUserByEmail(ctx, "u@example.com", "u")
	st.SetEmailVerified(ctx, owner.ID)
	// This test isolates the per-node traffic cap (below) from the separate
	// owner-level plan traffic gate (turn.go's overTraffic check). The owner
	// defaults to the "free" plan_id with no plans row seeded here, so
	// planForUser falls back to defaultPlans()'s Free tier (1 GiB as of the
	// 2026-07 pricing change) — well under the 2 GiB this test records, which
	// would otherwise trip relayDenied="quota" and withhold every node, not
	// just the over-node-cap one. Give the owner an effectively unlimited plan
	// cap so only the per-node TrafficLimitBytes checks below are exercised.
	if err := st.UpsertPlan(ctx, Plan{ID: "free", Name: "Free", StorageBytes: 1 << 30,
		TrafficBytes: 1 << 40, RetentionSecs: 86400, Active: true, UpdatedAt: 1}); err != nil {
		t.Fatalf("UpsertPlan: %v", err)
	}

	// capped: limit 1 GiB, already used 2 GiB this period -> withheld.
	// under:  limit 1 GiB, used 0 -> offered.
	// nolimit: limit 0 -> inherits Settings.NodeTrafficDefault (resolveNodeTrafficLimit).
	// This test's Service is built with no NodeTrafficDefault set in Config and no
	// SettingNodeTrafficDefault row in the store, so that default resolves to 0
	// too, and 0 still means "unlimited" end-to-end (usableTraffic/resolveNodeTrafficLimit
	// both treat <=0 as no cap) -> offered.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "capped", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix(), TrafficLimitBytes: 1 << 30})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "under", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix(), TrafficLimitBytes: 1 << 30})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "nolimit", URLs: []string{"turn:3.3.3.3:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix()})

	// 2 GiB of usage attributed to "capped" this period.
	st.RecordUsage(ctx, UsageEvent{AllocID: "x", Token: "c", UserID: owner.ID, RelayedBytes: 2 << 30, RecordedAt: now.Unix(), NodeID: "capped", Billable: true})

	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour}}
	s.pairCodeOwner = func(string) (string, bool) { return owner.ID, true }

	r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
	w := httptest.NewRecorder()
	s.handleICE(w, r)

	var resp struct {
		Relays []relayEntry `json:"relays"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	ids := map[string]bool{}
	for _, e := range resp.Relays {
		ids[e.ID] = true
	}
	if ids["capped"] {
		t.Fatal("over-limit fleet node must be withheld")
	}
	if !ids["under"] || !ids["nolimit"] {
		t.Fatalf("under-limit and unlimited nodes must be offered, got %+v", resp.Relays)
	}
}
