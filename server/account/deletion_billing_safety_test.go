package account

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
)

type deletionStripeBiller struct {
	*fakeBiller
	cancelErr             error
	terminal              bool
	cancelCalls           int
	store                 *SQLiteStore
	observedDurableOutbox bool
	didReconcile          bool
	hazards               BillingDeletionProgress
	observedProgress      bool
}

func (b *deletionStripeBiller) DiscoverDeletionHazards(ctx context.Context, row BillingCancellation, p BillingDeletionProgress) (BillingDeletionProgress, error) {
	p.Customers = appendUnique(p.Customers, row.CustomerID)
	if len(b.hazards.Resources) > 0 {
		for _, r := range b.hazards.Resources {
			p.add(r)
		}
	} else if len(p.Resources) == 0 {
		p.add(BillingDeletionResource{Kind: "subscription", ID: "sub_delete", CustomerID: row.CustomerID})
	}
	return p, nil
}
func (b *deletionStripeBiller) ReconcileDeletionHazards(ctx context.Context, _ BillingCancellation, p BillingDeletionProgress) (BillingDeletionProgress, error) {
	b.cancelCalls++
	b.didReconcile = true
	if b.store != nil {
		var n int
		_ = b.store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM billing_cancellation_outbox WHERE state='pending'`).Scan(&n)
		b.observedDurableOutbox = n > 0
		var progress string
		_ = b.store.db.QueryRowContext(ctx, `SELECT progress_json FROM billing_cancellation_outbox WHERE state='pending'`).Scan(&progress)
		b.observedProgress = strings.Contains(progress, "checkout_session") || strings.Contains(progress, "subscription")
	}
	if b.cancelErr == nil && b.terminal {
		for k, r := range p.Resources {
			r.Terminal = true
			r.Status = "gone"
			p.Resources[k] = r
		}
		p.CleanSince = time.Now().Unix() - 86401
	}
	return p, b.cancelErr
}

func TestStripeDeletionPersistsEveryCustomerHazardBeforeMutation(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "all-hazards@example.test")
	hazards := BillingDeletionProgress{Resources: map[string]BillingDeletionResource{}}
	for _, r := range []BillingDeletionResource{{Kind: "checkout_session", ID: "cs_1"}, {Kind: "subscription", ID: "sub_1"}, {Kind: "subscription", ID: "sub_2"}, {Kind: "schedule", ID: "sub_sched_1"}, {Kind: "invoice_item", ID: "ii_1"}, {Kind: "invoice", ID: "in_draft"}, {Kind: "invoice", ID: "in_open"}} {
		hazards.add(r)
	}
	b := &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: true, store: store, hazards: hazards}
	svc.biller = b
	seedStripeDeletion(t, store, u)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if !b.observedProgress {
		t.Fatal("provider mutation ran before durable customer-wide inventory")
	}
	var state, progress string
	if err := store.db.QueryRow(`SELECT state,progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=?`, u.ID).Scan(&state, &progress); err != nil {
		t.Fatal(err)
	}
	if state != "terminal" || !strings.Contains(progress, "cs_1") || !strings.Contains(progress, `"terminal":true`) {
		t.Fatalf("state=%q progress=%q", state, progress)
	}
}

func TestBillingDeletionHoldNeverExpiresByClockAndFreezesAdmin(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "permanent-hold@example.test")
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: "ffffffff-ffff-4fff-8fff-ffffffffffff", Now: 100}); err != nil {
		t.Fatal(err)
	}
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE billing_deletion_holds SET expires_at=1,review_at=1 WHERE billing_subject_id=?`, u.ID); err != nil {
		t.Fatal(err)
	}
	if frozen, err := store.BillingUserFrozen(context.Background(), u.ID); err != nil || !frozen {
		t.Fatalf("frozen=%v err=%v", frozen, err)
	}
	if err := store.SetUserPlanAdmin(context.Background(), u.ID, "pro", 1<<40); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("admin bypassed permanent hold: %v", err)
	}
}

func TestDeletionConfirmationIsOneLocalTransaction(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "atomic-confirm@example.test")
	seedStripeDeletion(t, store, u)
	if _, err := store.db.Exec(`CREATE TRIGGER reject_delete_schedule BEFORE UPDATE OF deleted_at ON users BEGIN SELECT RAISE(ABORT,'injected'); END`); err != nil {
		t.Fatal(err)
	}
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err == nil {
		t.Fatal("injected final write unexpectedly committed")
	}
	if _, ok, err := store.PeekEmailToken(context.Background(), authx.HashToken(token), "delete", time.Now().Unix()); err != nil || !ok {
		t.Fatalf("confirmation token was consumed: ok=%v err=%v", ok, err)
	}
	for _, table := range []string{"billing_deletion_holds", "billing_cancellation_outbox"} {
		var n int
		if err := store.db.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE billing_subject_id=?`, u.ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("partial %s rows=%d err=%v", table, n, err)
		}
	}
	var reactivate int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM email_tokens WHERE user_id=? AND purpose='reactivate'`, u.ID).Scan(&reactivate); err != nil || reactivate != 0 {
		t.Fatalf("partial reactivate tokens=%d err=%v", reactivate, err)
	}
}

