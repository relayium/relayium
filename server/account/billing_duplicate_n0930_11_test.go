package account

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"testing"
)

// N-0930-11: the discovery sweep enqueues responsibilities for live
// duplicates nobody discovered; it never cancels, binds, rebinds or chooses a
// canonical. Driven against the N-0930-2 Stripe fake and the real webhook
// handler for setup.

func n093011Sweep(t *testing.T, svc *Service) string {
	t.Helper()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(os.Stderr)
	svc.DiscoverStripeDuplicates(context.Background())
	return buf.String()
}

func n093011Deletes(f *n09302Stripe) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, d := range f.deletes {
		n += d
	}
	return n
}

func n093011Rows(t *testing.T, store *SQLiteStore) int {
	t.Helper()
	var n int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM billing_duplicate_refunds`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// assertSweepOnlyEnqueued: the sweep issued no DELETE and left the binding.
func assertSweepOnlyEnqueued(t *testing.T, f *n09302Stripe, store *SQLiteStore, binding string) {
	t.Helper()
	if d := n093011Deletes(f); d != 0 {
		t.Fatalf("the sweep must never cancel: deletes=%d", d)
	}
	if u, _ := n09302User_(t, store); u.StripeSubscriptionID != binding {
		t.Fatalf("the sweep must never bind or rebind: binding=%q want %q", u.StripeSubscriptionID, binding)
	}
}

// (a) The first-subscription adoption binds without listing: B, whose events
// were lost, is never discovered inline. The sweep records it against the
// bound A; the worker then cancels it exactly as an inline placeholder.
func TestN0930_11AdoptionWithoutListingIsDiscovered(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	f.set("sub_B", "active", 200)
	n09302AdoptA(t, f, ts, svc, store)
	if n093011Rows(t, store) != 0 {
		t.Fatal("setup: adoption must not have discovered B")
	}
	n093011Sweep(t, svc)
	assertSweepOnlyEnqueued(t, f, store, "sub_A")
	job, ok, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B")
	if !ok || job.CanonicalSubscriptionID != "sub_A" || job.DiscoveredAt != 0 || job.State != "pending" || job.CancelHold != "" {
		t.Fatalf("placeholder must be born unknown against the bound canonical: %+v", job)
	}
	svc.ReconcileDuplicateRefunds(context.Background())
	f.mu.Lock()
	deletesB, deletesA := f.deletes["sub_B"], f.deletes["sub_A"]
	f.mu.Unlock()
	done, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B")
	if deletesB != 1 || deletesA != 0 || !done.SubscriptionCanceled || done.DiscoveredAt == 0 || !done.PostCancelInspected || done.State != "terminal" {
		t.Fatalf("worker must process the sweep's placeholder like an inline one: deletesA=%d deletesB=%d job=%+v", deletesA, deletesB, done)
	}
}

// (b) A canonical deletion clears the binding without discovering survivors:
// several live, no canonical -> attention, no responsibility; one survivor is
// not a duplicate -> nothing.
func TestN0930_11CanonicalDeletionSurvivorsNeedOperator(t *testing.T) {
	for _, survivors := range []int{1, 2} {
		t.Run(fmt.Sprintf("%d_live", survivors), func(t *testing.T) {
			f, store, svc, ts := newN09302(t)
			n09302AdoptA(t, f, ts, svc, store)
			f.set("sub_A", "canceled", 100)
			f.set("sub_B", "active", 200)
			if survivors == 2 {
				f.set("sub_C", "active", 250)
			}
			if st := n09302Deliver(t, ts, svc, "customer.subscription.deleted", "sub_A", 300); st != http.StatusOK {
				t.Fatalf("A deleted status=%d", st)
			}
			out := n093011Sweep(t, svc)
			assertSweepOnlyEnqueued(t, f, store, "")
			attention := strings.Contains(out, duplicateDiscoveryAttention+": user=user_m") && strings.Contains(out, "live=sub_B,sub_C")
			if n093011Rows(t, store) != 0 || attention != (survivors == 2) {
				t.Fatalf("rows=%d attention=%t log:\n%s", n093011Rows(t, store), attention, out)
			}
		})
	}
}

// (c) Admin comps skip dedup. The sweep still records the duplicate against
// the bound canonical, and the worker's admin_comp hold keeps it from being
// canceled.
func TestN0930_11ComppedAccountDuplicateIsHeldNotCanceled(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	if _, err := store.db.Exec(`UPDATE users SET plan_source='admin',plan_id='max' WHERE id=?`, n09302User); err != nil {
		t.Fatal(err)
	}
	f.set("sub_B", "active", 200)
	n093011Sweep(t, svc)
	assertSweepOnlyEnqueued(t, f, store, "sub_A")
	svc.ReconcileDuplicateRefunds(context.Background())
	job, ok, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B")
	if !ok || job.CanonicalSubscriptionID != "sub_A" || job.CancelHold != duplicateHoldAdminComp || job.SubscriptionCanceled || n093011Deletes(f) != 0 {
		t.Fatalf("comped duplicate must be recorded and held: ok=%t job=%+v deletes=%d", ok, job, n093011Deletes(f))
	}
}

// (d) The reconcile sweep skips every account with a live subscription and
// every non-paid one; discovery covers an account that never adopted anything
// (plan_source ”) with several live subscriptions -> attention only.
func TestN0930_11NeverAdoptedAccountWithSeveralLiveNeedsOperator(t *testing.T) {
	f, store, svc, _ := newN09302(t)
	f.set("sub_A", "active", 100)
	f.set("sub_B", "active", 200)
	out := n093011Sweep(t, svc)
	assertSweepOnlyEnqueued(t, f, store, "")
	if n093011Rows(t, store) != 0 || !strings.Contains(out, duplicateDiscoveryAttention) {
		t.Fatalf("rows=%d log:\n%s", n093011Rows(t, store), out)
	}
}

// (e) From N-0930-2: on a bound account a delayed, older duplicate creation is
// dropped by the B-M3 replay rule. Discovery records it.
func TestN0930_11DelayedDuplicateOnBoundAccountIsDiscovered(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	n09302Deliver(t, ts, svc, "customer.subscription.updated", "sub_A", 300)
	f.set("sub_B", "active", 200)
	n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_B", 200)
	if n093011Rows(t, store) != 0 {
		t.Fatal("setup: the delayed creation must have been dropped")
	}
	n093011Sweep(t, svc)
	assertSweepOnlyEnqueued(t, f, store, "sub_A")
	if job, ok, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B"); !ok || job.CanonicalSubscriptionID != "sub_A" {
		t.Fatalf("delayed duplicate must be discovered: ok=%t job=%+v", ok, job)
	}
}

// (e2) Unbound account whose source row is live (a legacy comp never bound
// one): the live row names the canonical. The responsibility is recorded, and
// the authorizer -- which requires the users binding to equal it -- holds it
// (canonical_replaced) for an operator instead of canceling.
func TestN0930_11UnboundLiveSourceDuplicateIsRecordedAndHeld(t *testing.T) {
	for _, tc := range []struct{ name, wantHold string }{{"comped", duplicateHoldAdminComp}, {"comp_lifted", duplicateHoldCanonicalReplaced}} {
		t.Run(tc.name, func(t *testing.T) {
			f, store, svc, ts := newN09302(t)
			if _, err := store.db.Exec(`INSERT INTO billing_authorities(user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at) VALUES(?,'stripe','','','',1,'intent_legacy',1,1)`, n09302User); err != nil {
				t.Fatal(err)
			}
			if _, err := store.db.Exec(`UPDATE users SET plan_source='admin',plan_id='max' WHERE id=?`, n09302User); err != nil {
				t.Fatal(err)
			}
			f.set("sub_A", "active", 100)
			if st := n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_A", 300); st != http.StatusOK {
				t.Fatalf("A under comp status=%d", st)
			}
			if tc.name == "comp_lifted" {
				if _, err := store.db.Exec(`UPDATE users SET plan_source='stripe',plan_id='pro' WHERE id=?`, n09302User); err != nil {
					t.Fatal(err)
				}
			}
			f.set("sub_B", "active", 200)
			n093011Sweep(t, svc)
			assertSweepOnlyEnqueued(t, f, store, "")
			svc.ReconcileDuplicateRefunds(context.Background())
			job, ok, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B")
			if !ok || job.CanonicalSubscriptionID != "sub_A" || job.CancelHold != tc.wantHold || job.SubscriptionCanceled || n093011Deletes(f) != 0 {
				t.Fatalf("unbound live-source duplicate must be recorded and held (%s): ok=%t job=%+v deletes=%d", tc.wantHold, ok, job, n093011Deletes(f))
			}
		})
	}
}

// Comped account with nothing known (no binding, no live source) and several
// live subscriptions: attention only.
func TestN0930_11CompedAccountWithNothingKnownNeedsOperator(t *testing.T) {
	f, store, svc, _ := newN09302(t)
	if _, err := store.db.Exec(`UPDATE users SET plan_source='admin',plan_id='max' WHERE id=?`, n09302User); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO subscription_sources(user_id,provider,plan_id,status,cycle,period_end,external_id,external_scope,event_at,updated_at) VALUES(?,'stripe','free','canceled','',0,'sub_old','',50,50)`, n09302User); err != nil {
		t.Fatal(err)
	}
	f.set("sub_A", "active", 100)
	f.set("sub_B", "active", 200)
	out := n093011Sweep(t, svc)
	assertSweepOnlyEnqueued(t, f, store, "")
	if n093011Rows(t, store) != 0 || !strings.Contains(out, "plan_source=admin") || !strings.Contains(out, duplicateDiscoveryAttention) {
		t.Fatalf("rows=%d log:\n%s", n093011Rows(t, store), out)
	}
}

