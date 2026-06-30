package account

import (
	"context"
	"io"
	"log"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/storage"
)

func strings1(s string) io.Reader { return strings.NewReader(s) }

func TestGCSweepRemovesOnlyExpired(t *testing.T) {
	store := newTestStore(t)
	disk, _ := storage.NewDiskStore(t.TempDir())
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "g@example.com", "G")

	// One expired, one fresh stored file, each with a blob present.
	for _, f := range []StoredFile{
		{ID: "old", UserID: u.ID, BlobKey: "kold", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 100},
		{ID: "new", UserID: u.ID, BlobKey: "knew", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 9000000},
	} {
		_ = store.CreateStoredFile(ctx, f)
	}
	mustPut := func(k string) {
		if _, err := disk.Put(ctx, k, strings1("x")); err != nil {
			t.Fatalf("put %s: %v", k, err)
		}
	}
	mustPut("kold")
	mustPut("knew")

	// Upload events: one ancient (prune), one recent (keep).
	_ = store.RecordUpload(ctx, UploadEvent{ID: "ev_old", UserID: u.ID, Bytes: 1, UploadedAt: 100})
	_ = store.RecordUpload(ctx, UploadEvent{ID: "ev_new", UserID: u.ID, Bytes: 1, UploadedAt: 999000})

	g := &GC{Store: store, Blobs: disk, Now: func() int64 { return 1000000 }, Log: log.New(io.Discard, "", 0)}
	g.sweep(ctx)

	if _, err := store.GetStoredFile(ctx, "old"); err != ErrNotFound {
		t.Fatalf("expired file not deleted: %v", err)
	}
	if _, err := store.GetStoredFile(ctx, "new"); err != nil {
		t.Fatalf("fresh file wrongly deleted: %v", err)
	}
	if _, err := disk.Get(ctx, "kold"); err != storage.ErrNotFound {
		t.Fatalf("expired blob not deleted: %v", err)
	}
	if _, err := disk.Get(ctx, "knew"); err != nil {
		t.Fatalf("fresh blob wrongly deleted: %v", err)
	}
	// Ancient upload event pruned (cutoff = 1000000 - 90000 = 910000), recent kept.
	if total, _ := store.UserUploadedSince(ctx, u.ID, 0); total != 1 {
		t.Fatalf("upload events after prune total = %d, want 1", total)
	}
}
