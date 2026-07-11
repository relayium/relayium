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

	// capped: limit 1 GiB, already used 2 GiB this period -> withheld.
	// under:  limit 1 GiB, used 0 -> offered.
	// nolimit: limit 0 (unlimited) -> offered.
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "capped", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix(), TrafficLimitBytes: 1 << 30})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "under", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix(), TrafficLimitBytes: 1 << 30})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "nolimit", URLs: []string{"turn:3.3.3.3:3478"}, TURNSecret: "s", CreatedAt: 1, LastSeenAt: now.Unix()})

	// 2 GiB of usage attributed to "capped" this period.
	st.RecordUsage(ctx, UsageEvent{AllocID: "x", Token: "c", UserID: owner.ID, RelayedBytes: 2 << 30, RecordedAt: now.Unix(), NodeID: "capped", Billable: true})

	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour, RelayMonthlyFree: 1 << 40}}
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