// Fable (N-0930-2): the cross-subscription exemption adopts without a list
// call, so a SECOND delayed live subscription is found only by discovery.
func TestN0930_11SecondDelayedLiveSubscriptionAfterExemptionIsDiscovered(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	n09302Deliver(t, ts, svc, "customer.subscription.updated", "sub_A", 400)
	f.set("sub_A", "canceled", 100)
	svc.ReconcileStripeSubscriptions(context.Background())
	f.set("sub_B", "active", 200)
	f.set("sub_C", "active", 250)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_B", 200); st != http.StatusOK {
		t.Fatalf("B status=%d", st)
	}
	if u, _ := n09302User_(t, store); u.StripeSubscriptionID != "sub_B" || n093011Rows(t, store) != 0 {
		t.Fatalf("setup: B adopted by the exemption without discovering C: %+v rows=%d", u, n093011Rows(t, store))
	}
	n093011Sweep(t, svc)
	assertSweepOnlyEnqueued(t, f, store, "sub_B")
	if job, ok, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_C"); !ok || job.CanonicalSubscriptionID != "sub_B" {
		t.Fatalf("second delayed subscription must be discovered: ok=%t job=%+v", ok, job)
	}
}

// Fence: the binding changes between the list and the write -> nothing written.
// Missing or truncated evidence -> nothing. An existing row owned by another
// identity -> nothing written, diagnostic logged.
func TestN0930_11NothingWrittenOnMovedOrUnknownEvidence(t *testing.T) {
	for _, tc := range []string{"binding_changed", "list_error", "truncated_list", "ownership_conflict"} {
		t.Run(tc, func(t *testing.T) {
			f, store, svc, ts := newN09302(t)
			f.set("sub_B", "active", 200)
			n09302AdoptA(t, f, ts, svc, store)
			binding := "sub_A"
			wantRows := 0
			f.mu.Lock()
			switch tc {
			case "binding_changed":
				binding = "sub_X"
				f.onList = func() {
					if _, err := store.db.Exec(`UPDATE users SET stripe_subscription_id='sub_X' WHERE id=?`, n09302User); err != nil {
						t.Errorf("rebind: %v", err)
					}
				}
			case "list_error":
				f.failList = true
			case "truncated_list":
				f.truncate = true
			case "ownership_conflict":
				wantRows = 1
			}
			f.mu.Unlock()
			if tc == "ownership_conflict" {
				if _, err := store.PutDuplicateRefund(context.Background(), DuplicateRefundPlan{UserID: "user_x", CustomerID: "cus_x", CanonicalSubscriptionID: "sub_x", DuplicateSubscriptionID: "sub_B"}, true, 50); err != nil {
					t.Fatal(err)
				}
			}
			out := n093011Sweep(t, svc)
			assertSweepOnlyEnqueued(t, f, store, binding)
			if n093011Rows(t, store) != wantRows {
				t.Fatalf("rows=%d want %d log:\n%s", n093011Rows(t, store), wantRows, out)
			}
			if tc == "ownership_conflict" {
				if other, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B"); other.UserID != "user_x" || other.CancelHold != "" || !strings.Contains(out, duplicateResponsibilityOwnershipLog) {
					t.Fatalf("other identity's row touched or no diagnostic: %+v\n%s", other, out)
				}
			}
		})
	}
}

