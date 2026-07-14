package account

import (
	"context"
	"testing"
	"time"
)

func newPlanService(t *testing.T) (*Service, *SQLiteStore) {
	t.Helper()
	st := newTestStore(t)
	svc := &Service{store: st, cfg: Config{}, now: func() time.Time { return time.Unix(100, 0) }}
	if err := svc.SeedPlans(context.Background()); err != nil {
		t.Fatal(err)
	}
	return svc, st
}

func TestOverTrafficAndStorage(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "e@example.com", "")
	_ = st.SetUserPlan(ctx, u.ID, "free") // 100MB storage, 2GB traffic

	// Under both caps.
	if over, _ := svc.overTraffic(ctx, u.ID, 1<<20); over {
		t.Fatal("1MB should be under the 2GB traffic cap")
	}
	if over, _ := svc.overStorage(ctx, u.ID, 1<<20); over {
		t.Fatal("1MB should be under the 100MB storage cap")
	}
	// Adding more than the cap trips it.
	if over, _ := svc.overStorage(ctx, u.ID, 200<<20); !over {
		t.Fatal("200MB must exceed the 100MB free storage cap")
	}
	// Record traffic near the 2GB cap, then a small add trips it.
	_ = st.RecordMeter(ctx, u.ID, MeterUpload, 2<<30, 100)
	if over, _ := svc.overTraffic(ctx, u.ID, 1); !over {
		t.Fatal("already at 2GB → any add must exceed the free traffic cap")
	}
}

func TestPlanForUserFallsBackToFree(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "z@example.com", "")
	_ = st.SetUserPlan(ctx, u.ID, "nonexistent-plan")
	if p := svc.planForUser(ctx, u.ID); p.ID != "free" {
		t.Fatalf("unknown plan_id must fall back to free, got %q", p.ID)
	}
}
