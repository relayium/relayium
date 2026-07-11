package account

import (
	"context"
	"testing"
)

// PurgeTransientUserData is the deletion-confirmation-time purge (Task 3
// calls it): it wipes a user's transient/live data immediately while keeping
// the account shell (users row + identities + usage rows) intact until the
// 30-day hard-purge (Task 5). It returns the deleted stored_files so the
// caller can enqueue blob deletes.
func TestPurgeTransientUserData(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "a@example.com", "")
	_ = st.CreateSession(ctx, Session{ID: newID(), UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40})
	dev, _ := st.UpsertDevice(ctx, Device{ID: newID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	_ = st.CreateCLIToken(ctx, CLIToken{TokenHash: hashToken("t"), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1})
	_ = st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "bk", EncManifest: []byte("x"), Size: 1, ExpiresAt: 1 << 40, CreatedAt: 1})

	blobs, err := st.PurgeTransientUserData(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(blobs) != 1 || blobs[0].BlobKey != "bk" {
		t.Fatalf("expected 1 blob returned, got %+v", blobs)
	}
	if _, ok, _ := st.GetSession(ctx, ""); ok { /* nothing */
	}
	files, _ := st.ListStoredFilesByUser(ctx, u.ID)
	devs, _ := st.ListDevices(ctx, u.ID)
	if _, _, ok, _ := st.GetCLITokenUser(ctx, hashToken("t")); ok {
		t.Fatal("cli token should be gone")
	}
	if len(files) != 0 || len(devs) != 0 {
		t.Fatalf("transient data survived: files=%d devs=%d", len(files), len(devs))
	}
	// the users row must still exist (shell survives grace)
	if _, err := st.GetUserByID(ctx, u.ID); err != nil {
		t.Fatalf("user shell should survive: %v", err)
	}
}
