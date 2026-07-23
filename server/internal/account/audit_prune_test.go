package account

import (
	"context"
	"io"
	"log"
	"testing"
)

// seedAudit inserts one audit row at time `at` with the given actor/action.
func seedAudit(t *testing.T, s *SQLiteStore, at int64, actor, action string) {
	t.Helper()
	if err := s.InsertAudit(context.Background(), AuditEntry{
		At: at, Actor: actor, IP: "1.2.3.4", Auth: "password",
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
		seedAudit(t, s, int64(100+i), nodeAuditActor("n"), AuditNodeDeregister)
	}
	seedAudit(t, s, 1, "boss", AuditLoginOK) // oldest row on the table, but human

	if err := s.PruneNodeAudit(ctx, 4); err != nil {
		t.Fatal(err)
	}
	rows, err := s.ListAudit(ctx, 1000, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	node, admin := 0, 0
	for _, r := range rows {
		if r.Actor == nodeAuditActor("n") {
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
	if admin != 1 {
		t.Fatalf("admin rows after cap = %d, want 1 (the cap must never evict them)", admin)
	}
	// Idempotent.
	if err := s.PruneNodeAudit(ctx, 4); err != nil {
		t.Fatal(err)
	}
	if rows, _ := s.ListAudit(ctx, 1000, 0, ""); len(rows) != 5 {
		t.Fatalf("second cap pass changed the table: %d rows", len(rows))
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