func TestTerminalStripeRecoveryReleasesOriginalButNotReplacementIdentity(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "terminal-recovery@example.test")
	b := &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: true, store: store}
	svc.biller = b
	seedStripeDeletion(t, store, u)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
		t.Fatal(err)
	}
	if frozen, err := store.BillingUserFrozen(context.Background(), u.ID); err != nil || frozen {
		t.Fatalf("recovered original frozen=%v err=%v", frozen, err)
	}
	replacement, err := store.UpsertUserByEmail(context.Background(), "replacement-terminal@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE users SET billing_hold_hmac=(SELECT email_hmac FROM billing_deletion_holds WHERE billing_subject_id=?) WHERE id=?`, u.ID, replacement.ID); err != nil {
		t.Fatal(err)
	}
	if frozen, err := store.BillingUserFrozen(context.Background(), replacement.ID); err != nil || !frozen {
		t.Fatalf("replacement identity frozen=%v err=%v", frozen, err)
	}
}

func TestTerminalCancellationCompactionDropsProviderIdentifiersButKeepsHold(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "compact-terminal@example.test")
	b := &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: true, store: store}
	svc.biller = b
	seedStripeDeletion(t, store, u)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE billing_cancellation_outbox SET terminal_at=1 WHERE billing_subject_id=?`, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.CompactBillingCancellations(context.Background(), 2, 3); err != nil {
		t.Fatal(err)
	}
	var customer, subscription, progress string
	var archived int64
	if err := store.db.QueryRow(`SELECT customer_id,subscription_id,progress_json,archived_at FROM billing_cancellation_outbox WHERE billing_subject_id=?`, u.ID).Scan(&customer, &subscription, &progress, &archived); err != nil {
		t.Fatal(err)
	}
	if customer != "" || subscription != "" || progress != "{}" || archived != 3 {
		t.Fatalf("customer=%q subscription=%q progress=%q archived=%d", customer, subscription, progress, archived)
	}
	if frozen, err := store.BillingUserFrozen(context.Background(), u.ID); err != nil || !frozen {
		t.Fatalf("compaction released hold: frozen=%v err=%v", frozen, err)
	}
}

func TestSecondDeletionCreatesIndependentOutboxGeneration(t *testing.T) {
	svc, store, mail, u, token := deletionFixture(t, "delete-twice@example.test")
	b := &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: true, store: store}
	svc.biller = b
	seedStripeDeletion(t, store, u)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestAccountDeletion(context.Background(), u.ID, u.Email); err != nil {
		t.Fatal(err)
	}
	b.didReconcile = false
	if err := svc.ConfirmAccountDeletion(context.Background(), mail.lastDeleteToken(t)); err != nil {
		t.Fatal(err)
	}
	rows, err := store.db.Query(`SELECT generation,state FROM billing_cancellation_outbox WHERE billing_subject_id=? ORDER BY generation`, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []int64
	for rows.Next() {
		var g int64
		var state string
		if err := rows.Scan(&g, &state); err != nil {
			t.Fatal(err)
		}
		got = append(got, g)
	}
	if len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("generations=%v", got)
	}
}

func TestDeletionSeedsEveryKnownCheckoutRecoverySession(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "checkout-lineage@example.test")
	if err := store.SetUserStripeCustomer(context.Background(), u.ID, "cus_lineage"); err != nil {
		t.Fatal(err)
	}
	authority, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: 100})
	if err != nil {
		t.Fatal(err)
	}
	attempt, created, err := store.DispatchBillingPurchase(context.Background(), authority, "price_pro", 100)
	if err != nil || !created {
		t.Fatalf("attempt=%+v created=%v err=%v", attempt, created, err)
	}
	if err := store.SetBillingPurchaseProviderSession(context.Background(), u.ID, attempt.ID, "cs_recovery", "https://checkout.invalid"); err != nil {
		t.Fatal(err)
	}
	b := &deletionStripeBiller{fakeBiller: &fakeBiller{}, cancelErr: errors.New("hold"), store: store}
	svc.biller = b
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := store.db.QueryRow(`SELECT progress_json FROM billing_cancellation_outbox WHERE billing_subject_id=?`, u.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	p := decodeDeletionProgress(raw)
	if _, ok := p.Resources["checkout_session:cs_recovery"]; !ok {
		t.Fatalf("checkout recovery lineage missing: %s", raw)
	}
}

func TestPendingStripeRecoveryRemainsFrozen(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "pending-recovery@example.test")
	b := &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: false, store: store}
	svc.biller = b
	seedStripeDeletion(t, store, u)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
		t.Fatal(err)
	}
	if frozen, err := store.BillingUserFrozen(context.Background(), u.ID); err != nil || !frozen {
		t.Fatalf("pending recovery frozen=%v err=%v", frozen, err)
	}
}

func TestOlderTerminalGenerationCannotReleaseNewPendingDeletion(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "mixed-generation-recovery@example.test")
	b := &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: true, store: store}
	svc.biller = b
	seedStripeDeletion(t, store, u)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,generation,next_attempt_at) VALUES('pending-new',?,'stripe','pending-new-key','pending',1,1,2,1)`, u.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.ClearAccountDeletion(context.Background(), u.ID); err != nil {
		t.Fatal(err)
	}
	if frozen, err := store.BillingUserFrozen(context.Background(), u.ID); err != nil || !frozen {
		t.Fatalf("new pending generation released: frozen=%v err=%v", frozen, err)
	}
}

