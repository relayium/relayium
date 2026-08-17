package account

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// POST /api/apple/notifications, end to end.
//
// The verifier-level cases live in apple_notification_test.go. What is tested
// here is the part that decides what happens to a VERIFIED delivery: whether it
// grants, whether it is durable, and — the property that costs a customer their
// subscription when it is wrong — whether a 2xx was honest.
//
// The rule every case below measures against: Apple stops retrying after a 2xx,
// so a 2xx must mean the outcome is durable. A verified, actionable
// notification that changed nothing and was not written down may never be
// acknowledged.

// appleNotifyUUID makes distinct, well-formed notification UUIDs.
func appleNotifyUUID(n int) string {
	return fmt.Sprintf("9f0b2e3a-1c4d-4e5f-8a9b-%012x", n)
}

// notify POSTs one signed envelope and returns the status code.
func (f *appleTxFixture) notify(t *testing.T, jws string) int {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, f.ts.URL+"/api/apple/notifications",
		strings.NewReader(string(mustJSON(t, map[string]string{"signedPayload": jws}))))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := f.ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

// envelope wraps a transaction for THIS fixture's account and mapped product.
func (f *appleTxFixture) envelope(t *testing.T, uuid string, txMut ...func(map[string]any)) string {
	t.Helper()
	return f.chain.notify(t, f.chain.sign(t, f.payload(txMut...)), func(p map[string]any) {
		p["notificationUUID"] = uuid
	})
}

func (f *appleTxFixture) ledger(t *testing.T, uuid string) AppleNotificationRecord {
	t.Helper()
	rec, ok, err := f.store.GetAppleNotification(context.Background(), uuid)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Fatalf("no ledger row for %s", uuid)
	}
	return rec
}

func (f *appleTxFixture) mustNotify(t *testing.T, jws string, want int) {
	t.Helper()
	if got := f.notify(t, jws); got != want {
		t.Fatalf("want %d, got %d", want, got)
	}
}

// appleFailingStore injects storage failures at the exact points where a wrong
// answer loses a customer's subscription.
type appleFailingStore struct {
	Store
	failClaim bool
	failApply bool
	// failState fails SetAppleNotificationState for the named states only, so a
	// test can break the COMPLETION record while leaving the apply intact.
	failState map[string]bool

	// applies counts entitlement writes. Idempotency is not only "the answer did
	// not change" — a redelivery that re-derives and re-applies an event produces
	// the same row and is still doing work it was told was finished, which is
	// invisible in the resulting state and very visible under load.
	mu      sync.Mutex
	applies int
}

var errAppleTestStorage = errors.New("account: injected storage failure")

func (s *appleFailingStore) appliesSeen() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applies
}

func (s *appleFailingStore) ClaimAppleNotification(ctx context.Context, rec AppleNotificationRecord) (AppleNotificationRecord, bool, error) {
	if s.failClaim {
		return AppleNotificationRecord{}, false, errAppleTestStorage
	}
	return s.Store.ClaimAppleNotification(ctx, rec)
}

func (s *appleFailingStore) ApplySubscriptionSource(ctx context.Context, ev SourceEvent) (SubscriptionApply, error) {
	s.mu.Lock()
	s.applies++
	s.mu.Unlock()
	if s.failApply {
		return SubscriptionApply{}, errAppleTestStorage
	}
	return s.Store.ApplySubscriptionSource(ctx, ev)
}

func (s *appleFailingStore) ApplyAuthorizedAppleLifecycle(ctx context.Context, ev SourceEvent, renewal AppleRenewalState, token, environment string) (SubscriptionApply, error) {
	s.mu.Lock()
	s.applies++
	s.mu.Unlock()
	if s.failApply {
		return SubscriptionApply{}, errAppleTestStorage
	}
	store, ok := s.Store.(interface {
		ApplyAuthorizedAppleLifecycle(context.Context, SourceEvent, AppleRenewalState, string, string) (SubscriptionApply, error)
	})
	if !ok {
		return SubscriptionApply{}, errAppleTestStorage
	}
	return store.ApplyAuthorizedAppleLifecycle(ctx, ev, renewal, token, environment)
}

