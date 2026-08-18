package account

import (
	"path/filepath"
	"testing"
)

func TestOpenSQLiteRebuildsLegacyCancellationUniqueness(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM schema_migrations WHERE id='billing_cancellation_outbox_generations_v3'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`ALTER TABLE billing_cancellation_outbox RENAME TO billing_cancellation_outbox_current`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DROP TABLE billing_cancellation_outbox_current`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`CREATE TABLE billing_cancellation_outbox (
 id TEXT PRIMARY KEY,billing_subject_id TEXT NOT NULL,provider TEXT NOT NULL CHECK(provider='stripe'),
 customer_id TEXT NOT NULL DEFAULT '',subscription_id TEXT NOT NULL DEFAULT '',idempotency_key TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('pending','terminal')),attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,progress_json TEXT NOT NULL DEFAULT '{}',terminal_at INTEGER NOT NULL DEFAULT 0,
 archived_at INTEGER NOT NULL DEFAULT 0,UNIQUE(billing_subject_id,provider))`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at) VALUES('old','subject','stripe','old-key','terminal',1,1)`); err != nil {
		t.Fatal(err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,generation) VALUES('new','subject','stripe','new-key','pending',2,2,2)`); err != nil {
		t.Fatalf("second generation still blocked by legacy uniqueness: %v", err)
	}
	var rows, marker int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_cancellation_outbox WHERE billing_subject_id='subject'`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("preserved rows=%d err=%v", rows, err)
	}
	var oldState string
	if err := store.db.QueryRow(`SELECT state FROM billing_cancellation_outbox WHERE id='old'`).Scan(&oldState); err != nil || oldState != "pending" {
		t.Fatalf("legacy terminal evidence was trusted: state=%q err=%v", oldState, err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,generation) VALUES('duplicate','subject','stripe','duplicate-key','pending',3,3,2)`); err == nil {
		t.Fatal("duplicate subject/provider/generation was accepted")
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE id='billing_cancellation_outbox_generations_v3'`).Scan(&marker); err != nil || marker != 1 {
		t.Fatalf("marker=%d err=%v", marker, err)
	}
	// The migration is idempotent on a second open.
	if err := migrateBillingCancellationOutboxGenerations(store.db); err != nil {
		t.Fatal(err)
	}
}

func TestDeletionProgressManualAndTerminalAreMonotonic(t *testing.T) {
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{
		"checkout_session:cs_manual": {Kind: "checkout_session", ID: "cs_manual", Manual: true, Status: "paid_after_deletion"},
		"subscription:sub_done":      {Kind: "subscription", ID: "sub_done", Terminal: true, Status: "canceled"},
	}}
	p.add(BillingDeletionResource{Kind: "checkout_session", ID: "cs_manual", Status: "discovered"})
	p.add(BillingDeletionResource{Kind: "subscription", ID: "sub_done", Status: "discovered"})
	if !p.Resources["checkout_session:cs_manual"].Manual || p.Resources["checkout_session:cs_manual"].Status != "paid_after_deletion" {
		t.Fatalf("manual state regressed: %+v", p.Resources["checkout_session:cs_manual"])
	}
	if !p.Resources["subscription:sub_done"].Terminal || p.Resources["subscription:sub_done"].Status != "canceled" {
		t.Fatalf("terminal state regressed: %+v", p.Resources["subscription:sub_done"])
	}
}

func TestVerifiedSuccessTimeOnlyCompletesTimeUnknownManualEvidence(t *testing.T) {
	for _, status := range []string{"customer_mismatch", "attempt_attribution_mismatch", "metered_usage_requires_operator", "recovery_lineage_pending", "unknown_resource"} {
		p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"charge:ch": {Kind: "charge", ID: "ch", Manual: true, Status: status}}}
		p.add(BillingDeletionResource{Kind: "charge", ID: "ch", SuccessAt: 200, Status: "webhook"})
		if r := p.Resources["charge:ch"]; !r.Manual || r.Status != status {
			t.Fatalf("manual %q was downgraded by unrelated success evidence: %+v", status, r)
		}
	}
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"charge:ch": {Kind: "charge", ID: "ch", Manual: true, Status: "succeeded_time_unknown"}}}
	p.add(BillingDeletionResource{Kind: "charge", ID: "ch", SuccessAt: 200, Status: "webhook"})
	if r := p.Resources["charge:ch"]; r.Manual || r.SuccessAt != 200 || r.Status != "webhook_success_time" {
		t.Fatalf("verified success time did not complete the narrow unknown-time state: %+v", r)
	}
}
