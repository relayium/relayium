package account

import (
	"path/filepath"
	"testing"
)

func TestOpenSQLiteCreatesBillingDeletionBaseline(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "fresh.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	for table, columns := range map[string][]string{
		"billing_cancellation_outbox":          {"progress_json", "terminal_at", "archived_at", "claim_token", "claim_until", "revision"},
		"billing_deletion_manual_actions":      {"retry_generation", "provider_status", "refund_proof"},
		"billing_deletion_refund_constituents": {"proof_generation", "refund_id", "amount", "status"},
		"billing_deletion_refund_inbox":        {"action_id", "payment_intent_id", "status", "event_at"},
	} {
		rows, err := store.db.Query(`PRAGMA table_info(` + table + `)`)
		if err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for rows.Next() {
			var cid, notnull, pk int
			var name, typ string
			var dflt any
			if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
				t.Fatal(err)
			}
			seen[name] = true
		}
		rows.Close()
		for _, column := range columns {
			if !seen[column] {
				t.Fatalf("%s missing %s", table, column)
			}
		}
	}
	for _, marker := range []string{"billing_cancellation_outbox_generations_v3", "billing_cancellation_identity_v4", "billing_cancellation_history_audit_v5", "billing_cancellation_history_audit_v6", "billing_deletion_manual_actions_v2", "billing_deletion_progress_v1"} {
		var n int
		if err := store.db.QueryRow(`SELECT COUNT(*) FROM schema_migrations WHERE id=?`, marker).Scan(&n); err != nil || n != 0 {
			t.Fatalf("unpublished marker %s count=%d err=%v", marker, n, err)
		}
	}
	for generation, id := range []string{"one", "two"} {
		if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,generation) VALUES(?,'subject','stripe',?,'pending',1,1,?)`, id, id, generation+1); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOpenSQLiteRefusesCorruptPendingDeletionJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "corrupt.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation) VALUES('corrupt','subject','stripe','key','pending','{"version":1,"unknown":true}',1,1,1)`)
	if err != nil {
		t.Fatal(err)
	}
	store.db.Close()
	if reopened, err := OpenSQLite(path); err == nil {
		reopened.db.Close()
		t.Fatal("corrupt journal did not block startup")
	}
}

func TestDeletionProgressManualAndTerminalAreMonotonic(t *testing.T) {
	p := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{"checkout_session:cs": {Kind: "checkout_session", ID: "cs", Manual: true, Status: "paid_after_deletion"}, "subscription:sub": {Kind: "subscription", ID: "sub", Terminal: true, Status: "canceled"}}}
	p.add(BillingDeletionResource{Kind: "checkout_session", ID: "cs", Status: "discovered"})
	p.add(BillingDeletionResource{Kind: "subscription", ID: "sub", Status: "discovered"})
	if !p.Resources["checkout_session:cs"].Manual || !p.Resources["subscription:sub"].Terminal {
		t.Fatalf("monotonic state regressed: %+v", p.Resources)
	}
}