func (s *appleFailingStore) ApplyAuthorizedAppleSource(ctx context.Context, ev SourceEvent, token, environment, productID string) (SubscriptionApply, error) {
	s.mu.Lock()
	s.applies++
	s.mu.Unlock()
	if s.failApply {
		return SubscriptionApply{}, errAppleTestStorage
	}
	store, ok := s.Store.(interface {
		ApplyAuthorizedAppleSource(context.Context, SourceEvent, string, string, string) (SubscriptionApply, error)
	})
	if !ok {
		return SubscriptionApply{}, errAppleTestStorage
	}
	return store.ApplyAuthorizedAppleSource(ctx, ev, token, environment, productID)
}

func (s *appleFailingStore) SetAppleNotificationState(ctx context.Context, uuid, state string, now int64) error {
	if s.failState[state] {
		return errAppleTestStorage
	}
	return s.Store.SetAppleNotificationState(ctx, uuid, state, now)
}

// breakStore installs a failing store and returns the restore function.
func (f *appleTxFixture) breakStore(t *testing.T, fail *appleFailingStore) func() {
	t.Helper()
	fail.Store = f.svc.store
	original := f.svc.store
	f.svc.store = fail
	return func() { f.svc.store = original }
}

// ── The accepting path ───────────────────────────────────────────────────────

func TestAppleNotificationAppliesTheEntitlement(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(1)

	f.mustNotify(t, f.envelope(t, uuid), http.StatusOK)

	if u := f.user(t); u.PlanID != "pro" || u.PlanSource != ProviderApple {
		t.Fatalf("want pro/apple, got %s/%s", u.PlanID, u.PlanSource)
	}
	rec := f.ledger(t, uuid)
	if rec.State != appleNotificationApplied {
		t.Fatalf("ledger state: %q", rec.State)
	}
	// The ledger holds a replayable projection and nothing signed: no JWS, no
	// certificate, no raw payload.
	if rec.Projection.OriginalTransactionID == "" || rec.Projection.ExpiresDateMS == 0 {
		t.Fatalf("projection not recorded: %+v", rec.Projection)
	}
	if rec.Type != "DID_RENEW" {
		t.Fatalf("notification type not recorded for operators: %q", rec.Type)
	}
}

func TestAppleNotificationCannotCrossStripeBillingAuthority(t *testing.T) {
	f := newAppleTxFixture(t)
	ctx := context.Background()
	// Seed the contradictory legacy state below the new authority guard. A live
	// server can no longer create it: minting an Apple token is sticky history and
	// already blocks Stripe checkout. The notification path must still fail
	// closed when upgrading an old database that contains both facts.
	if _, err := f.store.ApplySubscriptionSource(ctx, SourceEvent{UserID: f.userID, Provider: ProviderStripe, PlanID: "plus", Status: "active", Cycle: "monthly", PeriodEnd: time.Now().Add(time.Hour).Unix(), ExternalID: "sub_legacy", EventAt: 100, Now: time.Now().Unix()}); err != nil {
		t.Fatal(err)
	}
	uuid := appleNotifyUUID(44)
	f.mustNotify(t, f.envelope(t, uuid), http.StatusInternalServerError)

	if _, ok, err := f.store.GetSubscriptionSource(ctx, f.userID, ProviderApple); err != nil || ok {
		t.Fatalf("conflicting notification wrote Apple source: ok=%v err=%v", ok, err)
	}
	stripe, ok, err := f.store.GetSubscriptionSource(ctx, f.userID, ProviderStripe)
	if err != nil || !ok || stripe.PlanID != "plus" {
		t.Fatalf("conflicting notification changed Stripe: %+v ok=%v err=%v", stripe, ok, err)
	}
	if rec := f.ledger(t, uuid); rec.State == appleNotificationApplied {
		t.Fatalf("conflicting notification was ACKed applied: %+v", rec)
	}
}

func TestAppleNotificationForDeletedBillingSubjectIsQuarantined(t *testing.T) {
	f := newAppleTxFixture(t)
	ctx := context.Background()
	if _, err := f.store.db.ExecContext(ctx, `UPDATE apple_billing_subjects SET deleted_at=? WHERE app_account_token=?`, time.Now().Unix(), f.token); err != nil {
		t.Fatal(err)
	}
	uuid := appleNotifyUUID(45)
	f.mustNotify(t, f.envelope(t, uuid), http.StatusOK)
	if rec := f.ledger(t, uuid); rec.State != appleNotificationQuarantined {
		t.Fatalf("deleted subject notification=%+v", rec)
	}
	if _, ok, err := f.store.GetSubscriptionSource(ctx, f.userID, ProviderApple); err != nil || ok {
		t.Fatalf("quarantined notification wrote source: ok=%v err=%v", ok, err)
	}
}

