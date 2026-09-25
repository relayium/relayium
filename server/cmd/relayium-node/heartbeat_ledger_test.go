package main

// G34-N10 against the REAL central: account.Service's heartbeat handler over a
// real SQLite store, reached through this node's real reporter and
// sendHeartbeat. Only the transport is faulted, by a wrapper in front of the
// production routes. The ledger is read back through the store's own queries.
//
// Deliberately written against the node API that predates the fix (wrap,
// created, Close, sendHeartbeat) so the same file runs against the original
// source as a negative control; see node-author/REPORT.md.

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
)

// heartbeat fault modes, applied to /api/nodes/heartbeat only.
const (
	hbForward      = iota // pass through to central
	hbRefuse              // 503 without reaching central
	hbLoseResponse        // central processes it, the node never hears back
)

type ledgerCentral struct {
	store  *account.SQLiteStore
	userID string
	url    string
	mode   atomic.Int32
	mu     sync.Mutex
	calls  int
}

func newLedgerCentral(t *testing.T) *ledgerCentral {
	t.Helper()
	ctx := context.Background()
	store, err := account.OpenSQLite(filepath.Join(t.TempDir(), "central.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	svc := account.NewService(store, &account.LogMailer{Log: log.New(io.Discard, "", 0)}, account.Config{
		BaseURL: "http://127.0.0.1", NodeToken: "g34-n10-fleet-token",
	})
	if err := svc.SeedPlans(ctx); err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertUserByEmail(ctx, "g34-n10@example.com", "g34-n10@example.com")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	svc.RegisterNodeRoutes(mux)

	lc := &ledgerCentral{store: store, userID: user.ID}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/nodes/heartbeat" {
			mux.ServeHTTP(w, r)
			return
		}
		lc.mu.Lock()
		lc.calls++
		lc.mu.Unlock()
		switch lc.mode.Load() {
		case hbRefuse:
			http.Error(w, "central unavailable", http.StatusServiceUnavailable)
		case hbLoseResponse:
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, r)
			if rec.Code != http.StatusOK {
				panic(fmt.Sprintf("central answered %d: %s", rec.Code, rec.Body.String()))
			}
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				panic(err)
			}
			_ = conn.Close()
		default:
			mux.ServeHTTP(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	lc.url = srv.URL
	return lc
}

// ledger is what central has billed this user: the per-allocation high-water
// total, and the billable per-month sum the allowance reads.
func (lc *ledgerCentral) ledger(t *testing.T) (total, billableThisMonth int64) {
	t.Helper()
	ctx := context.Background()
	total, err := lc.store.UserUsageTotal(ctx, lc.userID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).Unix()
	billableThisMonth, err = lc.store.UserRelayedSince(ctx, lc.userID, monthStart)
	if err != nil {
		t.Fatal(err)
	}
	return total, billableThisMonth
}

// registeredNode registers a fleet node with central and returns what
// sendHeartbeat needs.
func (lc *ledgerCentral) registeredNode(t *testing.T) (*reporter, string) {
	t.Helper()
	rp := newReporter(lc.url, "g34-n10-fleet-token")
	rr, err := rp.register(registerBody{
		TURNSecret: "sek", URLs: []string{"turn:127.0.0.1:3478"}, Region: "test",
		Version: "test", Capabilities: []string{"relay"},
	})
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	return rp, rr.NodeID
}

func (lc *ledgerCentral) username(i int) string {
	return fmt.Sprintf("%d:%s.g34n10tag%d", time.Now().Add(time.Hour).Unix(), lc.userID, i)
}

