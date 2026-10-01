package account

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
)

// N-0930-2: admin-comp deletion canonical identity, and Stripe event ordering
// across different subscriptions of one account. Driven through the real
// webhook handler with canonical refresh ON (production configuration).

const (
	n09302User     = "user_m"
	n09302Customer = "cus_m"
)

type n09302Sub struct {
	status  string
	created int64
}

type n09302Stripe struct {
	mu      sync.Mutex
	subs    map[string]*n09302Sub
	deletes map[string]int
	failInv bool // invoice lists fail (keeps a duplicate un-inspected)
}

func (f *n09302Stripe) set(id, status string, created int64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subs[id] = &n09302Sub{status: status, created: created}
}

func (f *n09302Stripe) subJSON(id string, s *n09302Sub) string {
	return fmt.Sprintf(`{"id":%q,"object":"subscription","customer":%q,"status":%q,"created":%d,"current_period_end":9999999999,"metadata":{},"items":{"data":[{"price":{"id":"price_pro_m"},"current_period_end":9999999999}]}}`, id, n09302Customer, s.status, s.created)
}

func newN09302(t *testing.T) (*n09302Stripe, *SQLiteStore, *Service, *httptest.Server) {
	t.Helper()
	f := &n09302Stripe{subs: map[string]*n09302Sub{}, deletes: map[string]int{}}
	stripeSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/subscriptions":
			ids := make([]string, 0, len(f.subs))
			for id := range f.subs {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			var items []string
			for _, id := range ids {
				items = append(items, f.subJSON(id, f.subs[id]))
			}
			fmt.Fprintf(w, `{"object":"list","data":[%s],"has_more":false}`, strings.Join(items, ","))
		case strings.HasPrefix(r.URL.Path, "/v1/subscriptions/"):
			id := strings.TrimPrefix(r.URL.Path, "/v1/subscriptions/")
			s, ok := f.subs[id]
			if !ok {
				http.Error(w, `{"error":{"message":"No such subscription"}}`, http.StatusNotFound)
				return
			}
			if r.Method == http.MethodDelete {
				f.deletes[id]++
				s.status = "canceled"
			}
			io.WriteString(w, f.subJSON(id, s))
		case r.Method == http.MethodGet && r.URL.Path == "/v1/invoices":
			if f.failInv {
				http.Error(w, `{"error":{"message":"invoices unavailable"}}`, http.StatusInternalServerError)
				return
			}
			io.WriteString(w, `{"data":[],"has_more":false}`)
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusBadRequest)
		}
	}))
	t.Cleanup(stripeSrv.Close)
	client := NewStripeClient("sk_test", "whsec", "")
	client.base, client.http = stripeSrv.URL, stripeSrv.Client()
	if !client.canonicalWebhookRefresh {
		t.Fatal("production default: canonical refresh must be on")
	}
	store := newTestStore(t)
	mustPlan(t, store, Plan{ID: "pro", Name: "Pro", Active: true, StripePriceMonthlyID: "price_pro_m"})
	if _, err := store.db.Exec(`INSERT INTO users(id,email,display_name,created_at,stripe_customer_id) VALUES(?,?,'',1,?)`, n09302User, n09302User+"@example.com", n09302Customer); err != nil {
		t.Fatal(err)
	}
	svc := NewService(store, nil, Config{})
	svc.biller = client
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	return f, store, svc, ts
}

func n09302Deliver(t *testing.T, ts *httptest.Server, svc *Service, eventType, sub string, created int64) int {
	t.Helper()
	status := "active"
	if eventType == "customer.subscription.deleted" {
		status = "canceled"
	}
	body := fmt.Sprintf(`{"id":"evt_%s_%s_%d","type":%q,"created":%d,"data":{"object":{"id":%q,"object":"subscription","customer":%q,"status":%q,"current_period_end":9999999999,"metadata":null,"items":{"data":[{"price":{"id":"price_pro_m"}}]}}}}`,
		strings.TrimPrefix(eventType, "customer.subscription."), sub, created, eventType, created, sub, n09302Customer, status)
	return n0930Deliver(t, ts, svc, body)
}

func n09302User_(t *testing.T, store *SQLiteStore) (User, SubscriptionSource) {
	t.Helper()
	u, err := store.GetUserByID(context.Background(), n09302User)
	if err != nil {
		t.Fatal(err)
	}
	row, _, err := store.GetSubscriptionSource(context.Background(), n09302User, ProviderStripe)
	if err != nil {
		t.Fatal(err)
	}
	return u, row
}

// adopt A as the account's first subscription (created 100).
func n09302AdoptA(t *testing.T, f *n09302Stripe, ts *httptest.Server, svc *Service, store *SQLiteStore) {
	t.Helper()
	f.set("sub_A", "active", 100)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_A", 100); st != http.StatusOK {
		t.Fatalf("adopt A status=%d", st)
	}
	if u, row := n09302User_(t, store); u.StripeSubscriptionID != "sub_A" || u.PlanID != "pro" || row.ExternalID != "sub_A" || row.Status != "active" {
		t.Fatalf("setup: user=%+v row=%+v", u, row)
	}
}

