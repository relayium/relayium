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
	progress := `{"version":1,"customers":["cus"],"resources":{"invoice:in":{"kind":"invoice","id":"in","paymentIntentId":"pi","status":"refunded","terminal":true}},"cleanSince":1}`
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,subscription_id,idempotency_key,state,created_at,updated_at,progress_json) VALUES('old','subject','stripe','cus_old','sub_old','old-key','terminal',1,1,?)`, progress); err != nil {
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
	if err := store.db.QueryRow(`SELECT state,progress_json FROM billing_cancellation_outbox WHERE id='old'`).Scan(&oldState, &progress); err != nil || oldState != "pending" {
		t.Fatalf("legacy terminal evidence was trusted: state=%q err=%v", oldState, err)
	}
	reopened, err := decodeDeletionProgressStrict(progress)
	if err != nil || reopened.Resources["invoice:in"].PaymentIntentID != "pi" || reopened.Resources["invoice:in"].Terminal || reopened.CleanSince != 0 {
		t.Fatalf("reopened progress=%+v err=%v", reopened, err)
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

func TestBillingDeletionHistoryAuditV5ReopensOldCheckoutProof(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history-v5.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM schema_migrations WHERE id='billing_cancellation_history_audit_v5'`); err != nil {
		t.Fatal(err)
	}
	raw := `{"version":1,"customers":["cus_old"],"resources":{"checkout_session:cs_old":{"kind":"checkout_session","id":"cs_old","status":"recovery_window_closed","terminal":true,"paymentIntentId":"pi_old"}},"cleanSince":99}`
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,idempotency_key,state,created_at,updated_at,generation,progress_json) VALUES('old-v5','subject','stripe','cus_old','old-v5-key','pending',100,100,1,?)`, raw); err != nil {
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
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE id='old-v5'`).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	p, err := decodeDeletionProgressStrict(raw)
	r := p.Resources["checkout_session:cs_old"]
	if err != nil || !p.HistoricalAuditRequired || p.CleanSince != 0 || r.Terminal || r.Manual || r.PaymentIntentID != "pi_old" {
		t.Fatalf("v5 progress=%+v resource=%+v err=%v", p, r, err)
	}
}

func TestBillingDeletionHistoryAuditV6ReopensTerminalAndUnionsCustomers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history-v6.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM schema_migrations WHERE id='billing_cancellation_history_audit_v6'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_holds(billing_subject_id,email_hmac,provider,created_at,expires_at,review_at,subject_released_at) VALUES('subject-v6',X'01','stripe',1,2,3,99)`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO stripe_customer_history(user_id,customer_id,created_at) VALUES('subject-v6','cus_history',1)`); err != nil {
		t.Fatal(err)
	}
	raw := `{"version":1,"customers":["cus_progress"],"resources":{"checkout_session:cs_old":{"kind":"checkout_session","id":"cs_old","status":"checkout.session.async_payment_failed","terminal":true},"charge:ch_old":{"kind":"charge","id":"ch_old","status":"not_paid","terminal":true}},"cleanSince":50}`
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,customer_id,idempotency_key,state,created_at,updated_at,generation,progress_json,terminal_at,archived_at,claim_token,claim_until,revision) VALUES('out-v6','subject-v6','stripe','cus_row','v6-key','terminal',1,1,1,?,50,60,'old-claim',999,7)`, raw); err != nil {
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
	var state, claim string
	var terminalAt, archivedAt, claimUntil, revision, released int64
	if err := store.db.QueryRow(`SELECT state,progress_json,terminal_at,archived_at,claim_token,claim_until,revision FROM billing_cancellation_outbox WHERE id='out-v6'`).Scan(&state, &raw, &terminalAt, &archivedAt, &claim, &claimUntil, &revision); err != nil {
		t.Fatal(err)
	}
	p, err := decodeDeletionProgressStrict(raw)
	if err != nil || state != "pending" || terminalAt != 0 || archivedAt != 0 || claim != "" || claimUntil != 0 || revision != 8 || !p.HistoricalAuditRequired || p.CleanSince != 0 {
		t.Fatalf("v6 row state=%s progress=%+v terminal=%d archived=%d claim=%q/%d revision=%d err=%v", state, p, terminalAt, archivedAt, claim, claimUntil, revision, err)
	}
	for _, customer := range []string{"cus_progress", "cus_row", "cus_history"} {
		found := false
		for _, got := range p.Customers {
			found = found || got == customer
		}
		if !found {
			t.Fatalf("missing customer %s in %v", customer, p.Customers)
		}
	}
	if p.Resources["checkout_session:cs_old"].Terminal || p.Resources["checkout_session:cs_old"].AsyncFailureAt != 0 || p.Resources["charge:ch_old"].Terminal {
		t.Fatalf("old conclusions survived: %+v", p.Resources)
	}
	if err := store.db.QueryRow(`SELECT subject_released_at FROM billing_deletion_holds WHERE billing_subject_id='subject-v6'`).Scan(&released); err != nil || released != 0 {
		t.Fatalf("hold=%d err=%v", released, err)
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

func TestOpenSQLiteRebuildsRefundActionsAsAppendOnlyGenerations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "refund-actions.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM schema_migrations WHERE id='billing_deletion_manual_actions_v2'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DROP TABLE billing_deletion_manual_actions`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`CREATE TABLE billing_deletion_manual_actions (
 id TEXT PRIMARY KEY,outbox_id TEXT NOT NULL,resource_key TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,
 payment_intent_id TEXT NOT NULL DEFAULT '',refund_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN ('prepared','succeeded')),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(outbox_id,resource_key))`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_manual_actions VALUES('old','out','charge:ch','actor','reason','pi','re','prepared',1,1)`); err != nil {
		t.Fatal(err)
	}
	store.db.Close()
	store, err = OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.db.Close()
	if _, err := store.db.Exec(`UPDATE billing_deletion_manual_actions SET state='failed' WHERE id='old'`); err != nil {
		t.Fatalf("failed state unavailable after migration: %v", err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_deletion_manual_actions(id,outbox_id,resource_key,actor,reason,payment_intent_id,state,retry_generation,created_at,updated_at) VALUES('new','out','charge:ch','actor','reason','pi','prepared',1,2,2)`); err != nil {
		t.Fatalf("append-only retry generation unavailable: %v", err)
	}
}

