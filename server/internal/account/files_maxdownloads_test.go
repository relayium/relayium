package account

import (
	"context"
	"testing"
)

func TestClaimDownloadSlot_CountLimit(t *testing.T) {
	st := newTestStore(t) // existing helper in the account test suite
	ctx := context.Background()
	// stored_files.user_id has an enforced FOREIGN KEY REFERENCES users(id)
	// (harden(db): enforce foreign keys) — a made-up "u1" would fail the insert,
	// so create a real user first, matching the pattern in files_download_test.go.
	u, err := st.UpsertUserByEmail(ctx, "maxdl@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	f := StoredFile{ID: newID(), UserID: u.ID, BlobKey: "b", EncManifest: []byte("m"), Size: 1, MaxDownloads: 2, ExpiresAt: 1 << 40, CreatedAt: 1}
	if err := st.CreateStoredFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		ok, err := st.ClaimDownloadSlot(ctx, f.ID, int64(i))
		if err != nil || !ok {
			t.Fatalf("claim %d: ok=%v err=%v", i, ok, err)
		}
	}
	ok, err := st.ClaimDownloadSlot(ctx, f.ID, 3)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("third claim should fail: max_downloads=2 exhausted")
	}
}

func TestClaimDownloadSlot_Unlimited(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "maxdl-unlimited@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	f := StoredFile{ID: newID(), UserID: u.ID, BlobKey: "b", EncManifest: []byte("m"), Size: 1, MaxDownloads: 0, ExpiresAt: 1 << 40, CreatedAt: 1}
	if err := st.CreateStoredFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		ok, err := st.ClaimDownloadSlot(ctx, f.ID, int64(i))
		if err != nil || !ok {
			t.Fatalf("unlimited claim %d must succeed: %v %v", i, ok, err)
		}
	}
}
