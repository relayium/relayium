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
		cfg: Config{TURNCredTTL: time.Hour, STUNURLs: []string{"stun:l:3478"},
			TURNSecret: "ourturnsecret", TURNURLs: []string{"turn:ours:3478"}}}
	s.pairCodeOwner = func(code string) (string, bool) { return owner.ID, true }

	// legacyTURNOffered reports whether the top-level (non-relays) iceServers
	// list contains our legacy single-TURN entry, identified by its URL.
	legacyTURNOffered := func(resp struct {
		ICEServers []ICEServer  `json:"iceServers"`
		Relays     []relayEntry `json:"relays"`
	}) bool {
		for _, srv := range resp.ICEServers {
			for _, u := range srv.URLs {
				if u == "turn:ours:3478" {
					return true
				}
			}
		}
		return false
	}

	get := func() (map[string]bool, bool) {
		r := httptest.NewRequest("GET", "/api/ice?code=123456", nil)
		w := httptest.NewRecorder()
		s.handleICE(w, r)
		var resp struct {
			ICEServers []ICEServer  `json:"iceServers"`
			Relays     []relayEntry `json:"relays"`
		}
		json.Unmarshal(w.Body.Bytes(), &resp)
		m := map[string]bool{}
		for _, e := range resp.Relays {
			m[e.ID] = true
		}
		return m, legacyTURNOffered(resp)
	}
	// non-strict: own + fleet both present, and our legacy top-level TURN is offered
	m, legacy := get()
	if !m["own"] || !m["fleet"] {
		t.Fatalf("non-strict should include own+fleet, got %v", m)
	}
	if !legacy {
		t.Fatalf("non-strict should offer our legacy top-level TURN, got iceServers without it")
	}
	// strict: only own, and our legacy top-level TURN is withheld (only STUN remains)
	st.SetOnlyOwnNodes(ctx, owner.ID, true)
	m, legacy = get()
	if !m["own"] || m["fleet"] {
		t.Fatalf("strict should be own-only, got %v", m)
	}
	if legacy {
		t.Fatalf("strict should withhold our legacy top-level TURN, got it present in iceServers")
	}
}
