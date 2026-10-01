package main

// N-0930-8 (A-M8 follow-up): the node binary's acknowledgement path against the
// REAL central when a user's relay attribution goes over the per-(node, user)
// budget. Central defers the bytes the bucket cannot take (owed) but still
// answers ok, so this node must acknowledge and retire every final it sent —
// one user over budget must never make the node hold its finals — a re-sent
// report must add nothing, and the owed bytes must reach the ledger later, by
// central's clock alone, with nothing re-sent.
//
// Same real pieces as heartbeat_ledger_test.go (this node's reporter, registry
// and sendHeartbeat; account.Service's heartbeat handler over SQLite), plus a
// controllable central clock so the bucket can drain.

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
)

// budgetCapacity mirrors central's A-M8 bucket (relayAttribAllocs = 8 allocs x
// maxRelayBytesPerSec = 25 MiB/s, held for relayAttribWindowSecs = 3600 s).
// Kept here as a literal because those constants are unexported in account; if
// central's policy changes, this test's exact figures fail loudly rather than
// silently passing.
const budgetCapacity = int64(8) * (25 << 20) * 3600

// newBudgetCentral is newLedgerCentral with central's clock under the test's
// control. It returns the same *ledgerCentral, so ledger, registeredNode and
// username apply unchanged.
func newBudgetCentral(t *testing.T) (*ledgerCentral, func(time.Time)) {
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
	var mu sync.Mutex
	clock := time.Now()
	svc.SetNow(func() time.Time { mu.Lock(); defer mu.Unlock(); return clock })
	setClock := func(at time.Time) { mu.Lock(); clock = at; mu.Unlock() }
	if err := svc.SeedPlans(ctx); err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertUserByEmail(ctx, "n0930-8@example.com", "n0930-8@example.com")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	svc.RegisterNodeRoutes(mux)
	lc := &ledgerCentral{store: store, userID: user.ID}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/nodes/heartbeat" || lc.mode.Load() != hbLoseResponse {
			mux.ServeHTTP(w, r)
			return
		}
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
	}))
	t.Cleanup(srv.Close)
	lc.url = srv.URL
	return lc, setClock
}

func TestOverBudgetFloodIsAcknowledgedAndOwedBytesDrainLater(t *testing.T) {
	// 300 allocations of 3 GiB each: every one fits central's first-report
	// clamp (~3.18 GiB), so central accepts each final in full; together they
	// are over one bucket and under two, so central records one bucket now and
	// owes the rest — nothing is dropped.
	const (
		allocs   = 300
		perAlloc = int64(3) << 30
		chunk    = 64 << 20
	)
	claimed := int64(allocs) * perAlloc
	if claimed <= budgetCapacity || claimed >= 2*budgetCapacity {
		t.Fatalf("setup: %d claimed bytes must lie between one and two buckets (%d)", claimed, budgetCapacity)
	}
	var logs strings.Builder
	var logMu sync.Mutex
	prev := log.Writer()
	log.SetOutput(writerFunc(func(p []byte) (int, error) { logMu.Lock(); defer logMu.Unlock(); return logs.Write(p) }))
	t.Cleanup(func() { log.SetOutput(prev) })

	lc, setClock := newBudgetCentral(t)
	start := time.Now()
	setClock(start)
	rp, nodeID := lc.registeredNode(t)
	stateDir := t.TempDir()
	reg := newAllocRegistry(nil)
	heartbeat := func() { sendHeartbeat(rp, nodeID, reg, "", stateDir, nil, nil, nil) }

	buf := make([]byte, chunk)
	for i := 0; i < allocs; i++ {
		relay := &net.UDPAddr{IP: net.IPv4(10, 0, 3, byte(1+i/250)), Port: 20000 + i}
		c := reg.wrap(fakePC{}, relay)
		reg.created(relay, lc.username(i))
		for sent := int64(0); sent < perAlloc; sent += chunk {
			c.WriteTo(buf, &net.UDPAddr{})
		}
		mustClose(t, c)
	}

	// One heartbeat carrying a batch is processed by central but its answer is
	// lost: nothing is acknowledged, so that batch is sent again next time.
	lc.mode.Store(hbLoseResponse)
	heartbeat()
	if e, _ := indexSizes(reg); e != allocs {
		t.Fatalf("a heartbeat whose answer was lost retired %d entries", allocs-e)
	}
	lc.mode.Store(hbForward)

	// Healthy heartbeats: ceil(300/64) = 5 batches, re-send of the lost one
	// included. Every one must answer ok and retire what it carried.
	for i := 0; i < 5; i++ {
		before, _ := indexSizes(reg)
		heartbeat()
		after, _ := indexSizes(reg)
		if want := max(before-64, 0); after != want {
			t.Fatalf("heartbeat %d: %d entries left, want %d — an over-budget heartbeat was not acknowledged", i, after, want)
		}
	}
	if e, _ := indexSizes(reg); e != 0 {
		t.Fatalf("%d registry entries left: over-budget finals were held on the node", e)
	}
	logMu.Lock()
	notOK := strings.Contains(logs.String(), "did not report ok")
	logMu.Unlock()
	if notOK {
		t.Fatalf("a heartbeat answered without ok:\n%s", logs.String())
	}

	// Central recorded exactly one bucket now (the lost-then-resent batch
	// counted once), and owes the rest.
	total, month := lc.ledger(t)
	if total != budgetCapacity || month != budgetCapacity {
		t.Fatalf("after the flood: total=%d billable=%d, want one bucket %d", total, month, budgetCapacity)
	}
	heartbeat() // nothing left to send; adds nothing
	if total, _ := lc.ledger(t); total != budgetCapacity {
		t.Fatalf("an empty heartbeat at the same instant changed the ledger to %d", total)
	}

	// An hour later on central's clock, with nothing re-sent by the node, the
	// bucket has drained and central's upkeep records the owed bytes.
	setClock(start.Add(time.Hour + time.Second))
	heartbeat()
	total, month = lc.ledger(t)
	if total != claimed || month != claimed {
		t.Fatalf("after the bucket drained: total=%d billable=%d, want every claimed byte %d recorded exactly once", total, month, claimed)
	}
	setClock(start.Add(3 * time.Hour))
	heartbeat()
	if total, _ := lc.ledger(t); total != claimed {
		t.Fatalf("later upkeep changed the ledger to %d, want %d", total, claimed)
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }
