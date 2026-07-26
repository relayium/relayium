package account

import (
	"context"
	"testing"
)

func TestNodeTokenLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "n@x.com", "n")

	tok := NodeToken{ID: "t1", TokenHash: "hashA", UserID: u.ID, Name: "home", CreatedAt: 100}
	if err := st.CreateNodeToken(ctx, tok); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, ok, err := st.NodeTokenByHash(ctx, "hashA")
	if err != nil || !ok || got.UserID != u.ID || got.ID != "t1" {
		t.Fatalf("byhash: %+v ok=%v err=%v", got, ok, err)
	}
	if err := st.BindNodeToken(ctx, "t1", "node-9"); err != nil {
		t.Fatalf("bind: %v", err)
	}
	if list, _ := st.ListNodeTokensByUser(ctx, u.ID); len(list) != 1 || list[0].NodeID != "node-9" {
		t.Fatalf("list: %+v", list)
	}
	// Owner-scoped revoke: a different user cannot revoke it.
	if err := st.RevokeNodeToken(ctx, "t1", "someone-else", 200); err != nil {
		t.Fatalf("revoke wrong-owner should be a no-op nil, got %v", err)
	}
	if _, ok, _ := st.NodeTokenByHash(ctx, "hashA"); !ok {
		t.Fatal("token wrongly revoked by non-owner")
	}
	// Correct owner revokes -> lookup now returns ok=false.
	if err := st.RevokeNodeToken(ctx, "t1", u.ID, 200); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok, _ := st.NodeTokenByHash(ctx, "hashA"); ok {
		t.Fatal("revoked token must not resolve")
	}
}
