package account

import (
	"context"
	"testing"
)

// A session that made recent progress must NOT be reaped even if it was CREATED
// long ago — the reaper keys on idle time (last chunk), so a legit large upload
// slower than the TTL survives.
func TestReaperKeysOnIdleNotAge(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "idle@example.com", "I")

	old := mkUploadRow("active", u.ID)
	old.CreatedAt = 100 // created way before the reap horizon
	_, _ = st.CreateUploadSession(ctx, old, maxSessionsPerUser)
	// A chunk lands "now" (6000), well after the horizon.
	if err := st.AdvanceUploadReceived(ctx, "active", 10, 6000); err != nil {
		t.Fatal(err)
	}

	stale := mkUploadRow("stale", u.ID)
	stale.CreatedAt = 100 // created long ago and never touched since
	_, _ = st.CreateUploadSession(ctx, stale, maxSessionsPerUser)

	rows, err := st.ListExpiredOpenUploadSessions(ctx, 5000) // horizon = 5000
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].ID != "stale" {
		t.Fatalf("only the idle session may be reaped, got %+v", rows)
	}
}

// AdvanceUploadReceived must never push received past max_size, so a lying blob
// node can't inflate the owner's storage/quota accounting.
func TestAdvanceUploadReceivedClampedToMaxSize(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "clamp@example.com", "C")
	row := mkUploadRow("clamp", u.ID)
	row.MaxSize = 1000
	_, _ = st.CreateUploadSession(ctx, row, maxSessionsPerUser)

	// A node reporting a size beyond the cap is refused (no-op).
	if err := st.AdvanceUploadReceived(ctx, "clamp", 50_000, 2000); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.GetUploadSession(ctx, "clamp", u.ID); got.Received != 0 {
		t.Fatalf("received must not exceed max_size, got %d", got.Received)
	}
	// A legit within-cap advance still works.
	if err := st.AdvanceUploadReceived(ctx, "clamp", 500, 2000); err != nil {
		t.Fatal(err)
	}
	if got, _, _ := st.GetUploadSession(ctx, "clamp", u.ID); got.Received != 500 {
		t.Fatalf("within-cap advance should apply, got %d", got.Received)
	}
}

// A finalize that claimed done but crashed before persisting leaves a done=1 row
// whose blob nothing references. The orphan pass must surface exactly those (not
// a done=1 row whose blob became a live file), and the purge clears both.
func TestOrphanDoneUploadReaping(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "orphan@example.com", "O")

	// A: finalized, blob never persisted → orphan.
	orphan := mkUploadRow("orphan", u.ID)
	orphan.CreatedAt = 100
	_, _ = st.CreateUploadSession(ctx, orphan, maxSessionsPerUser)
	if _, ok, _ := st.ClaimUploadDone(ctx, "orphan", 100); !ok {
		t.Fatal("claim orphan")
	}

	// B: finalized AND its blob is now a live stored file → NOT an orphan.
	live := mkUploadRow("live", u.ID)
	live.CreatedAt = 100
	_, _ = st.CreateUploadSession(ctx, live, maxSessionsPerUser)
	if _, ok, _ := st.ClaimUploadDone(ctx, "live", 100); !ok {
		t.Fatal("claim live")
	}
	if err := st.CreateStoredFile(ctx, StoredFile{
		ID: "f1", UserID: u.ID, BlobKey: "blob-live", EncManifest: []byte("m"),
		Size: 10, CreatedAt: 100, ExpiresAt: 1 << 40,
	}); err != nil {
		t.Fatal(err)
	}

	orphans, err := st.ListOrphanDoneUploadSessions(ctx, 5000)
	if err != nil {
		t.Fatal(err)
	}
	if len(orphans) != 1 || orphans[0].ID != "orphan" {
		t.Fatalf("only the unreferenced finalized session is an orphan, got %+v", orphans)
	}

	// Purge clears every stale done=1 row (orphan + the referenced one).
	if err := st.PurgeDoneUploadSessions(ctx, 5000); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := st.GetUploadSession(ctx, "orphan", u.ID); ok {
		t.Fatal("orphan row should be purged")
	}
	if _, ok, _ := st.GetUploadSession(ctx, "live", u.ID); ok {
		t.Fatal("stale finalized row should be purged")
	}
	// The live file's blob must be untouched by the purge (only the row went).
	if _, err := st.GetStoredFile(ctx, "f1"); err != nil {
		t.Fatalf("purge must not touch the referenced file: %v", err)
	}
}