// ── Idempotency, and the record-before-apply window ──────────────────────────

// A redelivery of finished work is a no-op 200. Apple redelivers on its own
// schedule and after any non-2xx, so this is the ordinary case, not the edge.
func TestAppleNotificationIsIdempotentAcrossRedelivery(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(2)
	env := f.envelope(t, uuid)

	f.mustNotify(t, env, http.StatusOK)
	before := f.user(t)
	rec := f.ledger(t, uuid)

	// Count the entitlement writes the redeliveries cause. Asserting only that
	// the RESULT is unchanged is too weak: re-deriving and re-applying the same
	// event produces an identical row, so a ledger that let a redelivery reopen
	// finished work would look exactly like one that short-circuited it.
	counter := &appleFailingStore{}
	restore := f.breakStore(t, counter)
	for range 3 {
		f.mustNotify(t, env, http.StatusOK)
	}
	restore()

	if got := counter.appliesSeen(); got != 0 {
		t.Fatalf("a redelivery of finished work re-applied the entitlement %d time(s)", got)
	}
	after := f.user(t)
	if after.PlanID != before.PlanID || after.SubscriptionEnd != before.SubscriptionEnd {
		t.Fatalf("redelivery changed the entitlement: %+v -> %+v", before, after)
	}
	got := f.ledger(t, uuid)
	if got.State != appleNotificationApplied {
		t.Fatalf("a redelivery moved a terminal row out of its state: %q", got.State)
	}
	if got.UpdatedAt != rec.UpdatedAt {
		t.Fatalf("a redelivery rewrote a terminal ledger row: %d -> %d", rec.UpdatedAt, got.UpdatedAt)
	}
}

// Two deliveries of one UUID arriving at once. Both must be honest, and the
// subscription must end up in the state one of them would have produced.
func TestAppleNotificationSurvivesConcurrentDuplicateDelivery(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(3)
	env := f.envelope(t, uuid)

	const racers = 4
	codes := make([]int, racers)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := range racers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			codes[i] = f.notify(t, env)
		}()
	}
	close(start)
	wg.Wait()

	for i, code := range codes {
		if code != http.StatusOK {
			t.Fatalf("racer %d: want 200, got %d", i, code)
		}
	}
	if u := f.user(t); u.PlanID != "pro" {
		t.Fatalf("want pro, got %s", u.PlanID)
	}
	if rec := f.ledger(t, uuid); rec.State != appleNotificationApplied {
		t.Fatalf("ledger state: %q", rec.State)
	}
	// One delivery, one row: a concurrent duplicate must not be able to create a
	// second ledger identity for the same notification.
	counts, err := f.store.CountAppleNotificationsByState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if counts[appleNotificationApplied] != 1 || len(counts) != 1 {
		t.Fatalf("want exactly one applied row, got %v", counts)
	}
}

// THE RECORD-BEFORE-APPLY WINDOW. A crash after the ledger row is written and
// before the entitlement lands must be REDONE by the retry, not short-circuited
// as already seen. This is the case that silently costs a paying customer their
// plan, and it is why the claim is not a completion.
func TestAppleNotificationRetryRedoesAnInterruptedApply(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(4)
	env := f.envelope(t, uuid)

	restore := f.breakStore(t, &appleFailingStore{failApply: true})
	f.mustNotify(t, env, http.StatusInternalServerError)
	restore()

	// The row exists — it was claimed — and it is deliberately NOT terminal.
	rec := f.ledger(t, uuid)
	if rec.State != appleNotificationReceived {
		t.Fatalf("an interrupted delivery must stay claimed-not-done, got %q", rec.State)
	}
	if appleNotificationTerminal(rec.State) {
		t.Fatal("an interrupted delivery must not be terminal")
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("nothing should have been granted, got %s", u.PlanID)
	}

	// Apple's retry finds the claim and does the work anyway.
	f.mustNotify(t, env, http.StatusOK)
	if u := f.user(t); u.PlanID != "pro" {
		t.Fatalf("the retry must apply the entitlement, got %s", u.PlanID)
	}
	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("ledger state after retry: %q", got)
	}
}

