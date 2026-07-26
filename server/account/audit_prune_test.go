package account

import (
	"context"
	"io"
	"log"
	"strings"
	"sync/atomic"
	"testing"
)

// seedAudit inserts one HUMAN audit row at time `at` (auth "password", the
// same as WriteAudit records for a logged-in admin).
func seedAudit(t *testing.T, s *SQLiteStore, at int64, actor, action string) {
	t.Helper()
	seedAuditAuth(t, s, at, actor, action, "password")
}

// seedNodeAudit inserts one MACHINE row exactly as writeNodeAudit would: actor
// "node:<id>" AND auth nodeAuditAuth. The auth column is what PruneNodeAudit
// discriminates on (it is set by writeNodeAudit alone and is not
// operator-influenced, unlike an actor string), so a fixture that sets only the
// actor would test a rule the production writer never produces.
func seedNodeAudit(t *testing.T, s *SQLiteStore, at int64, nodeID, action string) {
	t.Helper()
	seedAuditAuth(t, s, at, nodeAuditActor(nodeID), action, nodeAuditAuth)
}

func seedAuditAuth(t *testing.T, s *SQLiteStore, at int64, actor, action, auth string) {
	t.Helper()
	if err := s.InsertAudit(context.Background(), AuditEntry{
		At: at, Actor: actor, IP: "1.2.3.4", Auth: auth,
		Action: action, Target: "-", Changes: "", StepUp: "",
	}); err != nil {
		t.Fatal(err)
	}
}

// auditIDs returns every audit row's action, newest first.
func auditActionsAt(t *testing.T, s *SQLiteStore) []int64 {
	t.Helper()
	rows, err := s.ListAudit(context.Background(), 1000, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	out := make([]int64, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.At)
	}
	return out
}

// admin_audit grew forever. It now prunes by age like upload_events and
// download_receipts — and nothing inside the retention window may be touched,
// because that is the evidence the table exists to preserve.
func TestPruneAuditDropsOldKeepsNewAndIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedAudit(t, s, 100, "boss", AuditLoginOK)
	seedAudit(t, s, 500, "boss", AuditSettings)
	seedAudit(t, s, 900, "boss", AuditLogout)

	if err := s.PruneAudit(ctx, 500); err != nil {
		t.Fatal(err)
	}
	got := auditActionsAt(t, s)
	if len(got) != 2 || got[0] != 900 || got[1] != 500 {
		t.Fatalf("after prune rows at %v, want [900 500] (strictly older than the cutoff goes)", got)
	}
	// Idempotent: running it again changes nothing and does not error.
	if err := s.PruneAudit(ctx, 500); err != nil {
		t.Fatal(err)
	}
	if got2 := auditActionsAt(t, s); len(got2) != 2 {
		t.Fatalf("second prune removed more rows: %v", got2)
	}
	// A prune on an empty table is fine too.
	if err := s.PruneAudit(ctx, 0); err != nil {
		t.Fatal(err)
	}
}

