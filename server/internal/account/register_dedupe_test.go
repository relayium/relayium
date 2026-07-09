package account

import (
	"context"
	"errors"
	"testing"
)

// TestRegisterCanonicalDedupeGmail covers the classic Gmail Sybil mint: dot-fold
// and +tag variants of an already-registered gmail address must be rejected.
func TestRegisterCanonicalDedupeGmail(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	if _, err := svc.Register(ctx, "a@gmail.com", "longenough1", ""); err != nil {
		t.Fatalf("first register: %v", err)
	}
	if _, err := svc.Register(ctx, "a+x@gmail.com", "longenough2", ""); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("+tag variant: want ErrEmailTaken, got %v", err)
	}

	if _, err := svc.Register(ctx, "a.b@gmail.com", "longenough3", ""); err != nil {
		t.Fatalf("second register: %v", err)
	}
	if _, err := svc.Register(ctx, "ab@gmail.com", "longenough4", ""); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("dot-fold variant: want ErrEmailTaken, got %v", err)
	}
}

// TestRegisterCanonicalDedupeNonGmail confirms non-gmail domains only get +tag
// stripping, NOT dot-folding: dots in the local part remain significant.
func TestRegisterCanonicalDedupeNonGmail(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	if _, err := svc.Register(ctx, "a.b@example.com", "longenough1", ""); err != nil {
		t.Fatalf("first register: %v", err)
	}
	// Different local part (dots not merged for non-gmail) → not taken.
	if _, err := svc.Register(ctx, "a.c@example.com", "longenough2", ""); err != nil {
		t.Fatalf("distinct local part should register fine, got %v", err)
	}
	// Same local part modulo +tag → taken.
	if _, err := svc.Register(ctx, "a.b+tag@example.com", "longenough3", ""); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("+tag on same local part: want ErrEmailTaken, got %v", err)
	}
}

// TestRegisterCanonicalDedupeLoginUnaffected proves the dedupe only gates
// registration; login/identity keeps using the exact normalized email
// (normEmail), so a canonical sibling address must NOT be able to log in.
func TestRegisterCanonicalDedupeLoginUnaffected(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	u, err := svc.Register(ctx, "a.b@gmail.com", "longenough1", "")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	if err := svc.store.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatalf("verify: %v", err)
	}

	if _, err := svc.Login(ctx, "a.b@gmail.com", "longenough1"); err != nil {
		t.Fatalf("exact login should succeed: %v", err)
	}
	if _, err := svc.Login(ctx, "ab@gmail.com", "longenough1"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("canonical-sibling login must fail: want ErrBadCredentials, got %v", err)
	}
}

// TestRegisterCanonicalDedupeSetsColumnOnInsert proves UpsertUserByEmail (the
// only user-INSERT path) populates canonical_email on every insert, which is
// what makes freshly created rows immediately dedupe-able (the ALTER-path
// backfill only matters for pre-existing rows on a legacy DB upgrade).
func TestRegisterCanonicalDedupeSetsColumnOnInsert(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	if _, err := s.UpsertUserByEmail(ctx, "legacy+tag@gmail.com", ""); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	u, ok, err := s.UserByCanonicalEmail(ctx, "legacy@gmail.com")
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if !ok {
		t.Fatal("canonical lookup should find the inserted row")
	}
	if u.Email != "legacy+tag@gmail.com" {
		t.Fatalf("unexpected user returned: %+v", u)
	}
}