// Once a UUID has claimed a verified projection, a later body reusing that UUID
// must replay the stored projection. Otherwise a retry could apply different
// entitlement facts from the ones the durable ledger says it preserved.
func TestAppleNotificationRetryUsesTheFirstClaimedProjection(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(41)
	firstExpiry := time.Now().Add(24 * time.Hour).UnixMilli()
	secondExpiry := time.Now().Add(72 * time.Hour).UnixMilli()
	first := f.envelope(t, uuid, func(p map[string]any) { p["expiresDate"] = firstExpiry })
	second := f.envelope(t, uuid, func(p map[string]any) { p["expiresDate"] = secondExpiry })

	restore := f.breakStore(t, &appleFailingStore{failApply: true})
	f.mustNotify(t, first, http.StatusInternalServerError)
	restore()
	f.mustNotify(t, second, http.StatusOK)

	if got := f.user(t).SubscriptionEnd; got != firstExpiry/1000 {
		t.Fatalf("retry applied the second body: end=%d want first projection %d", got, firstExpiry/1000)
	}
	if got := f.ledger(t, uuid).Projection.ExpiresDateMS; got != firstExpiry {
		t.Fatalf("ledger projection changed: %d want %d", got, firstExpiry)
	}
}

func TestAppleNotificationRetryPreservesANonActionableClaim(t *testing.T) {
	for _, tc := range []struct {
		name     string
		state    string
		envelope func(*testing.T, *appleTxFixture, string) string
	}{
		{
			name: "no transaction", state: appleNotificationIgnored,
			envelope: func(t *testing.T, f *appleTxFixture, uuid string) string {
				return f.chain.notify(t, "", func(p map[string]any) { p["notificationUUID"] = uuid })
			},
		},
		{
			name: "unsupported transaction", state: appleNotificationUnsupported,
			envelope: func(t *testing.T, f *appleTxFixture, uuid string) string {
				tx := f.chain.sign(t, f.payload(func(p map[string]any) { p["type"] = "Consumable" }))
				return f.chain.notify(t, tx, func(p map[string]any) { p["notificationUUID"] = uuid })
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newAppleTxFixture(t)
			uuid := appleNotifyUUID(42)
			env := tc.envelope(t, f, uuid)
			restore := f.breakStore(t, &appleFailingStore{failState: map[string]bool{tc.state: true}})
			f.mustNotify(t, env, http.StatusInternalServerError)
			restore()

			f.mustNotify(t, env, http.StatusOK)
			if got := f.ledger(t, uuid).State; got != tc.state {
				t.Fatalf("retry state=%q want %q", got, tc.state)
			}
			if got := f.user(t).PlanID; got != "free" {
				t.Fatalf("non-actionable retry granted %q", got)
			}
		})
	}
}

// The mirror case: the entitlement IS applied and recording the completion
// fails. Losing the completion record costs a repeated (idempotent) apply;
// answering 200 here would be a lie only if the apply had not happened, so the
// requirement is that the retry converges without double-granting.
func TestAppleNotificationRetryConvergesWhenTheCompletionRecordFails(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(5)
	env := f.envelope(t, uuid)

	restore := f.breakStore(t, &appleFailingStore{
		failState: map[string]bool{appleNotificationApplied: true},
	})
	f.mustNotify(t, env, http.StatusInternalServerError)
	restore()

	// The entitlement landed even though the answer was a retryable failure.
	granted := f.user(t)
	if granted.PlanID != "pro" {
		t.Fatalf("the apply committed, so the plan must be pro, got %s", granted.PlanID)
	}
	if got := f.ledger(t, uuid).State; got != appleNotificationReceived {
		t.Fatalf("the completion was not recorded, so the row must stay claimed: %q", got)
	}

	// The retry re-applies the same event. An equal event clock is not older than
	// itself, so this converges instead of double-granting or rewinding.
	f.mustNotify(t, env, http.StatusOK)
	after := f.user(t)
	if after.PlanID != granted.PlanID || after.SubscriptionEnd != granted.SubscriptionEnd {
		t.Fatalf("the retry moved the entitlement: %+v -> %+v", granted, after)
	}
	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("ledger state after retry: %q", got)
	}
}

// A claim that cannot be written is a delivery nothing knows about. It must be
// retryable, and it must not grant.
func TestAppleNotificationStorageFailureStaysRetryable(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(6)

	restore := f.breakStore(t, &appleFailingStore{failClaim: true})
	f.mustNotify(t, f.envelope(t, uuid), http.StatusInternalServerError)
	restore()

	if _, ok, err := f.store.GetAppleNotification(context.Background(), uuid); err != nil || ok {
		t.Fatalf("want no ledger row, got ok=%v err=%v", ok, err)
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("nothing should have been granted, got %s", u.PlanID)
	}
	f.mustNotify(t, f.envelope(t, uuid), http.StatusOK)
	if u := f.user(t); u.PlanID != "pro" {
		t.Fatalf("the retry must apply, got %s", u.PlanID)
	}
}

