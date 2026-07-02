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
		{ID: "old", UserID: u.ID, BlobKey: "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 100},
		{ID: "new", UserID: u.ID, BlobKey: "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1", EncManifest: []byte{1}, Size: 1, CreatedAt: 1, ExpiresAt: 9000000},
	} {
		_ = store.CreateStoredFile(ctx, f)
	}
	mustPut := func(k string) {
		if _, err := disk.Put(ctx, k, strings1("x")); err != nil {
			t.Fatalf("put %s: %v", k, err)
		}
	}
	mustPut("a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0")
	mustPut("b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1")

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
	if _, err := disk.Get(ctx, "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0"); err != storage.ErrNotFound {
		t.Fatalf("expired blob not deleted: %v", err)
	}
	if _, err := disk.Get(ctx, "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1"); err != nil {
		t.Fatalf("fresh blob wrongly deleted: %v", err)
	}
	// Ancient upload event pruned (cutoff = 1000000 - 90000 = 910000), recent kept.
	if total, _ := store.UserUploadedSince(ctx, u.ID, 0); total != 1 {
		t.Fatalf("upload events after prune total = %d, want 1", total)
	}
}

func TestGCSweepReclaimsSessionsAndMagicTokens(t *testing.T) {
	store := newTestStore(t)
	disk, _ := storage.NewDiskStore(t.TempDir())
	ctx := context.Background()
	u, _ := store.UpsertUserByEmail(ctx, "gc@example.com", "GC")

	// Sessions: one live, one expired, one revoked.
	_ = store.CreateSession(ctx, Session{ID: "live", UserID: u.ID, CreatedAt: 1, ExpiresAt: 9000000})
	_ = store.CreateSession(ctx, Session{ID: "expired", UserID: u.ID, CreatedAt: 1, ExpiresAt: 100})
	_ = store.CreateSession(ctx, Session{ID: "revoked", UserID: u.ID, CreatedAt: 1, ExpiresAt: 9000000})
	_ = store.RevokeSession(ctx, "revoked")

	// Magic tokens: one live, one expired, one used.
	_ = store.CreateMagicToken(ctx, MagicToken{TokenHash: "mlive", Email: "gc@example.com", CreatedAt: 1, ExpiresAt: 9000000})
	_ = store.CreateMagicToken(ctx, MagicToken{TokenHash: "mexp", Email: "gc@example.com", CreatedAt: 1, ExpiresAt: 100})
	_ = store.CreateMagicToken(ctx, MagicToken{TokenHash: "mused", Email: "gc@example.com", CreatedAt: 1, ExpiresAt: 9000000})
	_, _, _ = store.UseMagicToken(ctx, "mused", 200)

	g := &GC{Store: store, Blobs: disk, Now: func() int64 { return 1000000 }, Log: log.New(io.Discard, "", 0)}
	g.sweep(ctx)

	// Only the live session remains usable; expired + revoked rows are gone.
	if _, ok, _ := store.GetSession(ctx, "live"); !ok {
		t.Fatal("live session wrongly reclaimed")
	}
	var sessCount int
	_ = store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sessions`).Scan(&sessCount)
	if sessCount != 1 {
		t.Fatalf("sessions after sweep = %d, want 1", sessCount)
	}
	// Only the live, unused magic token remains.
	var mtCount int
	_ = store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM magic_tokens`).Scan(&mtCount)
	if mtCount != 1 {
		t.Fatalf("magic tokens after sweep = %d, want 1", mtCount)
	}
}
