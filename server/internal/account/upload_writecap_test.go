package account

import (
	"context"
	"testing"

	"github.com/relayium/relayium/internal/authx"
)

// uploadWriteCap must bound a billable single-shot upload's on-disk write to the
// user's remaining daily quota (well below MaxFileSize), so a chunked /
// understated Content-Length can't stream a full MaxFileSize blob to disk only
// to be dropped by the post-write gate (disk-churn DoS).
func TestUploadWriteCapBoundsToRemainingQuota(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	now := svc.now().Unix()

	// 10 MiB global daily quota; an unlimited-storage plan so only the daily
	// quota bounds the cap.
	if err := st.SetSetting(ctx, SettingDailyQuota, 10<<20, now); err != nil {
		t.Fatal(err)
	}
	u, _ := st.UpsertUserByEmail(ctx, "wcap@example.com", "")
	if err := st.UpsertPlan(ctx, Plan{ID: "unl", Name: "Unl", StorageBytes: 0, TrafficBytes: 0, DailyQuotaBytes: 0, Active: true, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	if err := st.SetUserPlan(ctx, u.ID, "unl", now); err != nil {
		t.Fatal(err)
	}

	const maxFile = int64(1) << 30 // 1 GiB

	// Fresh user: cap ≈ remaining daily quota (+slack), far under MaxFileSize.
	cap := svc.uploadWriteCap(ctx, u.ID, maxFile)
	want := int64(10<<20) + minBillableBytes
	if cap != want {
		t.Fatalf("fresh cap = %d, want %d (remaining quota + slack)", cap, want)
	}
	if cap >= maxFile {
		t.Fatalf("cap %d must be far below MaxFileSize %d — else no churn protection", cap, maxFile)
	}

	// After consuming 9 MiB of the quota, the cap shrinks with the remainder.
	ok, err := st.ReserveUpload(ctx, UploadEvent{ID: authx.NewID(), UserID: u.ID, Bytes: 9 << 20, UploadedAt: now}, now-dayWindow, 10<<20)
	if err != nil || !ok {
		t.Fatalf("reserve: ok=%v err=%v", ok, err)
	}
	cap = svc.uploadWriteCap(ctx, u.ID, maxFile)
	if want := int64(1<<20) + minBillableBytes; cap != want {
		t.Fatalf("after 9 MiB used, cap = %d, want %d", cap, want)
	}
}

// A quota-exhausted user is still floored at minBillableBytes (never 0/negative),
// so the cappedReader rejects fast instead of admitting an unbounded write.
func TestUploadWriteCapFlooredWhenExhausted(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	now := svc.now().Unix()
	if err := st.SetSetting(ctx, SettingDailyQuota, 1<<20, now); err != nil {
		t.Fatal(err)
	}
	u, _ := st.UpsertUserByEmail(ctx, "exhausted@example.com", "")
	_ = st.UpsertPlan(ctx, Plan{ID: "unl", Name: "Unl", StorageBytes: 0, DailyQuotaBytes: 0, Active: true, UpdatedAt: now})
	_ = st.SetUserPlan(ctx, u.ID, "unl", now)
	// Blow past the 1 MiB quota.
	_, _ = st.ReserveUpload(ctx, UploadEvent{ID: authx.NewID(), UserID: u.ID, Bytes: 5 << 20, UploadedAt: now}, now-dayWindow, 100<<20)

	cap := svc.uploadWriteCap(ctx, u.ID, int64(1)<<30)
	if cap != minBillableBytes {
		t.Fatalf("exhausted cap = %d, want the minBillableBytes floor %d", cap, minBillableBytes)
	}
}