// ── Ordering ─────────────────────────────────────────────────────────────────

// A refund for an OLD period arriving after a newer renewal must not cancel the
// subscription the user is currently paying for. The clock is derived from the
// transaction's own purchaseDate, never from the envelope's signedDate or from
// arrival order.
func TestAppleNotificationDropsALateOlderGeneration(t *testing.T) {
	f := newAppleTxFixture(t)
	base := time.Now().UnixMilli()
	gen1 := base - 60*24*60*60*1000
	gen2 := base - 24*60*60*1000

	// The current period.
	f.mustNotify(t, f.envelope(t, appleNotifyUUID(10), func(p map[string]any) {
		p["transactionId"] = "2000000000000002"
		p["purchaseDate"] = gen2
		p["expiresDate"] = base + 30*24*60*60*1000
	}), http.StatusOK)
	current := f.user(t)
	if current.PlanID != "pro" {
		t.Fatalf("want pro, got %s", current.PlanID)
	}

	// A refund of the PREVIOUS period, delivered late. Its revocation happened
	// after the renewal in wall-clock time; ordering by that would cancel a live
	// subscription.
	f.mustNotify(t, f.envelope(t, appleNotifyUUID(11), func(p map[string]any) {
		p["transactionId"] = "2000000000000001"
		p["purchaseDate"] = gen1
		p["expiresDate"] = gen2
		p["revocationDate"] = base
		p["revocationReason"] = 0
	}), http.StatusOK)

	after := f.user(t)
	if after.PlanID != "pro" || after.SubscriptionEnd != current.SubscriptionEnd {
		t.Fatalf("a late older-generation refund cancelled a live subscription: %+v -> %+v", current, after)
	}
	// It was still handled and recorded, not refused.
	if got := f.ledger(t, appleNotifyUUID(11)).State; got != appleNotificationApplied {
		t.Fatalf("ledger state: %q", got)
	}

	// A refund of the CURRENT generation does end it.
	f.mustNotify(t, f.envelope(t, appleNotifyUUID(12), func(p map[string]any) {
		p["transactionId"] = "2000000000000002"
		p["purchaseDate"] = gen2
		p["expiresDate"] = base + 30*24*60*60*1000
		p["revocationDate"] = base
	}), http.StatusOK)
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("a refund of the live period must end access, got %s", u.PlanID)
	}
}

// ── Attribution ──────────────────────────────────────────────────────────────

// A notification this server cannot attribute may not grant, and may not be
// discarded either. Apple routinely delivers before the purchasing client
// finishes its own round trip.
func TestAppleNotificationDefersAnUnattributableDelivery(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(20)
	stranger := "7c9e6679-7425-4de8-a4d1-4d1e2f3a4b5c"

	f.mustNotify(t, f.envelope(t, uuid, func(p map[string]any) {
		p["appAccountToken"] = stranger
	}), http.StatusOK)

	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("an unattributable notification must not grant, got %s", u.PlanID)
	}
	rec := f.ledger(t, uuid)
	if rec.State != appleNotificationPending {
		t.Fatalf("want pending, got %q", rec.State)
	}
	// Preserved with everything a replay needs.
	if rec.Projection.OriginalTransactionID == "" || rec.Projection.ProductID == "" ||
		rec.Projection.ExpiresDateMS == 0 || rec.Projection.PurchaseDateMS == 0 {
		t.Fatalf("the deferred projection is not replayable: %+v", rec.Projection)
	}

	// A transaction with no attribution token at all lands in the same place
	// rather than being refused and lost.
	noToken := appleNotifyUUID(21)
	f.mustNotify(t, f.chain.notify(t,
		f.chain.sign(t, f.payload(func(p map[string]any) { delete(p, "appAccountToken") })),
		func(p map[string]any) { p["notificationUUID"] = noToken }), http.StatusOK)
	if got := f.ledger(t, noToken).State; got != appleNotificationPending {
		t.Fatalf("an unattributed transaction must be deferred, got %q", got)
	}
}