// Outcome 2, case 1 (a genuine event dropped): A (canonical) is deleted at
// t=300 and that is delivered first; B, a live subscription created at t=200,
// is delivered afterwards. B's event is about a DIFFERENT subscription and its
// evidence is Stripe's current object (canonical refresh), yet the per-account
// clock dropped it as stale: the customer paid for B with no plan and no
// responsibility, and the sweep skips accounts with a live subscription.
func TestN0930_2LiveSubscriptionEventNotDroppedByAnotherSubscriptionsClock(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	f.set("sub_A", "canceled", 100)
	f.set("sub_B", "active", 200)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.deleted", "sub_A", 300); st != http.StatusOK {
		t.Fatalf("A deleted status=%d", st)
	}
	if u, _ := n09302User_(t, store); u.StripeSubscriptionID != "" || u.PlanID != "free" {
		t.Fatalf("after A deleted: %+v", u)
	}
	if st := n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_B", 200); st != http.StatusOK {
		t.Fatalf("B created status=%d", st)
	}
	u, row := n09302User_(t, store)
	if u.StripeSubscriptionID != "sub_B" || u.PlanID != "pro" || row.ExternalID != "sub_B" || row.Status != "active" || row.EventAt < 300 {
		t.Fatalf("live B must be adopted despite A's newer clock: user=%+v row=%+v", u, row)
	}
}

// Outcome 2, case 2 -- documented, NOT changed: A is canonical and renewed at
// t=300; B's creation (t=200) is delivered late. Applying it would re-bind or
// reap on an event older than the account's clock, which B-M3 forbids
// (TestBM3RetryStopsBeforeDedupWhenEventBecameStale). The event is therefore
// still dropped and B is not discovered by this delivery: that duplicate stays
// charging until a later B event or the sweep's discovery (N-0930-11). This
// test pins the current behaviour so a change to it is a deliberate decision.
func TestN0930_2DelayedDuplicateCreationOnBoundAccountKeepsBM3Rule(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.updated", "sub_A", 300); st != http.StatusOK {
		t.Fatalf("A renewal status=%d", st)
	}
	f.set("sub_B", "active", 200)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_B", 200); st != http.StatusOK {
		t.Fatalf("B created status=%d", st)
	}
	_, ok, err := store.DuplicateRefundBySubscription(context.Background(), "sub_B")
	u, row := n09302User_(t, store)
	f.mu.Lock()
	deletes := f.deletes["sub_B"] + f.deletes["sub_A"]
	f.mu.Unlock()
	if err != nil || ok || deletes != 0 || u.StripeSubscriptionID != "sub_A" || u.PlanID != "pro" || row.ExternalID != "sub_A" || row.EventAt != 300 {
		t.Fatalf("B-M3 replay rule changed: ok=%t err=%v deletes=%d user=%+v row=%+v", ok, err, deletes, u, row)
	}
}

// Outcome 2, safety: an old event for another subscription that is NOT live
// still cannot overwrite newer state, and a same-subscription stale event is
// still dropped (B-M3's replay guard is unchanged for both).
func TestN0930_2OlderEventsStillCannotOverwriteNewerState(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	f.set("sub_A", "canceled", 100)
	f.set("sub_B", "active", 200)
	n09302Deliver(t, ts, svc, "customer.subscription.deleted", "sub_A", 300)
	n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_B", 200)
	before, beforeRow := n09302User_(t, store)
	// Old A.updated (t=150): A is canceled now; not live -> the old clock rule.
	if st := n09302Deliver(t, ts, svc, "customer.subscription.updated", "sub_A", 150); st != http.StatusOK {
		t.Fatalf("old A status=%d", st)
	}
	// Old B.updated (t=120): same subscription as the row -> stale, dropped.
	f.set("sub_B", "past_due", 200)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.updated", "sub_B", 120); st != http.StatusOK {
		t.Fatalf("old B status=%d", st)
	}
	after, afterRow := n09302User_(t, store)
	if after.StripeSubscriptionID != before.StripeSubscriptionID || after.PlanID != "pro" || afterRow != beforeRow {
		t.Fatalf("older events overwrote newer state: before=%+v/%+v after=%+v/%+v", before, beforeRow, after, afterRow)
	}
}

