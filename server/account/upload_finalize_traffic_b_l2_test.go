package account

// B-L2 (audit 2026-09-28): the authoritative finalize traffic gate must fail
// CLOSED when the month-to-date traffic read fails, the way the daily-quota
// read right after it does. The failure is injected into exactly one nested
// read (UserRelayedSince, reached by overTraffic → remainingTraffic →
// currentMonthTraffic) and only for the finalize request; everything else goes
// to the real file-backed store of the A33 quota harness.

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"
)

// trafficReadFailStore fails UserRelayedSince while armed and counts every
// call, armed or not, so a test can prove the gate really consulted it.
type trafficReadFailStore struct {
	Store
	armed atomic.Bool
	calls atomic.Int64
}

var errB_L2TrafficRead = errors.New("injected month-to-date traffic read failure")

func (f *trafficReadFailStore) UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error) {
	f.calls.Add(1)
	if f.armed.Load() {
		return 0, errB_L2TrafficRead
	}
	return f.Store.UserRelayedSince(ctx, userID, since)
}

func newB_L2Harness(t *testing.T) (*quotaHarness, *trafficReadFailStore) {
	t.Helper()
	h := newQuotaHarness(t, quotaOpts{})
	// Wrap the harness's own hook store, so its ledger and refusal records keep
	// working. Installed between requests, as the other store-swap tests do.
	f := &trafficReadFailStore{Store: h.hook}
	h.svc.store = f
	return h, f
}

func TestB_L2FinalizeTrafficReadFailureFailsClosed(t *testing.T) {
	h, f := newB_L2Harness(t)
	const n = 900
	id := h.landSession(n)
	before := h.ledger()
	if before.Files != 0 || before.Events != 0 || before.Meter != n || before.CentralBlobs != 1 {
		t.Fatalf("before finalize: %+v, want no object, no debit, %d bytes metered, one blob", before, n)
	}

	f.calls.Store(0)
	f.armed.Store(true)
	code, _ := h.do("POST", "/api/uploads/"+id+"/finalize", nil)
	f.armed.Store(false)

	if f.calls.Load() == 0 {
		t.Fatal("finalize never read month-to-date traffic: the injected failure proved nothing")
	}
	l := h.ledger()
	t.Logf("after the refusal: %+v", l)
	if l.Files != 0 {
		t.Fatalf("a stored object was created (%d) although the traffic gate could not be read (answered %d)", l.Files, code)
	}
	if code != http.StatusInternalServerError {
		t.Fatalf("finalize with an unreadable traffic allowance answered %d, want 500", code)
	}
	if l.Events != 0 || l.EventBytes != 0 {
		t.Fatalf("daily-quota debit written for a refused finalize: %d event(s), %d bytes", l.Events, l.EventBytes)
	}
	if l.CentralBlobs != 0 {
		t.Fatalf("the refused upload's blob was kept: %d blob(s)", l.CentralBlobs)
	}
	if l.DoneSessions != 1 {
		t.Fatalf("tombstones %d, want 1 (the refusal keeps the claimed session row)", l.DoneSessions)
	}
	// The bytes moved: they stay metered exactly as for the over-limit refusal,
	// neither refunded nor metered a second time.
	if l.Meter != n {
		t.Fatalf("meter %d after the refusal, want %d (unchanged)", l.Meter, n)
	}
	if r := h.hook.refusals(); len(r) != 0 {
		t.Fatalf("the capped insert was reached (refusals %v): the gate did not stop the finalize", r)
	}
	if errs := h.hook.persistErrors(); len(errs) != 0 {
		t.Fatalf("the capped insert was reached (errors %v)", errs)
	}

	// A retry after the read recovers must not store the object either: the
	// session is terminal, exactly as after any other finalize refusal.
	if rc, _ := h.do("POST", "/api/uploads/"+id+"/finalize", nil); rc != http.StatusConflict {
		t.Fatalf("a retried finalize answered %d, want 409", rc)
	}
	if l2 := h.ledger(); l2 != l {
		t.Fatalf("the retried finalize changed the ledger: %+v -> %+v", l, l2)
	}
	h.assertOneDebitPerObject("after the fail-closed refusal")
	h.assertNoLegacyLedgerCalls()
}

// Positive control: the same wrapper, unarmed, lets an ordinary finalize
// through — it reads the traffic allowance, stores one object and writes one
// debit. Without this the test above could pass against a harness in which
// finalize is broken for some unrelated reason.
func TestB_L2FinalizeTrafficReadHealthyStillStores(t *testing.T) {
	h, f := newB_L2Harness(t)
	const n = 900
	id := h.landSession(n)
	f.calls.Store(0)
	code, m := h.do("POST", "/api/uploads/"+id+"/finalize", nil)
	if code != http.StatusOK {
		t.Fatalf("healthy finalize answered %d %v, want 200", code, m)
	}
	if f.calls.Load() == 0 {
		t.Fatal("finalize never read month-to-date traffic: the plan is not traffic-capped in this harness")
	}
	l := h.assertOneDebitPerObject("after a healthy finalize")
	if l.Files != 1 || l.Meter != n {
		t.Fatalf("ledger %+v, want one object and %d metered bytes", l, n)
	}
	h.assertNoLegacyLedgerCalls()
}