// Budget and rotation: at most duplicateDiscoveryBatch list calls per sweep; a
// durable cursor reaches every account, then wraps.
func TestN0930_11SweepBudgetAndRotation(t *testing.T) {
	f, store, svc, _ := newN09302(t)
	for i := 0; i < 150; i++ {
		if _, err := store.db.Exec(`INSERT INTO users(id,email,display_name,created_at,stripe_customer_id) VALUES(?,?,'',1,?)`, fmt.Sprintf("bulk_%03d", i), fmt.Sprintf("bulk_%03d@example.com", i), fmt.Sprintf("cus_bulk_%03d", i)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.Exec(`INSERT INTO users(id,email,display_name,created_at,stripe_customer_id,deleted_at) VALUES('gone','gone@example.com','',1,'cus_gone',5)`); err != nil {
		t.Fatal(err)
	}
	lists := func() int {
		f.mu.Lock()
		defer f.mu.Unlock()
		n := f.lists
		f.lists = 0
		return n
	}
	n093011Sweep(t, svc)
	first := lists()
	n093011Sweep(t, svc)
	second := lists()
	n093011Sweep(t, svc)
	third := lists()
	if first != duplicateDiscoveryBatch || second != 151-duplicateDiscoveryBatch || third != duplicateDiscoveryBatch {
		t.Fatalf("list calls per sweep: %d, %d, %d (want %d, %d, %d; deleted accounts excluded)", first, second, third, duplicateDiscoveryBatch, 151-duplicateDiscoveryBatch, duplicateDiscoveryBatch)
	}
}

// The live-source fence: on an unbound account the source row that named the
// canonical ends between the list and the write -> nothing written.
func TestN0930_11UnboundLiveSourceFence(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	if _, err := store.db.Exec(`INSERT INTO billing_authorities(user_id,provider,external_scope,apple_environment,apple_account_token,epoch,intent_id,created_at,updated_at) VALUES(?,'stripe','','','',1,'intent_legacy',1,1)`, n09302User); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE users SET plan_source='admin',plan_id='max' WHERE id=?`, n09302User); err != nil {
		t.Fatal(err)
	}
	f.set("sub_A", "active", 100)
	n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_A", 300)
	f.set("sub_B", "active", 200)
	f.mu.Lock()
	f.onList = func() {
		if _, err := store.db.Exec(`UPDATE subscription_sources SET status='canceled',plan_id='free' WHERE user_id=?`, n09302User); err != nil {
			t.Errorf("end source: %v", err)
		}
	}
	f.mu.Unlock()
	n093011Sweep(t, svc)
	assertSweepOnlyEnqueued(t, f, store, "")
	if n093011Rows(t, store) != 0 {
		t.Fatalf("a source that ended during the list must leave nothing written: rows=%d", n093011Rows(t, store))
	}
}

// Codex N-0930-11 MEDIUM: an account with a pending account_deletion saga is
// deleting even after ClearAccountDeletion reset deleted_at. It is not a
// discovery candidate, and a saga appearing while the sweep lists blocks the
// write. Also: the "recorded" line appears only when something changed.
func TestN0930_11PendingDeletionSagaExcludesDiscovery(t *testing.T) {
	saga := `INSERT INTO billing_cancellation_outbox(id,billing_subject_id,provider,idempotency_key,state,created_at,updated_at,mode) VALUES('bco_m','user_m','stripe','idem_m','pending',1,1,'account_deletion')`
	t.Run("reactivated_with_pending_saga", func(t *testing.T) {
		f, store, svc, ts := newN09302(t)
		f.set("sub_B", "active", 200)
		n09302AdoptA(t, f, ts, svc, store)
		if _, err := store.db.Exec(saga); err != nil {
			t.Fatal(err)
		}
		f.mu.Lock()
		f.lists = 0
		f.mu.Unlock()
		n093011Sweep(t, svc)
		f.mu.Lock()
		lists := f.lists
		f.mu.Unlock()
		if n093011Rows(t, store) != 0 || lists != 0 {
			t.Fatalf("a deleting account must not be a candidate: rows=%d lists=%d", n093011Rows(t, store), lists)
		}
	})
	t.Run("saga_appears_during_listing", func(t *testing.T) {
		f, store, svc, ts := newN09302(t)
		f.set("sub_B", "active", 200)
		n09302AdoptA(t, f, ts, svc, store)
		f.mu.Lock()
		f.onList = func() {
			if _, err := store.db.Exec(saga); err != nil {
				t.Errorf("saga: %v", err)
			}
		}
		f.mu.Unlock()
		n093011Sweep(t, svc)
		assertSweepOnlyEnqueued(t, f, store, "sub_A")
		if n093011Rows(t, store) != 0 {
			t.Fatalf("a saga committed during the list must block the write: rows=%d", n093011Rows(t, store))
		}
	})
	t.Run("recorded_line_only_on_change", func(t *testing.T) {
		f, store, svc, ts := newN09302(t)
		f.set("sub_B", "active", 200)
		n09302AdoptA(t, f, ts, svc, store)
		first := n093011Sweep(t, svc)
		second := n093011Sweep(t, svc)
		if !strings.Contains(first, "duplicate discovery recorded 1") || strings.Contains(second, "duplicate discovery recorded") {
			t.Fatalf("first:\n%s\nsecond:\n%s", first, second)
		}
	})
}
