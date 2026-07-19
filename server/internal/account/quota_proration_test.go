package account

import (
	"context"
	"testing"
)

// Free 档的月流量在 2026-07 从 2 GiB 降到 1 GiB。新库直接由 defaultPlans 播种。
func TestFreePlanTrafficIsOneGiB(t *testing.T) {
	_, store := newPlanService(t)
	p, ok, err := store.GetPlan(context.Background(), "free")
	if err != nil || !ok {
		t.Fatalf("GetPlan(free) = %v, ok=%v, err=%v", p, ok, err)
	}
	if p.TrafficBytes != 1073741824 {
		t.Fatalf("free traffic = %d, want 1073741824 (1 GiB)", p.TrafficBytes)
	}
}

// 老库迁移：Free 仍是旧值 2 GiB 时降到 1 GiB，且只降一次 —— 管理员之后主动
// 把 Free 改回 2 GiB 不该在下次启动时被静默覆盖。用文件 DB 反复开关模拟重启，
// 手法同 TestPasswordColumnMigrationIsIdempotent (sqlite_test.go:260)。
func TestFreeTrafficMigrationRunsOnce(t *testing.T) {
	ctx := context.Background()
	dsn := t.TempDir() + "/quota.db"

	s1, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open1: %v", err)
	}
	// 模拟迁移之前的老库：Free 档是 2 GiB。
	if err := s1.UpsertPlan(ctx, Plan{ID: "free", Name: "Free", StorageBytes: 104857600,
		TrafficBytes: 2147483648, RetentionSecs: 259200, Active: true, UpdatedAt: 1}); err != nil {
		t.Fatalf("seed free: %v", err)
	}
	s1.Close()

	s2, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open2: %v", err)
	}
	p, _, err := s2.GetPlan(ctx, "free")
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if p.TrafficBytes != 1073741824 {
		t.Fatalf("after migration free traffic = %d, want 1073741824", p.TrafficBytes)
	}
	// 管理员事后主动改回 2 GiB。
	p.TrafficBytes = 2147483648
	if err := s2.UpsertPlan(ctx, p); err != nil {
		t.Fatalf("admin edit: %v", err)
	}
	s2.Close()

	s3, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open3: %v", err)
	}
	defer s3.Close()
	p3, _, err := s3.GetPlan(ctx, "free")
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if p3.TrafficBytes != 2147483648 {
		t.Fatalf("admin's 2 GiB was silently overwritten to %d; migration must run only once", p3.TrafficBytes)
	}
}