func TestOpenSQLiteRefusesAmbiguousLegacyRefundActions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ambiguous-refund-actions.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM schema_migrations WHERE id='billing_deletion_manual_actions_v2'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DROP TABLE billing_deletion_manual_actions`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`CREATE TABLE billing_deletion_manual_actions (
 id TEXT PRIMARY KEY,outbox_id TEXT NOT NULL,resource_key TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT NOT NULL,
 payment_intent_id TEXT NOT NULL DEFAULT '',refund_id TEXT NOT NULL DEFAULT '',state TEXT NOT NULL CHECK(state IN ('prepared','succeeded')),
 retry_generation INTEGER NOT NULL DEFAULT 0,provider_status TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(outbox_id,resource_key))`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []string{
		`INSERT INTO billing_deletion_manual_actions VALUES('a','out','charge:one','actor','reason','pi_same','','prepared',0,'',1,1)`,
		`INSERT INTO billing_deletion_manual_actions VALUES('b','out','invoice:two','actor','reason','pi_same','','prepared',0,'',1,1)`,
	} {
		if _, err := store.db.Exec(row); err != nil {
			t.Fatal(err)
		}
	}
	store.db.Close()
	if reopened, err := OpenSQLite(path); err == nil {
		reopened.db.Close()
		t.Fatal("ambiguous duplicate payment actions did not block startup")
	}
}

func TestOpenSQLiteRefusesCorruptPendingDeletionJournal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "corrupt-progress.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation) VALUES('corrupt','subject','stripe','corrupt-key','pending','{"version":1,"unknown":true}',1,1,1)`); err != nil {
		t.Fatal(err)
	}
	store.db.Close()
	if reopened, err := OpenSQLite(path); err == nil {
		reopened.db.Close()
		t.Fatal("corrupt pending deletion journal did not block startup")
	}
}

func TestOpenSQLiteRefusesIntermediateMigrationWithoutProviderIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "lost-identity.db")
	store, err := OpenSQLite(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DELETE FROM schema_migrations WHERE id='billing_cancellation_identity_v4'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,progress_json,created_at,updated_at,generation) VALUES('lost','subject','stripe','lost-key','pending','{}',1,1,1)`); err != nil {
		t.Fatal(err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := OpenSQLite(path); err == nil {
		reopened.db.Close()
		t.Fatal("identity-free intermediate database did not block startup")
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
