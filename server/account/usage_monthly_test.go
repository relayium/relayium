package account

import (
	"context"
	"testing"
)

func TestRecordMeterAccumulatesWithinPeriod(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "m@example.com", "M")

	// Two uploads + one download in the same month (Jan 2026).
	jan := int64(1_767_312_000) // 2026-01-02 00:00:00 UTC
	if err := s.RecordMeter(ctx, u.ID, MeterUpload, 100, jan); err != nil {
		t.Fatalf("record upload: %v", err)
	}
	if err := s.RecordMeter(ctx, u.ID, MeterUpload, 50, jan+3600); err != nil {
		t.Fatalf("record upload 2: %v", err)
	}
	if err := s.RecordMeter(ctx, u.ID, MeterDownload, 30, jan+7200); err != nil {
		t.Fatalf("record download: %v", err)
	}

	up, down, err := s.MonthlyUsage(ctx, u.ID, "202601")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if up != 150 || down != 30 {
		t.Fatalf("want up=150 down=30, got up=%d down=%d", up, down)
	}
}

func TestRecordMeterSeparatesPeriodsAndMissingIsZero(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "m@example.com", "M")

	jan := int64(1_767_312_000) // 2026-01
	feb := int64(1_769_990_400) // 2026-02-02 00:00:00 UTC
	_ = s.RecordMeter(ctx, u.ID, MeterUpload, 100, jan)
	_ = s.RecordMeter(ctx, u.ID, MeterUpload, 7, feb)

	if up, _, _ := s.MonthlyUsage(ctx, u.ID, "202601"); up != 100 {
		t.Fatalf("jan upload want 100, got %d", up)
	}
	if up, _, _ := s.MonthlyUsage(ctx, u.ID, "202602"); up != 7 {
		t.Fatalf("feb upload want 7, got %d", up)
	}
	// A period with no rows reads as zero, not an error.
	up, down, err := s.MonthlyUsage(ctx, u.ID, "202512")
	if err != nil || up != 0 || down != 0 {
		t.Fatalf("empty period want 0,0,nil; got %d,%d,%v", up, down, err)
	}
}
