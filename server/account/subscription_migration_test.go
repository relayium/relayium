package account

import (
	"context"
	"path/filepath"
	"testing"
)

// The migration/backfill contract for a database that predates provider-neutral
// subscription state: every Stripe-only outcome must survive it unchanged.
//
// The fixture is built by opening a real store (so the current schema exists),
// writing the state a PRE-migration binary would have left behind, and then
// removing the new artifacts — which is exactly what such a database looks
// like. Reopening runs the migration against it for real, rather than against
// a hand-written approximation of the old schema.

type preMigrationUser struct {
	email      string
	planID     string
	status     string
	end        int64
	source     string
	cycle      string
	customerID string
	subID      string
	eventAt    int64
}

func openStoreAt(t *testing.T, path string) *SQLiteStore {
	t.Helper()
	s, err := OpenSQLite(path)
	if err != nil {
		t.Fatalf("OpenSQLite(%s): %v", path, err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// stripPerSourceState removes everything the provider-neutral migration adds,
// leaving the users-row projection a pre-migration binary maintained.
func stripPerSourceState(t *testing.T, s *SQLiteStore) {
	t.Helper()
	for _, q := range []string{
		`DROP TABLE IF EXISTS subscription_sources`,
		`DROP TABLE IF EXISTS apple_products`,
		`UPDATE users SET apple_account_token = ''`,
	} {
		if _, err := s.db.ExecContext(context.Background(), q); err != nil {
			t.Fatalf("strip %q: %v", q, err)
		}
	}
}

func TestPreMigrationStripeDatabaseRoundTrips(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "premigration.db")

	fixtures := []preMigrationUser{
		{email: "paid-monthly@example.com", planID: "pro", status: "active", end: 1_900_000_000, source: "stripe", cycle: "monthly", customerID: "cus_pro", subID: "sub_pro", eventAt: 1000},
		{email: "paid-yearly@example.com", planID: "max", status: "trialing", end: 1_950_000_000, source: "stripe", cycle: "yearly", customerID: "cus_max", subID: "sub_max", eventAt: 2000},
		{email: "legacy-cycle@example.com", planID: "plus", status: "active", end: 1_800_000_000, source: "stripe", cycle: "", customerID: "cus_plus", subID: "", eventAt: 0},
		{email: "canceled@example.com", planID: "free", status: "canceled", end: 0, source: "stripe", cycle: "monthly", customerID: "cus_gone", subID: "", eventAt: 3000},
		{email: "comped@example.com", planID: "max", status: "active", end: 1_900_000_000, source: "admin", cycle: "", customerID: "cus_comped", subID: "sub_comped", eventAt: 4000},
		{email: "never-paid@example.com", planID: "free", status: "", end: 0, source: "", cycle: "", customerID: "", subID: "", eventAt: 0},
	}

	type snapshot struct {
		u      User
		sweeps bool
	}
	before := map[string]snapshot{}
	ids := map[string]string{}

	func() {
		s := openStoreAt(t, path)
		seedTiers(t, s)
		for _, f := range fixtures {
			u, err := s.UpsertUserByEmail(ctx, f.email, "")
			if err != nil {
				t.Fatalf("create %s: %v", f.email, err)
			}
			ids[f.email] = u.ID
			// Write the users-row projection directly, the way the pre-migration
			// binary's single UPDATE did.
			if _, err := s.db.ExecContext(ctx,
				`UPDATE users SET plan_id=?, subscription_status=?, subscription_end=?, plan_source=?,
				        billing_cycle=?, stripe_customer_id=?, stripe_subscription_id=?, sub_event_at=?
				  WHERE id=?`,
				f.planID, f.status, f.end, f.source, f.cycle, f.customerID, f.subID, f.eventAt, u.ID); err != nil {
				t.Fatalf("seed %s: %v", f.email, err)
			}
		}
		// The PRE-migration sweep predicate, written out rather than read back
		// through the current implementation — which now joins the source rows
		// this fixture deliberately does not have yet, and would therefore
		// "agree" with itself for the wrong reason.
		inSweep := map[string]bool{}
		rows, err := s.db.QueryContext(ctx,
			`SELECT id FROM users
			  WHERE plan_source = 'stripe' AND plan_id != 'free' AND stripe_customer_id != '' AND deleted_at = 0`)
		if err != nil {
			t.Fatalf("pre-migration sweep query: %v", err)
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				t.Fatalf("scan: %v", err)
			}
			inSweep[id] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatalf("pre-migration sweep rows: %v", err)
		}
		if len(inSweep) == 0 {
			t.Fatal("fixture bug: no user is in the pre-migration reconcile sweep")
		}
		for _, f := range fixtures {
			u, err := s.GetUserByID(ctx, ids[f.email])
			if err != nil {
				t.Fatalf("read %s: %v", f.email, err)
			}
			before[f.email] = snapshot{u: u, sweeps: inSweep[u.ID]}
		}
		stripPerSourceState(t, s)
		s.Close()
	}()

	// Reopen: the migration and its backfill run against the stripped database.
	s := openStoreAt(t, path)

	sweep, err := s.ListStripePaidUsers(ctx)
	if err != nil {
		t.Fatalf("post-migration ListStripePaidUsers: %v", err)
	}
	inSweep := map[string]bool{}
	for _, u := range sweep {
		inSweep[u.ID] = true
	}

	for _, f := range fixtures {
		got, err := s.GetUserByID(ctx, ids[f.email])
		if err != nil {
			t.Fatalf("post read %s: %v", f.email, err)
		}
		want := before[f.email].u
		if got.PlanID != want.PlanID || got.SubscriptionStatus != want.SubscriptionStatus ||
			got.SubscriptionEnd != want.SubscriptionEnd || got.PlanSource != want.PlanSource ||
			got.BillingCycle != want.BillingCycle || got.StripeSubscriptionID != want.StripeSubscriptionID {
			t.Fatalf("%s: effective state changed\n before %+v\n after  %+v", f.email, want, got)
		}
		if got.PlanStartedAt != want.PlanStartedAt || got.QuotaAccruedBytes != want.QuotaAccruedBytes ||
			got.QuotaAccruedPeriod != want.QuotaAccruedPeriod {
			t.Fatalf("%s: migration disturbed the quota segment", f.email)
		}
		if inSweep[got.ID] != before[f.email].sweeps {
			t.Fatalf("%s: reconcile eligibility changed (%v -> %v)", f.email, before[f.email].sweeps, inSweep[got.ID])
		}

		row, ok, err := s.GetSubscriptionSource(ctx, got.ID, ProviderStripe)
		if err != nil {
			t.Fatalf("%s: GetSubscriptionSource: %v", f.email, err)
		}
		switch f.source {
		case "stripe":
			if !ok {
				t.Fatalf("%s: no stripe source row was backfilled", f.email)
			}
			if row.PlanID != f.planID || row.Status != f.status || row.PeriodEnd != f.end ||
				row.Cycle != f.cycle || row.EventAt != f.eventAt || row.ExternalID != f.subID {
				t.Fatalf("%s: backfilled row does not mirror the users row: %+v", f.email, row)
			}
		default:
			// An admin comp's Stripe tier is NOT knowable from the users row (it
			// holds the comped plan), and a never-paid account has no provider
			// state at all. Inventing either would be a lie the fallback path
			// would later act on.
			if ok {
				t.Fatalf("%s: invented a stripe source row: %+v", f.email, row)
			}
		}
	}

	// Idempotent: a second migration pass must not disturb state that has moved
	// on since the first one.
	apple := ids["paid-monthly@example.com"]
	apply(t, s, apple, ProviderApple, "max", "active", "yearly", 1_990_000_000, 50)
	if _, err := s.db.ExecContext(ctx, `UPDATE users SET sub_event_at = 9999 WHERE id = ?`, apple); err != nil {
		t.Fatalf("advance clock: %v", err)
	}
	mid, err := s.GetUserByID(ctx, apple)
	if err != nil {
		t.Fatalf("mid read: %v", err)
	}
	s.Close()

	again := openStoreAt(t, path)
	after, err := again.GetUserByID(ctx, apple)
	if err != nil {
		t.Fatalf("post-reopen read: %v", err)
	}
	if after.PlanID != mid.PlanID || after.PlanSource != mid.PlanSource || after.BillingCycle != mid.BillingCycle {
		t.Fatalf("second migration pass rewrote live state: %+v -> %+v", mid, after)
	}
	stripeRow, ok, err := again.GetSubscriptionSource(ctx, apple, ProviderStripe)
	if err != nil || !ok {
		t.Fatalf("stripe row lost on reopen: ok=%v err=%v", ok, err)
	}
	if stripeRow.PlanID != "pro" || stripeRow.EventAt != 1000 {
		t.Fatalf("second pass re-backfilled an existing source row: %+v", stripeRow)
	}
	appleRow, ok, err := again.GetSubscriptionSource(ctx, apple, ProviderApple)
	if err != nil || !ok {
		t.Fatalf("apple row lost on reopen: ok=%v err=%v", ok, err)
	}
	if appleRow.PlanID != "max" {
		t.Fatalf("second pass disturbed a non-stripe source: %+v", appleRow)
	}
}