func TestPendingCancellationBackoffDoesNotStarveDueRows(t *testing.T) {
	store := newTestStore(t)
	now := time.Now().Unix()
	for i := 0; i < 101; i++ {
		next := now
		if i == 0 {
			next = now + 86400
		}
		id := fmt.Sprintf("out-%03d", i)
		if _, err := store.db.Exec(`INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,generation,next_attempt_at) VALUES(?,?,'stripe',?,'pending',?,?,1,?)`, id, "u-"+id, "key-"+id, now-int64(1000-i), now-int64(1000-i), next); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := store.PendingBillingCancellations(context.Background(), 100)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 100 {
		t.Fatalf("due rows=%d", len(rows))
	}
	for _, r := range rows {
		if r.ID == "out-000" {
			t.Fatal("future-backed-off oldest row starved due work")
		}
	}
}

func TestDeletionJournalRequiresAQuietWindowAndNewHazardResetsIt(t *testing.T) {
	now := int64(100000)
	p := BillingDeletionProgress{Customers: []string{"cus"}, Resources: map[string]BillingDeletionResource{"subscription:sub": {Kind: "subscription", ID: "sub", Terminal: true}}, CleanSince: now}
	if p.terminal(now + 86399) {
		t.Fatal("one empty scan reached terminal")
	}
	if !p.terminal(now + 86400) {
		t.Fatal("bounded quiet window never converged")
	}
	p.add(BillingDeletionResource{Kind: "invoice", ID: "late"})
	if p.CleanSince != 0 || p.terminal(now+200000) {
		t.Fatalf("late hazard did not reset quiet window: %+v", p)
	}
}

func deletionFixture(t *testing.T, email string) (*Service, *SQLiteStore, *capturingMailer, User, string) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, AccountGraceDays: 30, BillingHoldSecret: "test-only-billing-hold-secret"})
	u, err := store.UpsertUserByEmail(context.Background(), email, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestAccountDeletion(context.Background(), u.ID, u.Email); err != nil {
		t.Fatal(err)
	}
	return svc, store, mail, u, mail.lastDeleteToken(t)
}

func assertDeletionStarted(t *testing.T, store *SQLiteStore, userID string) {
	t.Helper()
	u, err := store.GetUserByID(context.Background(), userID)
	if err != nil {
		t.Fatal(err)
	}
	if u.DeletedAt == 0 || u.PurgeAfter <= u.DeletedAt {
		t.Fatalf("provider outcome denied account deletion: %+v", u)
	}
}