// The deferred delivery is replayed the moment attribution exists — which is
// exactly what the client's own intake call establishes.
func TestAppleNotificationDrainsOnceTheOwnerIsKnown(t *testing.T) {
	f := newAppleTxFixture(t)
	uuid := appleNotifyUUID(22)
	expires := time.Now().Add(30 * 24 * time.Hour).UnixMilli()

	// Apple's notification arrives first without an attribution token. The later
	// canonical intake must bind through the same subscription identity; a
	// different nonempty token is a permanent authority conflict, not something
	// this drain may silently rewrite.
	f.mustNotify(t, f.envelope(t, uuid, func(p map[string]any) {
		delete(p, "appAccountToken")
		p["expiresDate"] = expires
	}), http.StatusOK)
	if got := f.ledger(t, uuid).State; got != appleNotificationPending {
		t.Fatalf("want pending, got %q", got)
	}

	// The client then submits the same subscription through the authenticated
	// intake, which binds the originalTransactionId to this account.
	f.mustAccept(t, f.chain.sign(t, f.payload(func(p map[string]any) {
		p["expiresDate"] = expires
	})))

	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("the deferred delivery must be replayed once the owner is known, got %q", got)
	}
	if u := f.user(t); u.PlanID != "pro" {
		t.Fatalf("want pro, got %s", u.PlanID)
	}
}

// Apple's record and ours disagreeing about who owns a subscription grants
// nothing, is preserved, and is deliberately FAILED so the delivery stays
// visible in App Store Connect's notification history.
func TestAppleNotificationRefusesAnOwnershipConflict(t *testing.T) {
	f := newAppleTxFixture(t)
	ctx := context.Background()

	// A second account owns this subscription id.
	other := loginCookie(t, f.ts, f.mail, "apple-other@example.com")
	_ = other
	otherID := mustUserID(t, f.store, "apple-other@example.com")
	// Bound under the SAME environment-qualified identity a real Sandbox purchase
	// would have produced; the bare id names a different (Production) subscription.
	if err := f.store.BindExternalSubscription(ctx, otherID, ProviderApple, testAppleSandboxExternalID); err != nil {
		t.Fatal(err)
	}

	// The notification's own token names THIS account.
	uuid := appleNotifyUUID(30)
	f.mustNotify(t, f.envelope(t, uuid), http.StatusInternalServerError)

	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("a conflicting notification must not grant, got %s", u.PlanID)
	}
	rec := f.ledger(t, uuid)
	if rec.State != appleNotificationConflict {
		t.Fatalf("want conflict, got %q", rec.State)
	}
	// Not terminal: a retry re-runs the decision, because the resolution is a
	// human fixing the ownership rather than Apple sending something different.
	if appleNotificationTerminal(rec.State) {
		t.Fatal("a conflict must not be terminal")
	}
	f.mustNotify(t, f.envelope(t, uuid), http.StatusInternalServerError)
}

// A renewal for a subscription this server already owns applies even when the
// transaction's attribution token is absent — the recorded binding is the
// second, independent key.
func TestAppleNotificationResolvesTheOwnerFromTheRecordedBinding(t *testing.T) {
	f := newAppleTxFixture(t)
	expires := time.Now().Add(30 * 24 * time.Hour).UnixMilli()
	f.mustAccept(t, f.chain.sign(t, f.payload(func(p map[string]any) { p["expiresDate"] = expires })))

	later := time.Now().Add(60 * 24 * time.Hour).UnixMilli()
	uuid := appleNotifyUUID(31)
	f.mustNotify(t, f.chain.notify(t, f.chain.sign(t, f.payload(func(p map[string]any) {
		delete(p, "appAccountToken")
		p["transactionId"] = "2000000000000009"
		p["purchaseDate"] = time.Now().UnixMilli()
		p["expiresDate"] = later
	})), func(p map[string]any) { p["notificationUUID"] = uuid }), http.StatusOK)

	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("want applied, got %q", got)
	}
	if u := f.user(t); u.PlanID != "pro" || u.SubscriptionEnd != appleSeconds(later) {
		t.Fatalf("the renewal must extend the period: plan=%s end=%d want %d",
			u.PlanID, u.SubscriptionEnd, appleSeconds(later))
	}
}

// ── Shapes this server does not model ────────────────────────────────────────

