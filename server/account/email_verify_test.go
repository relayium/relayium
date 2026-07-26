package account

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestNewUserUnverifiedAndToggle(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, err := st.UpsertUserByEmail(ctx, "a@example.com", "A")
	if err != nil {
		t.Fatal(err)
	}
	if u.EmailVerified {
		t.Fatal("new user should be unverified")
	}
	v, err := st.EmailVerified(ctx, u.ID)
	if err != nil || v {
		t.Fatalf("want false,nil got %v,%v", v, err)
	}
	if err := st.SetEmailVerified(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if v, _ := st.EmailVerified(ctx, u.ID); !v {
		t.Fatal("should be verified after SetEmailVerified")
	}
	got, _ := st.GetUserByID(ctx, u.ID)
	if !got.EmailVerified {
		t.Fatal("GetUserByID should reflect verified")
	}
}

// TestGrandfatherExistingUsers exercises the real migration path: a row
// inserted on the pre-email_verified schema must come out verified once
// OpenSQLite runs its ALTER + grandfather UPDATE over the now non-empty
// users table. A fresh signup made after that migration must still land
// unverified. No manual UPDATE of email_verified appears in this test —
// the migration itself is what's on trial.
func TestGrandfatherExistingUsers(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "gf.db")

	// Step 1: build a pre-migration users table (no email_verified column)
	// and insert one "old" user directly, bypassing OpenSQLite entirely.
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
	const oldUserID = "old-user-1"
	if _, err := raw.ExecContext(ctx,
		`INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)`,
		oldUserID, "old@example.com", "Old", int64(1000)); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}

	// Step 2: open the same file through OpenSQLite. schema's CREATE TABLE
	// IF NOT EXISTS is a no-op (table already exists), so the ALTER ADD
	// COLUMN genuinely fires for the first time here, followed by the
	// grandfather UPDATE — over a users table that already holds oldUserID.
	st, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	if v, err := st.EmailVerified(ctx, oldUserID); err != nil || !v {
		t.Fatalf("pre-existing user should be grandfathered verified, got %v,%v", v, err)
	}

	// Step 3: a signup made after migration relies on DEFAULT 0, not the
	// one-time grandfather UPDATE, so it must be unverified.
	newu, err := st.UpsertUserByEmail(ctx, "new@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	if v, err := st.EmailVerified(ctx, newu.ID); err != nil || v {
		t.Fatalf("new signup should be unverified, got %v,%v", v, err)
	}
}
