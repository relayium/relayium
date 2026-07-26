package account

import (
	"context"
	"testing"
)

func TestEmailTokenAtomicSingleUse(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "t@example.com", "")
	tok := EmailToken{
		TokenHash: "hash1", UserID: u.ID, Email: "t@example.com",
		Purpose: "verify", CreatedAt: 100, ExpiresAt: 1000,
	}
	if err := st.CreateEmailToken(ctx, tok); err != nil {
		t.Fatal(err)
	}
	// wrong purpose is rejected
	if _, ok, _ := st.UseEmailToken(ctx, "hash1", "reset", 200); ok {
		t.Fatal("wrong purpose must not claim")
	}
	// first correct claim wins
	got, ok, err := st.UseEmailToken(ctx, "hash1", "verify", 200)
	if err != nil || !ok || got.UserID != u.ID {
		t.Fatalf("first claim failed: ok=%v err=%v", ok, err)
	}
	// second claim fails (one-time)
	if _, ok, _ := st.UseEmailToken(ctx, "hash1", "verify", 201); ok {
		t.Fatal("second claim must fail")
	}
}

func TestEmailTokenExpired(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "e@example.com", "")
	_ = st.CreateEmailToken(ctx, EmailToken{
		TokenHash: "h2", UserID: u.ID, Email: "e@example.com",
		Purpose: "reset", CreatedAt: 1, ExpiresAt: 10,
	})
	if _, ok, _ := st.UseEmailToken(ctx, "h2", "reset", 11); ok {
		t.Fatal("expired token must not claim")
	}
}
