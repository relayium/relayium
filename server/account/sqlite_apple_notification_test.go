package account

import (
	"context"
	"path/filepath"
	"testing"
)

func TestPruneTerminalAppleNotificationsKeepsUnfinishedAndBoundaryRows(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	type row struct {
		uuid  string
		state string
		at    int64
		gone  bool
	}
	rows := []row{
		{"10000000-0000-4000-8000-000000000001", appleNotificationApplied, 99, true},
		{"10000000-0000-4000-8000-000000000002", appleNotificationIgnored, 99, true},
		{"10000000-0000-4000-8000-000000000003", appleNotificationUnsupported, 99, true},
		{"10000000-0000-4000-8000-000000000004", appleNotificationApplied, 100, false},
		{"10000000-0000-4000-8000-000000000005", appleNotificationReceived, 99, false},
		{"10000000-0000-4000-8000-000000000006", appleNotificationPending, 99, false},
		{"10000000-0000-4000-8000-000000000007", appleNotificationConflict, 99, false},
	}

	for _, tc := range rows {
		if _, fresh, err := s.ClaimAppleNotification(ctx, AppleNotificationRecord{
			UUID: tc.uuid, Type: "TEST", ReceivedAt: tc.at,
		}); err != nil || !fresh {
			t.Fatalf("claim %s: fresh=%v err=%v", tc.uuid, fresh, err)
		}
		if tc.state != appleNotificationReceived {
			if err := s.SetAppleNotificationState(ctx, tc.uuid, tc.state, tc.at); err != nil {
				t.Fatalf("state %s: %v", tc.uuid, err)
			}
		}
	}

	if err := s.PruneTerminalAppleNotifications(ctx, 100); err != nil {
		t.Fatalf("prune: %v", err)
	}
	for _, tc := range rows {
		_, ok, err := s.GetAppleNotification(ctx, tc.uuid)
		if err != nil {
			t.Fatalf("get %s: %v", tc.uuid, err)
		}
		if ok == tc.gone {
			t.Errorf("%s state=%s at=%d: present=%v, want %v", tc.uuid, tc.state, tc.at, ok, !tc.gone)
		}
	}
}

// The `environment` column was added to a table that already existed, and it
// has to be additive in BOTH directions.
//
// Forwards is ordinary: this version writes and reads it. Backwards is the case
// a rollback produces — an older binary names its own column list, which does
// not include this one, and its INSERT must still land. That is what the
// column's NOT NULL empty-string default buys, and what this test writes out
// longhand: the row appears, and it appears as an honest UNKNOWN rather than as
// either store.
func TestAppleNotificationEnvironmentColumnIsAdditive(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	const uuid = "10000000-0000-4000-8000-0000000000e1"

	// Exactly the statement a binary from before this column issues.
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO apple_notifications (notification_uuid, state, notification_type,
		   received_at, updated_at, supported, bundle_id, product_id,
		   original_transaction_id, app_account_token, purchase_date_ms,
		   expires_date_ms, revocation_date_ms, is_upgraded)
		 VALUES (?, ?, 'DID_RENEW', 1, 1, 1, 'com.relayium.mac', 'pro.monthly',
		         '2000000000000001', '', 10, 20, 0, 0)`,
		uuid, appleNotificationPending); err != nil {
		t.Fatalf("an older binary's insert was refused: %v", err)
	}

	rec, ok, err := s.GetAppleNotification(ctx, uuid)
	if err != nil || !ok {
		t.Fatalf("read back: ok=%v err=%v", ok, err)
	}
	if rec.Projection.Environment != "" {
		t.Fatalf("a row written without an environment must read as unknown, got %q", rec.Projection.Environment)
	}
	// And it is still a complete row in every other respect, so nothing else
	// about the projection depends on the new column being present.
	if rec.State != appleNotificationPending || rec.Projection.OriginalTransactionID != "2000000000000001" ||
		rec.Projection.ExpiresDateMS != 20 || !rec.Supported {
		t.Fatalf("the rest of the row did not survive: %+v", rec)
	}
	// A row this version writes carries the environment, so the column is not
	// merely tolerated but populated.
	current := AppleNotificationRecord{
		UUID: "10000000-0000-4000-8000-0000000000e2", Type: "DID_RENEW", ReceivedAt: 1,
		Projection: AppleNotificationProjection{
			OriginalTransactionID: "2000000000000001", Environment: appleEnvSandbox,
		},
	}
	if _, fresh, err := s.ClaimAppleNotification(ctx, current); err != nil || !fresh {
		t.Fatalf("claim: fresh=%v err=%v", fresh, err)
	}
	got, ok, err := s.GetAppleNotification(ctx, current.UUID)
	if err != nil || !ok || got.Projection.Environment != appleEnvSandbox {
		t.Fatalf("environment did not round-trip: %+v (ok=%v err=%v)", got, ok, err)
	}
}

// The migration itself, on a database that already holds the table.
//
// The forward direction above proves the column tolerates an old INSERT; this
// proves an old DATABASE gets the column at all. CREATE TABLE IF NOT EXISTS
// does nothing to a table that exists, so the ALTER beside it is the only thing
// that can add a column to a deployment that has been running — and a row
// already in that table must survive the change carrying an honest unknown.
func TestAppleNotificationEnvironmentColumnMigratesAnExistingTable(t *testing.T) {
	ctx := context.Background()
	dsn := filepath.Join(t.TempDir(), "migrate.db")

	before, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	// Put the table back into its pre-column shape, with a row in it.
	if _, err := before.db.ExecContext(ctx,
		`ALTER TABLE apple_notifications DROP COLUMN environment`); err != nil {
		t.Fatalf("un-migrate: %v", err)
	}
	if _, err := before.db.ExecContext(ctx,
		`INSERT INTO apple_notifications (notification_uuid, state, notification_type,
		   received_at, updated_at, supported, bundle_id, product_id,
		   original_transaction_id, app_account_token, purchase_date_ms,
		   expires_date_ms, revocation_date_ms, is_upgraded)
		 VALUES ('10000000-0000-4000-8000-0000000000e3', ?, 'DID_RENEW', 1, 1, 1,
		         'com.relayium.mac', 'pro.monthly', '2000000000000001', '', 10, 20, 0, 0)`,
		appleNotificationPending); err != nil {
		t.Fatalf("pre-migration insert: %v", err)
	}
	if err := before.Close(); err != nil {
		t.Fatal(err)
	}

	after, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("reopen (the migration): %v", err)
	}
	defer after.Close()
	rec, ok, err := after.GetAppleNotification(ctx, "10000000-0000-4000-8000-0000000000e3")
	if err != nil || !ok {
		t.Fatalf("the pre-migration row is unreadable: ok=%v err=%v", ok, err)
	}
	if rec.Projection.Environment != "" {
		t.Fatalf("a pre-migration row must read as unknown, got %q", rec.Projection.Environment)
	}
	// Running the migration twice is what every subsequent boot does.
	again, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("second reopen: %v", err)
	}
	again.Close()
}