// The original defect, end to end. An allocation relays, is reported live,
// relays more, and closes. The heartbeat carrying its final total then fails
// (refused, or processed with the answer lost), and a later heartbeat is
// healthy. Central must end up with exactly the final cumulative total: not the
// stale live figure (the bytes after it lost), and not more than the total (the
// re-sent final double counted).
func TestFinalUsageSurvivesFailedHeartbeatIntoRealLedger(t *testing.T) {
	for _, tc := range []struct {
		name string
		mode int32
	}{
		{"refused heartbeat then healthy retry", hbRefuse},
		{"response lost after central recorded it, then healthy retry", hbLoseResponse},
	} {
		t.Run(tc.name, func(t *testing.T) {
			lc := newLedgerCentral(t)
			rp, nodeID := lc.registeredNode(t)
			stateDir := t.TempDir()
			reg := newAllocRegistry(nil)
			relay := &net.UDPAddr{IP: net.IPv4(10, 0, 0, 1), Port: 50000}
			c := reg.wrap(fakePC{}, relay)
			reg.created(relay, lc.username(1))
			heartbeat := func() { sendHeartbeat(rp, nodeID, reg, "", stateDir, nil, nil, nil) }

			c.WriteTo(make([]byte, 1000), &net.UDPAddr{})
			heartbeat() // healthy: the live 1000 is recorded
			if total, _ := lc.ledger(t); total != 1000 {
				t.Fatalf("after the live heartbeat: ledger = %d, want 1000", total)
			}

			c.WriteTo(make([]byte, 500), &net.UDPAddr{})
			mustClose(t, c)

			lc.mode.Store(tc.mode)
			heartbeat() // carries the final 1500, and fails
			heartbeat() // and fails again
			lc.mode.Store(hbForward)
			heartbeat() // healthy retry
			heartbeat() // nothing left to send

			total, month := lc.ledger(t)
			if total != 1500 || month != 1500 {
				t.Fatalf("ledger after the failed final heartbeat and a healthy retry: total=%d billable-this-month=%d, "+
					"want 1500/1500 — the allocation's last 500 relayed bytes were never billed", total, month)
			}
			if e, _ := indexSizes(reg); e != 0 {
				t.Fatalf("%d registry entries left after the healthy retry", e)
			}
		})
	}
}

// An outage's backlog for ONE user, larger than central's 64-per-user
// heartbeat cap, drains into the ledger in full once central is back. Every
// allocation is billed its exact total, and none twice.
func TestSameUserBacklogDrainsIntoRealLedgerWithoutLoss(t *testing.T) {
	const n = 100
	lc := newLedgerCentral(t)
	rp, nodeID := lc.registeredNode(t)
	stateDir := t.TempDir()
	reg := newAllocRegistry(nil)
	heartbeat := func() { sendHeartbeat(rp, nodeID, reg, "", stateDir, nil, nil, nil) }

	var want int64
	lc.mode.Store(hbRefuse)
	for i := 0; i < n; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 1, 1), Port: 20000 + i}
		c := reg.wrap(fakePC{}, relay)
		reg.created(relay, lc.username(i))
		c.WriteTo(make([]byte, 1000+i), &net.UDPAddr{})
		want += int64(1000 + i)
		mustClose(t, c)
		if i%25 == 24 {
			heartbeat() // central is down throughout
		}
	}
	lc.mode.Store(hbForward)
	for i := 0; i < 5; i++ {
		heartbeat()
	}
	total, month := lc.ledger(t)
	if total != want || month != want {
		t.Fatalf("ledger after the backlog drained: total=%d billable-this-month=%d, want %d/%d", total, month, want, want)
	}
}

// No outage at all: more than 64 allocations for one user close within one
// heartbeat interval. Central records 64 per user per heartbeat and answers 200
// while skipping the rest, so a node that sends them all in one body, and treats
// that 200 as delivery, loses the remainder. The batch bound keeps every one.
func TestSameUserBurstOverCentralCapIsNotSilentlySkipped(t *testing.T) {
	const n = 100
	lc := newLedgerCentral(t)
	rp, nodeID := lc.registeredNode(t)
	stateDir := t.TempDir()
	reg := newAllocRegistry(nil)

	var want int64
	for i := 0; i < n; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 2, 1), Port: 20000 + i}
		c := reg.wrap(fakePC{}, relay)
		reg.created(relay, lc.username(i))
		c.WriteTo(make([]byte, 2000+i), &net.UDPAddr{})
		want += int64(2000 + i)
		mustClose(t, c)
	}
	for i := 0; i < 3; i++ {
		sendHeartbeat(rp, nodeID, reg, "", stateDir, nil, nil, nil)
	}
	total, month := lc.ledger(t)
	if total != want || month != want {
		t.Fatalf("ledger after %d same-user finals over healthy heartbeats: total=%d billable-this-month=%d, want %d/%d",
			n, total, month, want, want)
	}
}