func seedStripeDeletion(t *testing.T, store *SQLiteStore, u User) {
	t.Helper()
	ctx := context.Background()
	if err := store.SetUserStripeCustomer(ctx, u.ID, "cus_delete"); err != nil {
		t.Fatal(err)
	}
	if err := store.SetUserStripeSubscription(ctx, u.ID, "sub_delete"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApplySubscriptionSource(ctx, SourceEvent{UserID: u.ID, Provider: ProviderStripe, PlanID: "pro", Status: "active", Cycle: "monthly", PeriodEnd: 2_000, ExternalID: "sub_delete", EventAt: 100, Now: 100}); err != nil {
		t.Fatal(err)
	}
}

func TestStripeDeletionPersistsCancellationBeforeProviderAndNeverDeniesDeletion(t *testing.T) {
	for _, tc := range []struct {
		name      string
		biller    *deletionStripeBiller
		wantState string
	}{
		{"provider failure remains retryable", &deletionStripeBiller{fakeBiller: &fakeBiller{}, cancelErr: errors.New("provider unavailable")}, "pending"},
		{"ambiguous response remains retryable", &deletionStripeBiller{fakeBiller: &fakeBiller{}}, "pending"},
		{"canonical terminal completes", &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: true}, "terminal"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, store, _, u, token := deletionFixture(t, "stripe-delete-"+tc.wantState+"@example.test")
			tc.biller.store = store
			svc.biller = tc.biller
			seedStripeDeletion(t, store, u)
			if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
				t.Fatalf("provider outcome blocked deletion: %v", err)
			}
			assertDeletionStarted(t, store, u.ID)
			if tc.biller.cancelCalls != 1 {
				t.Fatalf("cancel calls=%d, want 1", tc.biller.cancelCalls)
			}
			if !tc.biller.observedDurableOutbox {
				t.Fatal("provider was called before the cancellation outbox committed")
			}
			var state, customerID, subscriptionID, key string
			if err := store.db.QueryRow(`SELECT state,customer_id,subscription_id,idempotency_key FROM billing_cancellation_outbox WHERE billing_subject_id=?`, u.ID).Scan(&state, &customerID, &subscriptionID, &key); err != nil {
				t.Fatal(err)
			}
			if state != tc.wantState || customerID != "cus_delete" || subscriptionID != "sub_delete" || key == "" {
				t.Fatalf("outbox state=%q customer=%q subscription=%q key=%q", state, customerID, subscriptionID, key)
			}
		})
	}
}

func TestFailedStripeDeletionCancellationRetriesToCanonicalTerminal(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "stripe-delete-retry@example.test")
	biller := &deletionStripeBiller{fakeBiller: &fakeBiller{}, cancelErr: errors.New("timeout"), store: store}
	svc.biller = biller
	seedStripeDeletion(t, store, u)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	var lastError string
	var nextAttempt, updated int64
	if err := store.db.QueryRow(`SELECT last_error,next_attempt_at,updated_at FROM billing_cancellation_outbox WHERE billing_subject_id=?`, u.ID).Scan(&lastError, &nextAttempt, &updated); err != nil {
		t.Fatal(err)
	}
	if lastError == "" || nextAttempt <= updated {
		t.Fatalf("last_error=%q next=%d updated=%d", lastError, nextAttempt, updated)
	}
	biller.cancelErr = nil
	biller.terminal = true
	if _, err := store.db.Exec(`UPDATE billing_cancellation_outbox SET next_attempt_at=0 WHERE billing_subject_id=?`, u.ID); err != nil {
		t.Fatal(err)
	}
	svc.ReconcileBillingCancellations(context.Background())
	var state string
	var attempts int
	if err := store.db.QueryRow(`SELECT state,attempts FROM billing_cancellation_outbox WHERE billing_subject_id=?`, u.ID).Scan(&state, &attempts); err != nil {
		t.Fatal(err)
	}
	if state != "terminal" || attempts != 2 || biller.cancelCalls != 2 {
		t.Fatalf("retry did not converge: state=%q attempts=%d calls=%d", state, attempts, biller.cancelCalls)
	}
}

func TestAppleDeletionIsAllowedWithoutCancelingAppleAndLeavesAStickyHold(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "apple-delete@example.test")
	biller := &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: true}
	svc.biller = biller
	appleToken := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: appleToken, Now: 100}); err != nil {
		t.Fatal(err)
	}
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatalf("Apple auto-renew authority blocked deletion: %v", err)
	}
	assertDeletionStarted(t, store, u.ID)
	if biller.cancelCalls != 0 {
		t.Fatalf("Relayium tried to cancel Apple through Stripe: %d calls", biller.cancelCalls)
	}
	var provider string
	if err := store.db.QueryRow(`SELECT provider FROM billing_deletion_holds WHERE billing_subject_id=?`, u.ID).Scan(&provider); err != nil || provider != ProviderApple {
		t.Fatalf("Apple billing hold provider=%q err=%v", provider, err)
	}
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderStripe, Now: time.Now().Unix()}); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("deleted billing subject opened Stripe authority: %v", err)
	}
	recreated, err := store.UpsertUserByEmail(context.Background(), "replacement@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE users SET billing_hold_hmac=(SELECT billing_hold_hmac FROM users WHERE id=?) WHERE id=?`, u.ID, recreated.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: recreated.ID, Provider: ProviderStripe, Now: time.Now().Unix()}); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("same-email replacement bypassed billing hold: %v", err)
	}
	var outbox int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_cancellation_outbox WHERE billing_subject_id=?`, u.ID).Scan(&outbox); err != nil || outbox != 0 {
		t.Fatalf("Apple deletion created Stripe outbox=%d err=%v", outbox, err)
	}
}

func TestFreeDeletionDoesNotCreateBillingRetention(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "free-delete@example.test")
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	assertDeletionStarted(t, store, u.ID)
	for _, table := range []string{"billing_deletion_holds", "billing_cancellation_outbox"} {
		var n int
		if err := store.db.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE billing_subject_id=?`, u.ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("free deletion retained %s rows=%d err=%v", table, n, err)
		}
	}
}

