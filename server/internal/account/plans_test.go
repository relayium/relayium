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
