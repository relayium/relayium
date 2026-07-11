package account

import (
	"context"
	"testing"
)

func TestFleetTokenLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	tok := FleetToken{ID: "ft1", TokenHash: hashToken("raw-secret"), Name: "sh-1", CreatedAt: 100}
	if err := st.CreateFleetToken(ctx, tok); err != nil {
		t.Fatalf("create: %v", err)
	}

	// Resolvable by hash while active.
	got, ok, err := st.FleetTokenByHash(ctx, hashToken("raw-secret"))
	if err != nil || !ok || got.ID != "ft1" || got.Name != "sh-1" {
		t.Fatalf("byhash active: got=%+v ok=%v err=%v", got, ok, err)
	}

	// Bind to a node, then it shows up in the active list.
	if err := st.BindFleetToken(ctx, "ft1", "node-9"); err != nil {
		t.Fatalf("bind: %v", err)
	}
	active, err := st.ListActiveFleetTokens(ctx)
	if err != nil || len(active) != 1 || active[0].NodeID != "node-9" {
		t.Fatalf("list active: %+v err=%v", active, err)
	}

	// Revoke -> no longer resolvable, no longer listed.
	if err := st.RevokeFleetToken(ctx, "ft1", 200); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok, _ := st.FleetTokenByHash(ctx, hashToken("raw-secret")); ok {
		t.Fatal("revoked token must not resolve")
	}
	if active, _ := st.ListActiveFleetTokens(ctx); len(active) != 0 {
		t.Fatalf("revoked token must not be listed, got %+v", active)
	}
}
