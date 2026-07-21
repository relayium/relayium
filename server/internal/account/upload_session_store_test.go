package account

import (
	"context"
	"fmt"
	"sync"
	"testing"
)

func mkUploadRow(id, user string) UploadSessionRow {
	return UploadSessionRow{
		ID: id, UserID: user, BlobKey: "blob-" + id, NodeID: "",
		Billable: true, EncManifest: []byte("m"), TTL: 3600, MaxDL: 0,
		MaxSize: 1 << 20, Received: 0, CreatedAt: 1000,
	}
}

// The session is durable, shared state: create it, read it back with all fields,
// advance the offset MONOTONICALLY (a stale/lower write is a no-op), and claim
// `done` exactly once.
func TestUploadSessionStoreLifecycle(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "up@example.com", "U")
	row := mkUploadRow("up1", u.ID)

	if ok, err := st.CreateUploadSession(ctx, row, maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("create: ok=%v err=%v", ok, err)
	}
	got, ok, err := st.GetUploadSession(ctx, "up1", u.ID)
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.BlobKey != "blob-up1" || !got.Billable || got.MaxSize != 1<<20 || string(got.EncManifest) != "m" {
		t.Fatalf("row did not round-trip: %+v", got)
	}
	// Ownership gate: another user can't see it.
	if _, ok, _ := st.GetUploadSession(ctx, "up1", "someone-else"); ok {
		t.Fatal("a session must not be visible to a non-owner")
	}

	// Monotonic advance.
	_ = st.AdvanceUploadReceived(ctx, "up1", 100, 2000)
	_ = st.AdvanceUploadReceived(ctx, "up1", 50, 2000) // stale — must not lower
	got, _, _ = st.GetUploadSession(ctx, "up1", u.ID)
	if got.Received != 100 {
		t.Fatalf("received: want 100 (monotonic), got %d", got.Received)
	}
	_ = st.AdvanceUploadReceived(ctx, "up1", 200, 2000)
	got, _, _ = st.GetUploadSession(ctx, "up1", u.ID)
	if got.Received != 200 {
		t.Fatalf("received: want 200, got %d", got.Received)
	}

	// Claim done returns the offset at claim time, and is one-shot.
	rec, ok, err := st.ClaimUploadDone(ctx, "up1", 2000)
	if err != nil || !ok || rec != 200 {
		t.Fatalf("claim: rec=%d ok=%v err=%v", rec, ok, err)
	}
	if _, ok, _ := st.ClaimUploadDone(ctx, "up1", 2000); ok {
		t.Fatal("a second finalize/reap must not re-claim the session")
	}
	// A finalized session no longer advances (append after finalize is a no-op).
	_ = st.AdvanceUploadReceived(ctx, "up1", 999, 2000)
	got, _, _ = st.GetUploadSession(ctx, "up1", u.ID)
	if got.Received != 200 {
		t.Fatalf("a done session must not advance: got %d", got.Received)
	}
}

// Concurrent ClaimUploadDone (a finalize racing the reaper, or two instances)
// lets exactly one caller win.
func TestUploadSessionClaimDoneConcurrent(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "race@example.com", "R")
	_, _ = st.CreateUploadSession(ctx, mkUploadRow("race1", u.ID), maxSessionsPerUser)

	var wg sync.WaitGroup
	var mu sync.Mutex
	won := 0
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, ok, err := st.ClaimUploadDone(ctx, "race1", 2000); err == nil && ok {
				mu.Lock()
				won++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if won != 1 {
		t.Fatalf("exactly one concurrent finalize/reap may win, got %d", won)
	}
}

// The per-user open-session cap is enforced at the store, and a finalized
// (deleted) session frees a slot.
func TestUploadSessionCapAtStore(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "cap@example.com", "C")
	for i := 0; i < maxSessionsPerUser; i++ {
		if ok, err := st.CreateUploadSession(ctx, mkUploadRow(fmt.Sprintf("s%d", i), u.ID), maxSessionsPerUser); err != nil || !ok {
			t.Fatalf("create %d: ok=%v err=%v", i, ok, err)
		}
	}
	if ok, _ := st.CreateUploadSession(ctx, mkUploadRow("over", u.ID), maxSessionsPerUser); ok {
		t.Fatal("must reject once the per-user cap is reached")
	}
	// Finalize (claim + delete) one → a slot frees up.
	_, _, _ = st.ClaimUploadDone(ctx, "s0", 2000)
	_ = st.DeleteUploadSession(ctx, "s0")
	if ok, err := st.CreateUploadSession(ctx, mkUploadRow("after", u.ID), maxSessionsPerUser); err != nil || !ok {
		t.Fatalf("a freed slot must accept a new session: ok=%v err=%v", ok, err)
	}
}

// The reaper lists only still-open, sufficiently-old sessions.
func TestListExpiredOpenUploadSessions(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "reap@example.com", "R")
	old := mkUploadRow("old", u.ID)
	old.CreatedAt = 100
	fresh := mkUploadRow("fresh", u.ID)
	fresh.CreatedAt = 10000
	_, _ = st.CreateUploadSession(ctx, old, maxSessionsPerUser)
	_, _ = st.CreateUploadSession(ctx, fresh, maxSessionsPerUser)

	rows, err := st.ListExpiredOpenUploadSessions(ctx, 5000) // before=5000
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != "old" {
		t.Fatalf("want only the old open session, got %+v", rows)
	}
	// A done session is never reaped (it was finalized; its blob is kept).
	_, _, _ = st.ClaimUploadDone(ctx, "old", 2000)
	rows, _ = st.ListExpiredOpenUploadSessions(ctx, 5000)
	if len(rows) != 0 {
		t.Fatalf("a done session must not be reaped, got %+v", rows)
	}
}
