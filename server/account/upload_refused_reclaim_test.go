package account

// PrepareRefusedUploadReclaim, the refused finalize's settle-first ownership
// step, at the store level.

import (
	"context"
	"testing"
)

// A refused finalize's ownership step never hands over a blob that is not its
// own: one a stored object references, or one whose session row is in a state
// its finalize did not leave it in. Either answers false and writes nothing.
func TestARefusedReclaimNeverTakesABlobItDoesNotOwn(t *testing.T) {
	ctx := context.Background()
	st := newTestStore(t)
	u, _ := st.UpsertUserByEmail(ctx, "refuse@example.com", "R")

	// A tombstone whose key a live object names.
	cleanupRow(t, st, "named", u.ID, true, 10, 10, 0, 1000)
	if err := st.CreateStoredFile(ctx, StoredFile{ID: "f-named", UserID: u.ID, BlobKey: "blob-named",
		EncManifest: []byte("m"), Size: 10, CreatedAt: 100, ExpiresAt: 1 << 40}); err != nil {
		t.Fatal(err)
	}
	// A row that is not a finalize-claimed tombstone.
	cleanupRow(t, st, "open", u.ID, false, 10, 10, 0, 1000)

	for _, id := range []string{"named", "open"} {
		owned, err := st.PrepareRefusedUploadReclaim(ctx, id, "blob-"+id, "", 7000)
		if err != nil || owned {
			t.Errorf("%s: owned=%v err=%v, want false/nil", id, owned, err)
		}
		if q := queueRows(t, st, "blob-"+id); len(q) != 0 {
			t.Errorf("%s: the refusal queued a blob it does not own: %+v", id, q)
		}
	}
	// The claimed tombstone it does own: queued with its obligation, the row kept.
	cleanupRow(t, st, "mine", u.ID, true, 10, 10, 0, 1000)
	owned, err := st.PrepareRefusedUploadReclaim(ctx, "mine", "blob-mine", "", 7000)
	if err != nil || !owned {
		t.Fatalf("mine: owned=%v err=%v, want true/nil", owned, err)
	}
	if q := queueRows(t, st, "blob-mine"); len(q) != 1 || q[0].BillUserID != u.ID || q[0].BilledThrough != 10 {
		t.Errorf("mine: queue %+v, want one obligation at floor 10", q)
	}
	if !sessionPresent(t, st, "mine", u.ID) {
		t.Error("mine: the 409 tombstone went")
	}
}
