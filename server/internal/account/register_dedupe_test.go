package account

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
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

// TestBackfillCanonicalEmailComputesRealValues exercises the actual migration
// path (like TestGrandfatherExistingUsers): a genuine pre-canonical_email
// `users` table, populated directly (bypassing OpenSQLite), then opened
// through OpenSQLite so the ALTER + backfillCanonicalEmail genuinely fire. It
// asserts each row's resulting canonical_email against canonicalEmail(email)
// directly, so a mutant backfill (e.g. one that copies email verbatim, or
// blanks the column, or dot-folds non-gmail domains) fails this test even
// though every other suite in this package only ever checks email_verified on
// the same migration.
func TestBackfillCanonicalEmailComputesRealValues(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "backfill.db")

	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	const preMigrationSchema = `CREATE TABLE users (
		id           TEXT PRIMARY KEY,
		email        TEXT UNIQUE NOT NULL,
		display_name TEXT,
		created_at   INTEGER NOT NULL
	)`
	if _, err := raw.ExecContext(ctx, preMigrationSchema); err != nil {
		t.Fatal(err)
	}
	rows := []struct{ id, email string }{
		{"old-1", "a.b+tag@gmail.com"},   // gmail: dot-fold + strip tag -> ab@gmail.com
		{"old-2", "c+work@example.com"},  // non-gmail: strip tag only -> c@example.com
		{"old-3", "d.e@example.com"},     // non-gmail: dots NOT folded -> d.e@example.com
	}
	for i, r := range rows {
		if _, err := raw.ExecContext(ctx,
			`INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`,
			r.id, r.email, "", int64(1000+i)); err != nil {
			t.Fatal(err)
		}
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	for _, r := range rows {
		want := canonicalEmail(r.email)
		var got string
		if err := st.db.QueryRowContext(ctx,
			`SELECT canonical_email FROM users WHERE id = ?`, r.id).Scan(&got); err != nil {
			t.Fatalf("query %s: %v", r.id, err)
		}
		if got != want {
			t.Fatalf("row %s (%s): canonical_email = %q, want %q", r.id, r.email, got, want)
		}
	}
}