func TestAppleNotificationRecordsUnsupportedAndEmptyDeliveries(t *testing.T) {
	f := newAppleTxFixture(t)

	// A verified transaction of a kind the entitlement model has no
	// representation for. Terminal, recorded, and never guessed at.
	shape := appleNotifyUUID(40)
	f.mustNotify(t, f.envelope(t, shape, func(p map[string]any) {
		p["inAppOwnershipType"] = "FAMILY_SHARED"
	}), http.StatusOK)
	if got := f.ledger(t, shape).State; got != appleNotificationUnsupported {
		t.Fatalf("want unsupported, got %q", got)
	}

	// A notification with no transaction at all. The type must not be allowed to
	// supply an entitlement fact, so there is nothing to do — but it is still
	// written down rather than silently dropped.
	empty := appleNotifyUUID(41)
	f.mustNotify(t, f.chain.notify(t, "", func(p map[string]any) {
		p["notificationUUID"] = empty
		p["notificationType"] = "RENEWAL_EXTENSION"
	}), http.StatusOK)
	rec := f.ledger(t, empty)
	if rec.State != appleNotificationIgnored {
		t.Fatalf("want ignored, got %q", rec.State)
	}
	if rec.Type != "RENEWAL_EXTENSION" {
		t.Fatalf("the type must be recorded for operators, got %q", rec.Type)
	}

	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("neither delivery may grant, got %s", u.PlanID)
	}
	// A notification type that WOULD imply a grant, carrying a transaction that
	// does not: the label must never outrank the signed transaction.
	lying := appleNotifyUUID(42)
	f.mustNotify(t, f.chain.notify(t,
		f.chain.sign(t, f.payload(func(p map[string]any) {
			p["expiresDate"] = time.Now().Add(-time.Hour).UnixMilli()
		})),
		func(p map[string]any) {
			p["notificationUUID"] = lying
			p["notificationType"] = "SUBSCRIBED"
			p["subtype"] = "INITIAL_BUY"
		}), http.StatusOK)
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("a SUBSCRIBED label over an expired transaction granted %s", u.PlanID)
	}
}

// ── The catalog ──────────────────────────────────────────────────────────────

// A live purchase for a product no catalog row maps is preserved for replay,
// not refused: the money has moved and the recovery is an operator adding the
// mapping.
func TestAppleNotificationDefersAnUnmappedProductAndReplaysIt(t *testing.T) {
	f := newAppleTxFixture(t)
	ctx := context.Background()
	uuid := appleNotifyUUID(50)
	unmapped := "com.relayium.app.max.yearly"

	env := f.envelope(t, uuid, func(p map[string]any) { p["productId"] = unmapped })
	f.mustNotify(t, env, http.StatusOK)
	if got := f.ledger(t, uuid).State; got != appleNotificationPending {
		t.Fatalf("want pending, got %q", got)
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("an unmapped product must not grant, got %s", u.PlanID)
	}

	// The operator adds the mapping; a redelivery of the same UUID is re-run
	// because a deferred row is not terminal.
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleIOS, ProductID: unmapped,
		PlanID: "pro", Cycle: "yearly", Active: true,
	})
	f.mustNotify(t, env, http.StatusOK)
	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("want applied, got %q", got)
	}
	if u := f.user(t); u.PlanID != "pro" {
		t.Fatalf("want pro, got %s", u.PlanID)
	}
	_ = ctx
}

// ENDING access must never depend on the catalog. A refund for a product whose
// mapping has been retired still revokes: requiring a live mapping there would
// mean retiring a row silently disabled revocation for everyone using it.
func TestAppleNotificationRevokesWithoutACatalogMapping(t *testing.T) {
	f := newAppleTxFixture(t)
	ctx := context.Background()
	expires := time.Now().Add(30 * 24 * time.Hour).UnixMilli()

	f.mustAccept(t, f.chain.sign(t, f.payload(func(p map[string]any) { p["expiresDate"] = expires })))
	if u := f.user(t); u.PlanID != "pro" {
		t.Fatalf("want pro, got %s", u.PlanID)
	}

	// The operator retires the mapping.
	mustAppleProduct(t, f.store, AppleProduct{
		BundleID: testBundleIOS, ProductID: testAppleProduct,
		PlanID: "pro", Cycle: "monthly", Active: false,
	})
	if _, ok, err := f.store.AppleProductPlan(ctx, testBundleIOS, testAppleProduct); err != nil || ok {
		t.Fatalf("the mapping must no longer resolve: ok=%v err=%v", ok, err)
	}

	uuid := appleNotifyUUID(51)
	f.mustNotify(t, f.envelope(t, uuid, func(p map[string]any) {
		p["expiresDate"] = expires
		p["revocationDate"] = time.Now().UnixMilli()
	}), http.StatusOK)

	if got := f.ledger(t, uuid).State; got != appleNotificationApplied {
		t.Fatalf("want applied, got %q", got)
	}
	if u := f.user(t); u.PlanID != "free" {
		t.Fatalf("a refund must revoke even with no live mapping, got %s", u.PlanID)
	}
}

