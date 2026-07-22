package account

import (
	"database/sql"
	"testing"
)

func atOf(t *testing.T, db *sql.DB, id string) int {
	t.Helper()
	var v int
	if err := db.QueryRow(`SELECT active_transfers FROM nodes WHERE id = ?`, id).Scan(&v); err != nil {
		t.Fatalf("read active_transfers for %s: %v", id, err)
	}
	return v
}

// A database whose nodes.active_transfers column was created under the
// earlier, now-superseded DEFAULT 0 migration (see the comment on that ALTER
// in sqlite.go) has every pre-existing row's 0 reclassified to -1 by
// migrateActiveTransfersUnknown — the same state a fresh install (DEFAULT -1
// from the start, nothing to backfill) is already in. Without this backfill,
// such a row would read "known idle" forever instead of "unknown", silently
// reinstating the exact canary-pick bias the tri-state was added to prevent.
func TestMigrateActiveTransfersUnknownMatchesFreshInstall(t *testing.T) {
	db := rawMigDB(t)
	// Simulates the old commit's ALTER: DEFAULT 0, applied to a table that
	// already had a row — SQLite's default-fill stamps 0 onto it, exactly as
	// it would have for any node that existed before that ALTER ran.
	if _, err := db.Exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, active_transfers INTEGER NOT NULL DEFAULT 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO nodes (id, active_transfers) VALUES ('never-reported', 0)`); err != nil {
		t.Fatal(err)
	}

	if err := migrateActiveTransfersUnknown(db); err != nil {
		t.Fatal(err)
	}

	if got := atOf(t, db, "never-reported"); got != -1 {
		t.Fatalf("active_transfers = %d, want -1 (a fresh install's default for a node that has never reported)", got)
	}
}

// The backfill must be safe to run on every boot without clobbering a REAL
// reading a heartbeat wrote after the first run. Without the migrateOnce
// ledger, a naive "UPDATE ... WHERE active_transfers = 0" run unconditionally
// on every startup would perpetually stomp a genuinely idle node's real 0
// back to -1.
func TestMigrateActiveTransfersUnknownDoesNotClobberRealZero(t *testing.T) {
	db := rawMigDB(t)
	db.Exec(`CREATE TABLE nodes (id TEXT PRIMARY KEY, active_transfers INTEGER NOT NULL DEFAULT 0)`)
	db.Exec(`INSERT INTO nodes (id, active_transfers) VALUES ('a', 0)`)

	if err := migrateActiveTransfersUnknown(db); err != nil { // first boot: fixes the leftover default
		t.Fatal(err)
	}
	// A later real heartbeat legitimately reports the node is idle.
	if _, err := db.Exec(`UPDATE nodes SET active_transfers = 0 WHERE id = 'a'`); err != nil {
		t.Fatal(err)
	}
	if err := migrateActiveTransfersUnknown(db); err != nil { // second boot
		t.Fatal(err)
	}

	if got := atOf(t, db, "a"); got != 0 {
		t.Fatalf("active_transfers = %d, want 0 (a genuine post-migration heartbeat reading must survive a second boot)", got)
	}
}
