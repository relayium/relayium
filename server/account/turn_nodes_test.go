package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestICEIncludesOnlineNodes(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(10000, 0)

	// handleICE denies relay for an unverified owner or one over the relay quota.
	// Seed a verified user and use its id as the pairing-code owner so those two
	// upstream gates pass and we actually reach the relay-pool builder.
	owner, err := st.UpsertUserByEmail(ctx, "u@example.com", "u")
	if err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := st.SetEmailVerified(ctx, owner.ID); err != nil {
		t.Fatalf("verify user: %v", err)
	}

	// One online node (last_seen just now) and one offline (stale).
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "n-online", URLs: []string{"turn:1.1.1.1:3478"}, TURNSecret: "s1", CreatedAt: 1, LastSeenAt: now.Unix()})
	st.UpsertNode(ctx, Node{OwnerType: "fleet", ID: "n-stale", URLs: []string{"turn:2.2.2.2:3478"}, TURNSecret: "s2", CreatedAt: 1, LastSeenAt: now.Unix() - 1000})

	// The per-plan traffic gate falls back to the Free plan's 2GB cap when no
	// plan row/table is seeded, so a freshly-verified owner with 0 usage always
	// passes it here.
	s := &Service{store: st, now: func() time.Time { return now },
		cfg: Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:stun.l:3478"}}}
	s.pairCodeOwner = func(code string) (string, bool) { return owner.ID, true }

	r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
	w := httptest.NewRecorder()
	s.handleICE(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("ice: %d", w.Code)
	}
	var resp struct {
		Relays []relayEntry `json:"relays"`
	}
	json.Unmarshal(w.Body.Bytes(), &resp)
	ids := map[string]bool{}
	for _, e := range resp.Relays {
		ids[e.ID] = true
	}
	if !ids["n-online"] {
		t.Fatalf("expected online node in relays, got %+v", resp.Relays)
	}
	if ids["n-stale"] {
		t.Fatalf("stale node must be excluded, got %+v", resp.Relays)
	}
}
