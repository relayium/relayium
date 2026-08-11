package account

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// An EXISTING database does not get the pending_node_deletes billing columns
// from CREATE TABLE IF NOT EXISTS — the table already exists, so that statement
// is a no-op and only the idempotent ALTER ladder can add them. This opens a
// database laid out exactly as the oldest production schema had the table
// (blob_key, node_id, enqueued_at — before not_before, before deleted_at,
// before the four billing columns), with a live row in it, and proves that
// reopening through OpenSQLite:
//
//   - preserves the row, with every later column at its zero default;
//   - lets the new billed enqueue write an obligation next to it;
//   - lets SettleBlobBilling settle that obligation, exactly once.
//
// If the ALTERs are ever dropped in favour of the CREATE alone, the reopen —
// or the first SELECT against the widened column list — fails here.
func TestExistingDatabaseGainsPendingDeleteBillingColumns(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "upgrade.db")

	// The pre-change database, created by hand: the oldest shape of the table,
	// holding one queued delete a production sweep would still be retrying.
	raw, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatalf("open raw: %v", err)
	}
	if _, err := raw.ExecContext(ctx, `CREATE TABLE pending_node_deletes (
		blob_key    TEXT NOT NULL,
		node_id     TEXT NOT NULL,
		enqueued_at INTEGER NOT NULL,
		PRIMARY KEY (blob_key, node_id)
	)`); err != nil {
		t.Fatalf("create old table: %v", err)
	}
	if _, err := raw.ExecContext(ctx,
		`INSERT INTO pending_node_deletes (blob_key, node_id, enqueued_at) VALUES ('bk-old', 'node-old', 1234)`); err != nil {
		t.Fatalf("insert old row: %v", err)
	}
	if err := raw.Close(); err != nil {
		t.Fatalf("close raw: %v", err)
	}

	// The upgrade: the same file, opened the way the server opens it.
	st, err := OpenSQLite("file:" + path)
	if err != nil {
		t.Fatalf("reopen through the migration path: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// The pre-existing row survives, readable through the widened SELECT, every
	// post-hoc column at the default that means "as before": no hold, never
	// discharged, no billing obligation.
	rows, err := st.ListPendingNodeDeletes(ctx)
	if err != nil {
		t.Fatalf("list after upgrade: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows after upgrade = %+v, want the one pre-existing row", rows)
	}
	old := rows[0]
	if old.BlobKey != "bk-old" || old.NodeID != "node-old" || old.EnqueuedAt != 1234 {
		t.Fatalf("pre-existing row mangled by the upgrade: %+v", old)
	}
	if old.NotBefore != 0 || old.DeletedAt != 0 ||
		old.BillUserID != "" || old.BillKind != 0 || old.BillMax != 0 || old.BilledThrough != 0 {
		t.Fatalf("pre-existing row did not default its migrated columns: %+v", old)
	}

	// A billed intent lands next to it (the INSERT names every new column), and
	// settling it moves the meter and the floor together.
	u, err := st.UpsertUserByEmail(ctx, "upgraded@example.test", "Upgraded")
	if err != nil {
		t.Fatalf("user: %v", err)
	}
	const at = int64(1_767_312_000) // 2026-01-02, a stable period bucket
	if err := enqueueBilledNodeDeleteOn(ctx, st.db, "bk-billed", "node-old", at, at+3600,
		u.ID, MeterUpload, 10_000, 1_000); err != nil {
		t.Fatalf("billed enqueue after upgrade: %v", err)
	}
	billed, err := st.SettleBlobBilling(ctx, "bk-billed", "node-old", 4_000, at)
	if err != nil {
		t.Fatalf("settle after upgrade: %v", err)
	}
	if billed != 3_000 {
		t.Fatalf("settled %d bytes, want the 3000 past the 1000-byte floor", billed)
	}
	if up, _, err := st.MonthlyUsage(ctx, u.ID, periodOf(at)); err != nil || up != 3_000 {
		t.Fatalf("meter after settle = %d (err %v), want 3000", up, err)
	}
	// Idempotent: the floor moved with the meter, so asking again bills nothing.
	if again, err := st.SettleBlobBilling(ctx, "bk-billed", "node-old", 4_000, at); err != nil || again != 0 {
		t.Fatalf("repeat settle = %d (err %v), want 0", again, err)
	}
	// And the old row still carries no obligation: settling it is a no-op.
	if none, err := st.SettleBlobBilling(ctx, "bk-old", "node-old", 9_999, at); err != nil || none != 0 {
		t.Fatalf("settling the obligation-free old row = %d (err %v), want 0", none, err)
	}
}
