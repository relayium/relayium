package account

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestNodeOwnerAdminFleetToken(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	// EnableUserNodes true so the hashed-lookup branch runs; no env NodeToken.
	s := &Service{store: st, cfg: Config{EnableUserNodes: true}, now: func() time.Time { return time.Unix(5000, 0) }}

	raw := "admin-minted-secret"
	st.CreateFleetToken(ctx, FleetToken{ID: "ft1", TokenHash: hashToken(raw), Name: "sh", CreatedAt: 1})

	r, _ := http.NewRequest("POST", "/", nil)
	r.Header.Set("Authorization", "Bearer "+raw)
	ot, uid, ok := s.nodeOwner(r)
	if !ok || ot != "fleet" || uid != "" {
		t.Fatalf("admin fleet token: got (%q,%q,%v)", ot, uid, ok)
	}

	// A revoked token no longer authenticates.
	st.RevokeFleetToken(ctx, "ft1", 2)
	if _, _, ok := s.nodeOwner(r); ok {
		t.Fatal("revoked fleet token must not authenticate")
	}
}