// ── The endpoint's own boundary ──────────────────────────────────────────────

// An unconfigured deployment — the shipping default — answers a RETRYABLE 503.
// A 200 here would have Apple discard deliveries it will never send again.
func TestAppleNotificationIsInertWithoutAVerifier(t *testing.T) {
	f := newAppleTxFixture(t)
	f.svc.SetAppleTransactionVerifier(nil)

	f.mustNotify(t, f.envelope(t, appleNotifyUUID(60)), http.StatusServiceUnavailable)

	counts, err := f.store.CountAppleNotificationsByState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(counts) != 0 {
		t.Fatalf("an unconfigured deployment recorded something: %v", counts)
	}
}

// A payload this deployment did not configure trust for is REFUSED, and leaves
// no ledger row: there is nothing to preserve and nothing a retry would fix.
func TestAppleNotificationRefusesForeignAndMalformedBodies(t *testing.T) {
	f := newAppleTxFixture(t)
	foreign := newAppleTestChain(t)

	f.mustNotify(t, foreign.notify(t, foreign.sign(t, f.payload()), func(p map[string]any) {
		p["notificationUUID"] = appleNotifyUUID(61)
	}), http.StatusBadRequest)
	if _, ok, _ := f.store.GetAppleNotification(context.Background(), appleNotifyUUID(61)); ok {
		t.Fatal("a refused delivery must leave no ledger row")
	}

	post := func(body string) int {
		req, err := http.NewRequest(http.MethodPost, f.ts.URL+"/api/apple/notifications", strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		resp, err := f.ts.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}
	for _, body := range []string{
		``, `{`, `[]`, `{"signedPayload": ""}`, `{"signedPayload": " abc.def.ghi"}`,
		`{"signedPayload": "a.b.c"}{"signedPayload": "a.b.c"}`,
		`{"signedPayload":"a.b.c","signedPayload":"d.e.f"}`,
	} {
		if got := post(body); got != http.StatusBadRequest {
			t.Fatalf("body %q: want 400, got %d", body, got)
		}
	}
	// An unknown field is TOLERATED — Apple adds fields to this schema, and
	// refusing them would be a self-inflicted outage.
	if got := post(string(mustJSON(t, map[string]any{
		"signedPayload": f.envelope(t, appleNotifyUUID(62)), "somethingNew": true,
	}))); got != http.StatusOK {
		t.Fatalf("an unknown field must not refuse the delivery, got %d", got)
	}
	// A body past the limit is refused rather than read.
	if got := post(`{"signedPayload": "` + strings.Repeat("A", appleNotificationBodyLimit) + `"}`); got != http.StatusBadRequest {
		t.Fatalf("oversized body: want 400, got %d", got)
	}
}

// Nothing this endpoint logs may carry the payload, the certificates or the
// attribution token. A log line outlives the request that made it, and this one
// is written for every delivery.
func TestAppleNotificationLogsCarryNoMaterial(t *testing.T) {
	f := newAppleTxFixture(t)
	foreign := newAppleTestChain(t)

	var logged bytes.Buffer
	original := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(original)

	good := f.envelope(t, appleNotifyUUID(70))
	f.mustNotify(t, good, http.StatusOK)
	bad := foreign.notify(t, foreign.sign(t, f.payload()), func(p map[string]any) {
		p["notificationUUID"] = appleNotifyUUID(71)
	})
	f.mustNotify(t, bad, http.StatusBadRequest)

	out := logged.String()
	if out == "" {
		t.Fatal("nothing was logged, so this test proves nothing")
	}
	for name, secret := range map[string]string{
		"the accepted envelope": good,
		"the refused envelope":  bad,
		"the account token":     f.token,
		"a certificate":         f.chain.x5c()[0],
	} {
		if strings.Contains(out, secret) {
			t.Fatalf("the log leaked %s:\n%s", name, out)
		}
	}
	// The UUID an operator needs in order to correlate with App Store Connect IS
	// present — redaction must not cost diagnosability.
	if !strings.Contains(out, appleNotifyUUID(70)) {
		t.Fatalf("the notification uuid must be logged:\n%s", out)
	}
}