func TestDeletionPreparationFailurePreservesTheConfirmationToken(t *testing.T) {
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, AccountGraceDays: 30})
	u, err := store.UpsertUserByEmail(context.Background(), "deletion-retry@example.test", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Now: 100}); err != nil {
		t.Fatal(err)
	}
	if err := svc.RequestAccountDeletion(context.Background(), u.ID, u.Email); err != nil {
		t.Fatal(err)
	}
	raw := mail.lastDeleteToken(t)
	if err := svc.ConfirmAccountDeletion(context.Background(), raw); err == nil {
		t.Fatal("deletion unexpectedly succeeded without durable billing hold configuration")
	}
	if _, ok, err := store.PeekEmailToken(context.Background(), authx.HashToken(raw), "delete", time.Now().Unix()); err != nil || !ok {
		t.Fatalf("failed preparation consumed confirmation token: ok=%v err=%v", ok, err)
	}
}

func TestAppleAuthorityWithStripeHistoryStillCreatesCancellationOutbox(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "dual-history-delete@example.test")
	biller := &deletionStripeBiller{fakeBiller: &fakeBiller{}, terminal: true, store: store}
	svc.biller = biller
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Now: 100}); err != nil {
		t.Fatal(err)
	}
	seedStripeDeletion(t, store, u)
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	assertDeletionStarted(t, store, u.ID)
	if biller.cancelCalls != 1 || !biller.observedDurableOutbox {
		t.Fatalf("legacy Stripe history was not canceled durably: calls=%d durable=%v", biller.cancelCalls, biller.observedDurableOutbox)
	}
}

func TestDeletionHoldStopsPreparedAndNewPurchaseDispatch(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "frozen-dispatch@example.test")
	now := svc.now().Unix()
	authority, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", Now: now})
	if err != nil {
		t.Fatal(err)
	}
	attempt, created, err := store.PrepareBillingPurchase(context.Background(), authority, "com.relayium.app.pro.monthly", now)
	if err != nil || !created {
		t.Fatalf("prepare created=%v err=%v", created, err)
	}
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	var holdExpires int64
	if err := store.db.QueryRow(`SELECT expires_at FROM billing_deletion_holds WHERE billing_subject_id=?`, u.ID).Scan(&holdExpires); err != nil {
		t.Fatal(err)
	}
	if holdExpires <= svc.now().Unix() {
		t.Fatalf("billing hold is not active: expires=%d now=%d", holdExpires, svc.now().Unix())
	}
	if ok, err := store.MarkBillingPurchaseDispatched(context.Background(), u.ID, attempt.ID, authority.Epoch); ok || !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("prepared purchase escaped deletion freeze: ok=%v err=%v", ok, err)
	}
	if _, _, err := store.PrepareBillingPurchase(context.Background(), authority, "com.relayium.app.max.monthly", svc.now().Unix()); !errors.Is(err, ErrBillingAuthorityConflict) {
		t.Fatalf("new purchase escaped deletion freeze: %v", err)
	}
}

func TestActiveDeletionHoldRejectsHMACKeyRotation(t *testing.T) {
	svc, store, _, u, token := deletionFixture(t, "hold-key@example.test")
	if _, err := store.AcquireBillingAuthority(context.Background(), BillingAuthorityRequest{UserID: u.ID, Provider: ProviderApple, ExternalScope: testBundleIOS, AppleAccountToken: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", Now: 100}); err != nil {
		t.Fatal(err)
	}
	if err := svc.ConfirmAccountDeletion(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	if err := store.ConfigureBillingHoldSecret("rotated-with-live-holds"); err == nil {
		t.Fatal("live billing hold accepted an HMAC key rotation")
	}
}
