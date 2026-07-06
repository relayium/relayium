package account

import (
	"context"
	"testing"
)

func TestAdminListUsersPeriodColumns(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "a@example.com", "A")

	jan := int64(1_767_312_000) // 2026-01-02 UTC
	feb := int64(1_769_990_400) // 2026-02-02 UTC
	// Jan: 100 up, 40 down; Feb: 7 up (must not leak into Jan).
	_ = s.RecordMeter(ctx, u.ID, MeterUpload, 100, jan)
	_ = s.RecordMeter(ctx, u.ID, MeterDownload, 40, jan)
	_ = s.RecordMeter(ctx, u.ID, MeterUpload, 7, feb)
	// Relay: 500 bytes recorded in Jan.
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "al1", Token: "t", UserID: u.ID, RelayedBytes: 500, RecordedAt: jan + 10})
	// Storage: one live file (size 900) + one expired (size 111, excluded).
	now := feb + 100
	_ = s.CreateStoredFile(ctx, StoredFile{ID: "f1", UserID: u.ID, BlobKey: "b1", EncManifest: []byte("m"), Size: 900, CreatedAt: now, ExpiresAt: now + 1000})
	_ = s.CreateStoredFile(ctx, StoredFile{ID: "f2", UserID: u.ID, BlobKey: "b2", EncManifest: []byte("m"), Size: 111, CreatedAt: jan, ExpiresAt: now - 1})

	rows, total, err := s.AdminListUsers(ctx, AdminUserQuery{
		Period: "202601", Now: now, Limit: 50, Offset: 0,
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 1 || len(rows) != 1 {
		t.Fatalf("want 1 user, got total=%d rows=%d", total, len(rows))
	}
	r := rows[0]
	if r.UploadBytes != 100 || r.DownloadBytes != 40 {
		t.Fatalf("jan up/down want 100/40, got %d/%d", r.UploadBytes, r.DownloadBytes)
	}
	if r.RelayedBytes != 500 {
		t.Fatalf("jan relay want 500, got %d", r.RelayedBytes)
	}
	if r.StorageBytes != 900 {
		t.Fatalf("storage want 900 (expired excluded), got %d", r.StorageBytes)
	}
}
