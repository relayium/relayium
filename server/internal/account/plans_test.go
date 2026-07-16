package account

import (
	"context"
	"testing"
	"time"
)

func TestSeedPlansCreatesFourDefaultsIdempotently(t *testing.T) {
	st := newTestStore(t)
	svc := &Service{store: st, cfg: Config{}, now: func() time.Time { return time.Unix(1000, 0) }}

	if err := svc.SeedPlans(context.Background()); err != nil {
		t.Fatalf("seed: %v", err)
	}
	plans, err := st.ListPlans(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(plans) != 4 {
		t.Fatalf("want 4 default plans, got %d", len(plans))
	}
	// free must be first (sort_order 0) with the spec's factory values.
	free := plans[0]
	if free.ID != "free" || free.StorageBytes != 100<<20 || free.TrafficBytes != 2<<30 || free.RetentionSecs != 3*86400 {
		t.Fatalf("free defaults wrong: %+v", free)
	}

	// An admin edit must survive a re-seed (existing rows not overwritten).
	free.StorageBytes = 999
	if err := st.UpsertPlan(context.Background(), free); err != nil {
		t.Fatal(err)
	}
	if err := svc.SeedPlans(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _, _ := st.GetPlan(context.Background(), "free")
	if got.StorageBytes != 999 {
		t.Fatalf("re-seed overwrote an admin edit: %+v", got)
	}
}

func TestStorageDiskCapSettingResolves(t *testing.T) {
	st := newTestStore(t)
	svc := &Service{store: st, cfg: Config{StorageDiskCap: 12345}, now: func() time.Time { return time.Unix(1, 0) }}
	if got := svc.resolveSettings(context.Background()).StorageDiskCap; got != 12345 {
		t.Fatalf("StorageDiskCap = %d, want 12345 (Config default)", got)
	}
	_ = st.SetSetting(context.Background(), SettingStorageDiskCap, 999, 1)
	if got := svc.resolveSettings(context.Background()).StorageDiskCap; got != 999 {
		t.Fatalf("StorageDiskCap = %d, want 999 (admin override)", got)
	}
}

func TestUserPlanDefaultsFreeAndCanBeSet(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "plan@example.com", "")

	got, err := st.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.PlanID != "free" {
		t.Fatalf("new user plan = %q, want free", got.PlanID)
	}

	if err := st.SetUserPlan(ctx, u.ID, "pro"); err != nil {
		t.Fatal(err)
	}
	got, _ = st.GetUserByID(ctx, u.ID)
	if got.PlanID != "pro" {
		t.Fatalf("after set, plan = %q, want pro", got.PlanID)
	}
}

func TestUsageReadQueries(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "usage@example.com", "")
	// period 100 seconds → periodOf must map both meters into the same month.
	_ = st.RecordMeter(ctx, u.ID, MeterUpload, 500, 100)
	_ = st.RecordMeter(ctx, u.ID, MeterDownload, 300, 100)
	period := periodOf(100)

	up, err := st.UserMonthlyUpDown(ctx, u.ID, period)
	if err != nil || up != 800 {
		t.Fatalf("UserMonthlyUpDown = %d,%v want 800", up, err)
	}

	// Contract: a period with no usage_monthly row returns (0, nil), not an error.
	upNoRow, err := st.UserMonthlyUpDown(ctx, u.ID, "999999")
	if err != nil || upNoRow != 0 {
		t.Fatalf("UserMonthlyUpDown(no-row period) = %d,%v want 0,nil", upNoRow, err)
	}

	_ = st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "b1", EncManifest: []byte("x"), Size: 4096, ExpiresAt: 1 << 40, CreatedAt: 1}) // live
	_ = st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "b2", EncManifest: []byte("x"), Size: 1000, ExpiresAt: 5, CreatedAt: 1})       // already expired at now=10

	cs, err := st.CurrentStorage(ctx, u.ID, 10)
	if err != nil || cs != 4096 {
		t.Fatalf("CurrentStorage = %d,%v want 4096 (expired file excluded)", cs, err)
	}
	gs, err := st.GlobalStorageUsed(ctx, 10)
	if err != nil || gs != 4096 {
		t.Fatalf("GlobalStorageUsed = %d,%v want 4096", gs, err)
	}

	// --- Global-vs-scoped distinction ---
	// A second user's live file must be counted by GlobalStorageUsed (unscoped)
	// but must NOT leak into CurrentStorage for the first user (per-user scoped).
	u2, _ := st.UpsertUserByEmail(ctx, "usage2@example.com", "")
	_ = st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u2.ID, BlobKey: "b3", EncManifest: []byte("x"), Size: 2048, ExpiresAt: 1 << 40, CreatedAt: 1}) // live, belongs to u2

	gs2, err := st.GlobalStorageUsed(ctx, 10)
	if err != nil || gs2 != 6144 { // 4096 (u1's b1) + 2048 (u2's b3): both users' live bytes
		t.Fatalf("GlobalStorageUsed = %d,%v want 6144 (must include both users' live bytes)", gs2, err)
	}
	cs2, err := st.CurrentStorage(ctx, u.ID, 10)
	if err != nil || cs2 != 4096 { // unchanged: still only u1's b1; u2's b3 must not count here
		t.Fatalf("CurrentStorage(u1) = %d,%v want 4096 (must exclude u2's file)", cs2, err)
	}

	// --- Expiry boundary: ExpiresAt == now must be excluded (strictly > , not >=) ---
	_ = st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "b4", EncManifest: []byte("x"), Size: 777, ExpiresAt: 10, CreatedAt: 1}) // expires exactly at now=10 → not live

	cs3, err := st.CurrentStorage(ctx, u.ID, 10)
	if err != nil || cs3 != 4096 { // b4 excluded: total is still just b1's 4096
		t.Fatalf("CurrentStorage(u1) after boundary file = %d,%v want 4096 (ExpiresAt==now must be excluded)", cs3, err)
	}
	gs3, err := st.GlobalStorageUsed(ctx, 10)
	if err != nil || gs3 != 6144 { // b4 excluded here too: global total unchanged from 6144
		t.Fatalf("GlobalStorageUsed after boundary file = %d,%v want 6144 (ExpiresAt==now must be excluded)", gs3, err)
	}
}
