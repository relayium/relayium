package account

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

func rawMigDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "m.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	return db
}

func evOf(t *testing.T, db *sql.DB, id string) int {
	t.Helper()
	var v int
	if err := db.QueryRow(`SELECT email_verified FROM users WHERE id = ?`, id).Scan(&v); err != nil {
		t.Fatalf("read email_verified for %s: %v", id, err)
	}
	return v
}

func markerCount(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE id = 'grandfather_email_verified'`).Scan(&n); err != nil {
		t.Fatalf("count marker: %v", err)
	}
	return n
}

func hasColumn(t *testing.T, db *sql.DB, table, col string) bool {
	t.Helper()
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ok, err := columnExistsTx(tx, table, col)
	if err != nil {
		t.Fatal(err)
	}
	return ok
}

// A pre-email-verification DB (no email_verified column) has all its existing
// users grandfathered to verified when the column is first added.
func TestMigrateEmailVerifiedGrandfathersLegacy(t *testing.T) {
	db := rawMigDB(t)
	db.Exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, created_at INTEGER)`)
	db.Exec(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@x', 1)`)

	if err := migrateEmailVerified(db); err != nil {
		t.Fatal(err)
	}
	if !hasColumn(t, db, "users", "email_verified") {
		t.Fatal("email_verified column not created")
	}
	if got := evOf(t, db, "u1"); got != 1 {
		t.Fatalf("legacy user not grandfathered: email_verified=%d, want 1", got)
	}
	if markerCount(t, db) != 1 {
		t.Fatal("migration marker not recorded")
	}
}

// THE critical safety case: a DB that already migrated under the OLD pre-ledger
// code (column present, no marker — i.e. production) is ADOPTED without re-running
// the backfill. A currently-UNVERIFIED account must stay unverified.
func TestMigrateEmailVerifiedAdoptsWithoutReverifying(t *testing.T) {
	db := rawMigDB(t)
	db.Exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, created_at INTEGER, email_verified INTEGER NOT NULL DEFAULT 0)`)
	db.Exec(`INSERT INTO users (id, email, created_at, email_verified) VALUES ('legacy', 'a@x', 1, 1)`)
	db.Exec(`INSERT INTO users (id, email, created_at, email_verified) VALUES ('pending', 'b@x', 2, 0)`)

	if err := migrateEmailVerified(db); err != nil {
		t.Fatal(err)
	}
	if got := evOf(t, db, "pending"); got != 0 {
		t.Fatalf("SECURITY: adoption re-verified an unverified account (email_verified=%d, want 0)", got)
	}
	if got := evOf(t, db, "legacy"); got != 1 {
		t.Fatalf("already-verified account changed to %d", got)
	}
	if markerCount(t, db) != 1 {
		t.Fatal("marker not recorded on adoption")
	}
}

// A crash between the ALTER and the backfill rolls back BOTH (transactional DDL),
// so the restart re-runs cleanly instead of stranding legacy users as unverified.
func TestMigrateEmailVerifiedCrashSafe(t *testing.T) {
	db := rawMigDB(t)
	db.Exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, created_at INTEGER)`)
	db.Exec(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@x', 1)`)

	// Simulate a crash: ALTER succeeds, then the migration fn errors before commit.
	err := migrateOnce(db, "grandfather_email_verified", func(tx *sql.Tx) error {
		if _, e := tx.ExecContext(context.Background(),
			`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`); e != nil {
			return e
		}
		return errors.New("boom: crash before backfill")
	})
	if err == nil {
		t.Fatal("expected the injected crash error")
	}
	// Rolled back: column gone, no marker — nothing half-applied.
	if hasColumn(t, db, "users", "email_verified") {
		t.Fatal("ALTER was not rolled back — the column leaked past a failed migration")
	}
	if markerCount(t, db) != 0 {
		t.Fatal("a failed migration must not record its marker")
	}
	// The real migration now runs cleanly and grandfathers the legacy user.
	if err := migrateEmailVerified(db); err != nil {
		t.Fatal(err)
	}
	if got := evOf(t, db, "u1"); got != 1 {
		t.Fatalf("re-run did not grandfather the legacy user: %d", got)
	}
	if markerCount(t, db) != 1 {
		t.Fatal("marker not recorded after the successful re-run")
	}
}

// Once applied, the migration never re-runs — so a user who registers AFTER the
// migration (legitimately unverified) is not swept up by a second boot.
func TestMigrateEmailVerifiedDoesNotReRun(t *testing.T) {
	db := rawMigDB(t)
	db.Exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, created_at INTEGER)`)
	db.Exec(`INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@x', 1)`)
	if err := migrateEmailVerified(db); err != nil {
		t.Fatal(err)
	}
	// A new user registers after the migration and has not verified yet.
	db.Exec(`INSERT INTO users (id, email, created_at, email_verified) VALUES ('u2', 'b@x', 2, 0)`)

	if err := migrateEmailVerified(db); err != nil { // second boot
		t.Fatal(err)
	}
	if got := evOf(t, db, "u2"); got != 0 {
		t.Fatalf("second run wrongly re-verified a post-migration unverified user: %d", got)
	}
	if markerCount(t, db) != 1 {
		t.Fatal("marker must not be duplicated")
	}
}
