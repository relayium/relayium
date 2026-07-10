package account

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"
)

func TestICEUserNodeRoutingAndStrict(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)
	owner, _ := st.UpsertUserByEmail(ctx, "ice@x.com", "i")
	st.SetEmailVerified(ctx, owner.ID)
	st.UpsertNode(ctx, Node{ID: "own", OwnerType: "user", OwnerUserID: owner.ID, URLs: []string{"turn:own:3478"}, TURNSecret: "so", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{ID: "fleet", OwnerType: "fleet", URLs: []string{"turn:fleet:3478"}, TURNSecret: "sf", CreatedAt: 1, LastSeenAt: now.Unix()})

	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:l:3478"}, RelayMonthlyFree: 1 << 30}}
	s.pairCodeOwner = func(code string) (string, bool) { return owner.ID, true }

	ids := func() map[string]bool {
		r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
		w := httptest.NewRecorder()
		s.handleICE(w, r)
		var resp struct {
			Relays []relayEntry `json:"relays"`
		}
		json.Unmarshal(w.Body.Bytes(), &resp)
		m := map[string]bool{}
		for _, e := range resp.Relays {
			m[e.ID] = true
		}
		return m
	}
	// non-strict: own + fleet both present
	m := ids()
	if !m["own"] || !m["fleet"] {
		t.Fatalf("non-strict should include own+fleet, got %v", m)
	}
	// strict: only own
	st.SetOnlyOwnNodes(ctx, owner.ID, true)
	m = ids()
	if !m["own"] || m["fleet"] {
		t.Fatalf("strict should be own-only, got %v", m)
	}
}