// Outcome 1: on a legacy admin-comped account, deleting a DUPLICATE leaves the
// Stripe source row on the canonical's state; deleting the canonical records
// free/canceled under the comp; removing the comp falls back to real state.
func TestN0930_2AdminCompDuplicateDeletionKeepsCanonicalState(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	// Legacy comp on a Stripe account (SetUserPlanAdmin now refuses this).
	if _, err := store.db.Exec(`UPDATE users SET plan_source='admin',plan_id='max' WHERE id=?`, n09302User); err != nil {
		t.Fatal(err)
	}
	fallback := func() string {
		t.Helper()
		_, row := n09302User_(t, store)
		return resolveEffective("", row, []SubscriptionSource{row}, nil).PlanID
	}
	f.set("sub_B", "canceled", 200)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.deleted", "sub_B", 400); st != http.StatusOK {
		t.Fatalf("duplicate deletion status=%d", st)
	}
	u, row := n09302User_(t, store)
	if u.PlanID != "max" || u.PlanSource != "admin" || row.ExternalID != "sub_A" || row.Status != "active" || row.PlanID != "pro" || fallback() != "pro" {
		t.Fatalf("duplicate deletion replaced the canonical's state: user=%+v row=%+v fallback=%s", u, row, fallback())
	}
	f.set("sub_A", "canceled", 100)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.deleted", "sub_A", 500); st != http.StatusOK {
		t.Fatalf("canonical deletion status=%d", st)
	}
	u, row = n09302User_(t, store)
	if u.PlanID != "max" || u.PlanSource != "admin" || row.Status != "canceled" || row.PlanID != "free" || fallback() != "free" {
		t.Fatalf("canonical deletion under the comp: user=%+v row=%+v fallback=%s", u, row, fallback())
	}
}

// FINAL §10 cross-regression: N-0930-1 responsibilities and holds are not
// disturbed by comp transitions or out-of-order deleted/created events.
func TestN0930_2CrossRegressionResponsibilitiesSurviveOrderingAndComp(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	f.failInv = true // B's inline inspection fails: it stays an open responsibility
	f.set("sub_B", "active", 200)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.created", "sub_B", 200); st != http.StatusOK {
		t.Fatalf("B created status=%d", st)
	}
	open, ok, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B")
	if !ok || open.SubscriptionCanceled || open.DiscoveredAt != 0 {
		t.Fatalf("setup: %+v", open)
	}
	// A comp appears; the worker must hold, not cancel.
	if _, err := store.db.Exec(`UPDATE users SET plan_source='admin',plan_id='max' WHERE id=?`, n09302User); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.failInv = false
	f.mu.Unlock()
	svc.ReconcileDuplicateRefunds(context.Background())
	held, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B")
	if held.CancelHold != duplicateHoldAdminComp || held.SubscriptionCanceled {
		t.Fatalf("comp must hold the duplicate: %+v", held)
	}
	// Out-of-order events under the comp: an old B.updated and the duplicate's
	// own deletion. Neither touches the responsibility or its hold.
	n09302Deliver(t, ts, svc, "customer.subscription.updated", "sub_B", 150)
	f.set("sub_B", "canceled", 200)
	n09302Deliver(t, ts, svc, "customer.subscription.deleted", "sub_B", 600)
	after, _, _ := store.DuplicateRefundBySubscription(context.Background(), "sub_B")
	if after.CancelHold != duplicateHoldAdminComp || after.Revision != held.Revision || after.HoldEvidence != held.HoldEvidence {
		t.Fatalf("webhook events changed the responsibility: before=%+v after=%+v", held, after)
	}
	f.mu.Lock()
	deletes := f.deletes["sub_B"] + f.deletes["sub_A"]
	f.mu.Unlock()
	if u, row := n09302User_(t, store); deletes != 0 || u.PlanID != "max" || row.ExternalID != "sub_A" || row.Status != "active" {
		t.Fatalf("deletes=%d user=%+v row=%+v", deletes, u, row)
	}
}

// Outcome 1, created/updated counterpart: on a comped account a NEWER event for
// a duplicate subscription must not replace the canonical's identity or state
// on the underlying Stripe row either (the comp skips dedup, so before this the
// row simply followed whichever subscription spoke last).
func TestN0930_2AdminCompDuplicateUpdateKeepsCanonicalState(t *testing.T) {
	f, store, svc, ts := newN09302(t)
	n09302AdoptA(t, f, ts, svc, store)
	if _, err := store.db.Exec(`UPDATE users SET plan_source='admin',plan_id='max' WHERE id=?`, n09302User); err != nil {
		t.Fatal(err)
	}
	f.set("sub_B", "active", 200)
	if st := n09302Deliver(t, ts, svc, "customer.subscription.updated", "sub_B", 700); st != http.StatusOK {
		t.Fatalf("duplicate update status=%d", st)
	}
	u, row := n09302User_(t, store)
	if u.PlanID != "max" || row.ExternalID != "sub_A" || row.Status != "active" || u.StripeSubscriptionID != "sub_A" {
		t.Fatalf("duplicate update replaced the canonical: user=%+v row=%+v", u, row)
	}
	// The canonical's own update still applies under the comp.
	if st := n09302Deliver(t, ts, svc, "customer.subscription.updated", "sub_A", 800); st != http.StatusOK {
		t.Fatalf("canonical update status=%d", st)
	}
	if _, row := n09302User_(t, store); row.ExternalID != "sub_A" || row.EventAt != 800 {
		t.Fatalf("canonical update under the comp: %+v", row)
	}
}