// Age alone does not bound a BURST: a node-token holder looping
// register→deregister writes one machine-actor row per iteration, and
// /api/nodes/register has no rate limit. The row ceiling covers ONLY
// machine-written rows; admin rows must never be evicted by it.
func TestPruneNodeAuditCapsMachineRowsAndSparesAdminRows(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	for i := 0; i < 10; i++ {
		seedNodeAudit(t, s, int64(100+i), "n", AuditNodeDeregister)
	}
	seedAudit(t, s, 1, "boss", AuditLoginOK) // oldest row on the table, but human
	// An admin username can be anything, including something that looks like a
	// machine actor. Discriminating on the actor string would let an operator
	// (or an attacker who set the username) aim the eviction at human rows;
	// discriminating on auth cannot be steered that way. This row must survive.
	seedAudit(t, s, 2, nodeAuditActor("impostor"), AuditLoginOK)

	if err := s.PruneNodeAudit(ctx, 4); err != nil {
		t.Fatal(err)
	}
	rows, err := s.ListAudit(ctx, 1000, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	node, admin := 0, 0
	for _, r := range rows {
		if r.Auth == nodeAuditAuth {
			node++
			if r.At < 106 {
				t.Fatalf("cap kept an older machine row (at=%d); it must keep the NEWEST 4", r.At)
			}
		} else {
			admin++
		}
	}
	if node != 4 {
		t.Fatalf("machine rows after cap = %d, want 4", node)
	}
	if admin != 2 {
		t.Fatalf("admin rows after cap = %d, want 2 (the cap must never evict them, "+
			"including one whose actor merely looks like a node)", admin)
	}
	// Idempotent.
	if err := s.PruneNodeAudit(ctx, 4); err != nil {
		t.Fatal(err)
	}
	if rows, _ := s.ListAudit(ctx, 1000, 0, ""); len(rows) != 6 {
		t.Fatalf("second cap pass changed the table: %d rows", len(rows))
	}
}

// The cap runs every 10 minutes forever, so the case that matters most is the
// one where there is NOTHING to do: it must not full-scan admin_audit to
// discover that. The pre-check is a count over idx_admin_audit_machine, and
// the delete only runs when the cap is actually exceeded.
//
// A row-count assertion alone does NOT prove the pre-check ran: deleting the
// pre-check entirely still leaves an under-cap sweep a no-op, because the
// boundary query's `OFFSET keep-1` also finds no row on a table shorter than
// keep and returns nil the same way (see pruneNodeAuditBoundaryRuns). So this
// test asserts, via that counter, that the boundary query did NOT execute —
// the only thing that actually distinguishes "the pre-check short-circuited"
// from "there was nothing to do either way". Deliberately breaking this test
// by deleting the pre-check block: the boundary query then always runs, the
// counter advances, and this test fails (verified by hand while writing it).
func TestPruneNodeAuditNoOpIsIndexed(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		seedNodeAudit(t, s, int64(100+i), "n", AuditNodeDeregister)
	}
	before := atomic.LoadInt64(&pruneNodeAuditBoundaryRuns)
	// Under the cap: nothing may be deleted.
	if err := s.PruneNodeAudit(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if rows, _ := s.ListAudit(ctx, 100, 0, ""); len(rows) != 5 {
		t.Fatalf("under-cap sweep deleted rows: %d left, want 5", len(rows))
	}
	if after := atomic.LoadInt64(&pruneNodeAuditBoundaryRuns); after != before {
		t.Fatalf("pre-check did not short-circuit: boundary-row query ran on an "+
			"under-cap sweep (count %d -> %d)", before, after)
	}
	// And the pre-check must be answered from the index, not a table scan.
	// EXPLAIN QUERY PLAN on pruneNodeAuditPrecheckQuery itself — the literal
	// PruneNodeAudit issues, not a copy of it — so this can't drift from what
	// the pre-check actually runs.
	var detail string
	if err := s.db.QueryRowContext(ctx,
		`EXPLAIN QUERY PLAN `+pruneNodeAuditPrecheckQuery,
		nodeAuditAuth).Scan(new(int), new(int), new(int), &detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "idx_admin_audit_machine") || strings.HasPrefix(detail, "SCAN admin_audit ") {
		t.Fatalf("machine-row pre-check is not index-driven: %s", detail)
	}
}

// The prune must actually be wired into the GC loop, next to
// PruneUploadEvents / PruneDownloadReceipts.
func TestGCSweepPrunesAudit(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := int64(3_000_000_000)
	seedAudit(t, s, now-auditRetentionDefault-1, "boss", AuditLoginOK) // just outside
	seedAudit(t, s, now-auditRetentionDefault+1, "boss", AuditLogout)  // just inside

	g := &GC{Store: s, Now: func() int64 { return now }, Log: log.New(io.Discard, "", 0)}
	g.sweep(ctx)

	got := auditActionsAt(t, s)
	if len(got) != 1 || got[0] != now-auditRetentionDefault+1 {
		t.Fatalf("GC left rows at %v, want only the one inside the retention window", got)
	}
}

// The retention is configurable; GC must honour the configured window rather
// than the default when one is set.
func TestGCSweepHonoursConfiguredAuditRetention(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := int64(1_000_000)
	seedAudit(t, s, now-200, "boss", AuditLoginOK)
	seedAudit(t, s, now-50, "boss", AuditLogout)

	g := &GC{Store: s, Now: func() int64 { return now }, Log: log.New(io.Discard, "", 0),
		AuditRetention: 100}
	g.sweep(ctx)

	got := auditActionsAt(t, s)
	if len(got) != 1 || got[0] != now-50 {
		t.Fatalf("configured 100s retention left %v, want only the row 50s old", got)
	}
}
