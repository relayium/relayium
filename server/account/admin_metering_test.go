package account

import (
	"bytes"
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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

func TestAdminMetricsPerPeriod(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u1, _ := s.UpsertUserByEmail(ctx, "a@example.com", "A")
	u2, _ := s.UpsertUserByEmail(ctx, "b@example.com", "B")

	jan := int64(1_767_312_000) // 2026-01
	_ = s.RecordMeter(ctx, u1.ID, MeterUpload, 100, jan)
	_ = s.RecordMeter(ctx, u2.ID, MeterUpload, 20, jan)
	_ = s.RecordMeter(ctx, u1.ID, MeterDownload, 5, jan)
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "al", Token: "t", UserID: u1.ID, RelayedBytes: 300, RecordedAt: jan + 5})

	now := jan + 1000
	_ = s.CreateStoredFile(ctx, StoredFile{ID: "f1", UserID: u1.ID, BlobKey: "b", EncManifest: []byte("m"), Size: 900, CreatedAt: now, ExpiresAt: now + 1000})

	m, err := s.AdminMetrics(ctx, "202601", now)
	if err != nil {
		t.Fatalf("metrics: %v", err)
	}
	if m.TotalUsers != 2 {
		t.Fatalf("users want 2, got %d", m.TotalUsers)
	}
	if m.UploadBytes != 120 || m.DownloadBytes != 5 || m.RelayBytes != 300 {
		t.Fatalf("period totals want 120/5/300, got %d/%d/%d", m.UploadBytes, m.DownloadBytes, m.RelayBytes)
	}
	if m.ActiveStoredFiles != 1 || m.ActiveStoredBytes != 900 {
		t.Fatalf("storage want 1/900, got %d/%d", m.ActiveStoredFiles, m.ActiveStoredBytes)
	}
}

func TestAdminActivationFunnelUsesSelectedMonthAndTruthfulRatios(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	for i := 0; i < 4; i++ {
		if err := store.IncrementActivationFunnel(ctx, "202608", ActivationCodeMinted); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 3; i++ {
		_ = store.IncrementActivationFunnel(ctx, "202608", ActivationRoomOpened)
	}
	_ = store.IncrementActivationFunnel(ctx, "202608", ActivationRoomPaired)
	_ = store.IncrementActivationFunnel(ctx, "202607", ActivationCodeMinted)

	svc := NewService(store, nil, Config{})
	svc.SetNow(func() time.Time { return time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC) })
	req := httptest.NewRequest("GET", "/admin?period=202608", nil)
	data, err := svc.buildAdminOverviewData(req, adminHomeData{Section: adminSectionOverview, Lang: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if data.Activation != (ActivationFunnelCounts{CodeMinted: 4, RoomOpened: 3, RoomPaired: 1}) {
		t.Fatalf("activation = %+v", data.Activation)
	}
	if data.ActivationOpenRatio != "75.0%" || !data.ActivationOpenRatioOK || data.ActivationPairRatio != "33.3%" || !data.ActivationPairRatioOK {
		t.Fatalf("ratios = %q/%v, %q/%v", data.ActivationOpenRatio, data.ActivationOpenRatioOK, data.ActivationPairRatio, data.ActivationPairRatioOK)
	}

	var rendered bytes.Buffer
	if err := adminUsersTmpl.Execute(&rendered, data); err != nil {
		t.Fatal(err)
	}
	html := rendered.String()
	for _, want := range []string{
		"Successful code mints · actions", "First admitted sockets · actions",
		"First two-peer transitions · actions", "75.0%", "33.3%",
		"not unique users", "not cohort conversion", "best-effort lower-bound",
	} {
		if !strings.Contains(html, want) {
			t.Errorf("admin funnel lacks %q", want)
		}
	}
}

func TestAdminActivationRatiosRequireDenominators(t *testing.T) {
	data := adminHomeData{Section: adminSectionOverview, Lang: "en", Period: "202608", Months: []string{"202608"}}
	var rendered bytes.Buffer
	if err := adminUsersTmpl.Execute(&rendered, data); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rendered.String(), "actions / mint actions") || strings.Contains(rendered.String(), "actions / opened actions") {
		t.Fatal("ratio rendered without a positive denominator")
	}
}

type noActivationStore struct{ Store }

func TestAdminActivationCapabilityFailureIsNotRenderedAsZero(t *testing.T) {
	base := newTestStore(t)
	svc := NewService(noActivationStore{Store: base}, nil, Config{})
	svc.SetNow(func() time.Time { return time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC) })
	data, err := svc.buildAdminOverviewData(httptest.NewRequest("GET", "/admin", nil), adminHomeData{Section: adminSectionOverview, Lang: "en"})
	if err != nil {
		t.Fatal(err)
	}
	if !data.ActivationErr {
		t.Fatal("missing aggregate capability was rendered as a healthy zero")
	}
	var rendered bytes.Buffer
	if err := adminUsersTmpl.Execute(&rendered, data); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(rendered.String(), "zero is not being assumed") {
		t.Fatal("missing capability has no explicit error message")
	}
}
