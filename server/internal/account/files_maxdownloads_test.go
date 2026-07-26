package account

import (
	"context"
	"io"
	"net/http"
	"testing"

	"github.com/relayium/relayium/authx"
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
	f := StoredFile{ID: authx.NewID(), UserID: u.ID, BlobKey: "b", EncManifest: []byte("m"), Size: 1, MaxDownloads: 2, ExpiresAt: 1 << 40, CreatedAt: 1}
	if err := st.CreateStoredFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		slot, ok, err := st.ClaimDownloadSlot(ctx, f.ID, int64(i))
		if err != nil || !ok {
			t.Fatalf("claim %d: slot=%d ok=%v err=%v", i, slot, ok, err)
		}
		if slot != int64(i) {
			t.Fatalf("claim %d: slot=%d, want %d", i, slot, i)
		}
	}
	slot, ok, err := st.ClaimDownloadSlot(ctx, f.ID, 3)
	if err != nil {
		t.Fatal(err)
	}
	if ok {
		t.Fatal("third claim should fail: max_downloads=2 exhausted")
	}
	if slot != 0 {
		t.Fatalf("failed claim should return slot=0, got %d", slot)
	}
}

func TestClaimDownloadSlot_Unlimited(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "maxdl-unlimited@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	f := StoredFile{ID: authx.NewID(), UserID: u.ID, BlobKey: "b", EncManifest: []byte("m"), Size: 1, MaxDownloads: 0, ExpiresAt: 1 << 40, CreatedAt: 1}
	if err := st.CreateStoredFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		slot, ok, err := st.ClaimDownloadSlot(ctx, f.ID, int64(i))
		if err != nil || !ok {
			t.Fatalf("unlimited claim %d must succeed: slot=%d %v %v", i, slot, ok, err)
		}
		if slot != int64(i+1) {
			t.Fatalf("unlimited claim %d: slot=%d, want %d", i, slot, i+1)
		}
	}
}

// TestClaimDownloadSlot_SlotNumberDrivesDeleteNotRecount is the Task 4
// concurrency-hardening regression test: handleFileBlob must gate its
// post-delivery delete on the SLOT NUMBER this request's own claim returned,
// not on a fresh re-read of download_count. A fresh re-read is racy once
// MaxDownloads>1 — a concurrent in-flight (later-failing) claim can inflate
// download_count so an EARLIER successful download sees count>=MaxDownloads
// and deletes the file prematurely, before it has actually served N
// downloads. This test only exercises the store's ClaimDownloadSlot contract
// (slot increments 1,2,... and identifies "did THIS request take the final
// slot"); files_test.go / files_test-level tests exercise the full HTTP path.
func TestClaimDownloadSlot_SlotNumberDrivesDeleteNotRecount(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, err := st.UpsertUserByEmail(ctx, "maxdl-slot@example.com", "")
	if err != nil {
		t.Fatal(err)
	}
	const maxDL = 3
	f := StoredFile{ID: authx.NewID(), UserID: u.ID, BlobKey: "b", EncManifest: []byte("m"), Size: 1, MaxDownloads: maxDL, ExpiresAt: 1 << 40, CreatedAt: 1}
	if err := st.CreateStoredFile(ctx, f); err != nil {
		t.Fatal(err)
	}

	// Claim 1: not the final slot -> handleFileBlob-style logic must NOT delete.
	slot1, ok1, err := st.ClaimDownloadSlot(ctx, f.ID, 1)
	if err != nil || !ok1 || slot1 != 1 {
		t.Fatalf("claim 1: slot=%d ok=%v err=%v, want slot=1 ok=true", slot1, ok1, err)
	}
	if slot1 >= maxDL {
		t.Fatalf("slot 1 must not look like the final slot (maxDL=%d)", maxDL)
	}
	// Row must still exist (an earlier-slot success is never a delete trigger).
	if _, err := st.GetStoredFile(ctx, f.ID); err != nil {
		t.Fatalf("row should still exist after non-final slot: %v", err)
	}

	// Claim 2: still not final.
	slot2, ok2, err := st.ClaimDownloadSlot(ctx, f.ID, 2)
	if err != nil || !ok2 || slot2 != 2 {
		t.Fatalf("claim 2: slot=%d ok=%v err=%v, want slot=2 ok=true", slot2, ok2, err)
	}
	if slot2 >= maxDL {
		t.Fatalf("slot 2 must not look like the final slot (maxDL=%d)", maxDL)
	}

	// Claim 3: this IS the final slot -> a real handleFileBlob would delete here.
	slot3, ok3, err := st.ClaimDownloadSlot(ctx, f.ID, 3)
	if err != nil || !ok3 || slot3 != 3 {
		t.Fatalf("claim 3: slot=%d ok=%v err=%v, want slot=3 ok=true", slot3, ok3, err)
	}
	if slot3 < maxDL {
		t.Fatalf("slot 3 should be >= maxDL=%d (final slot)", maxDL)
	}
	// Simulate handleFileBlob's post-delivery delete gated on THIS claim's slot.
	if slot3 >= f.MaxDownloads {
		if err := st.DeleteStoredFile(ctx, f.ID); err != nil {
			t.Fatalf("delete on final slot: %v", err)
		}
	}
	if _, err := st.GetStoredFile(ctx, f.ID); err == nil {
		t.Fatal("row should be gone after the final-slot delete")
	}
}

// TestUploadMaxDownloads_HTTPEndToEnd exercises the full request wiring (task
// 4's resolveRetention + task 4's slot-gated delete in handleFileBlob): an
// upload requesting maxDownloads=3 serves exactly 3 downloads and is gone on
// the 4th, with the row surviving after downloads 1 and 2 (not deleted early
// by a re-read of download_count).
func TestUploadMaxDownloads_HTTPEndToEnd(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "maxdl-http@example.com")
	resp := postUpload(t, ts, cookie, "?maxDownloads=3", uploadBody([]byte("m"), []byte("HELLO")))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload: %d", resp.StatusCode)
	}
	var up struct {
		ID string `json:"id"`
	}
	decodeJSON(t, resp, &up)

	for i := 1; i <= 3; i++ {
		br := getBlob(t, ts, up.ID)
		body, _ := io.ReadAll(br.Body)
		br.Body.Close()
		if br.StatusCode != http.StatusOK || string(body) != "HELLO" {
			t.Fatalf("download %d: status=%d body=%q", i, br.StatusCode, body)
		}
		// The row must still be resolvable after a non-final download (1, 2),
		// and gone only after the 3rd (final) one.
		_, err := store.GetStoredFile(context.Background(), up.ID)
		if i < 3 && err != nil {
			t.Fatalf("row should still exist after download %d/3: %v", i, err)
		}
		if i == 3 && err == nil {
			t.Fatalf("row should be deleted after the final (3rd) download")
		}
	}

	br := getBlob(t, ts, up.ID)
	br.Body.Close()
	if br.StatusCode != http.StatusNotFound {
		t.Fatalf("4th download: want 404 (slots exhausted), got %d", br.StatusCode)
	}
}
