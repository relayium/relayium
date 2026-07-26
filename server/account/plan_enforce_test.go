package account

import (
	"context"
	"testing"
	"time"

	"github.com/relayium/relayium/authx"
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
	_ = st.SetUserPlan(ctx, u.ID, "free", svc.now().Unix()) // 100MB storage, 1GB traffic

	// Under both caps.
	if over, _ := svc.overTraffic(ctx, u.ID, 1<<20); over {
		t.Fatal("1MB should be under the 1GB traffic cap")
	}
	if over, _ := svc.overStorage(ctx, u.ID, 1<<20); over {
		t.Fatal("1MB should be under the 100MB storage cap")
	}
	// Adding more than the cap trips it.
	if over, _ := svc.overStorage(ctx, u.ID, 200<<20); !over {
		t.Fatal("200MB must exceed the 100MB free storage cap")
	}
	// Record traffic at the 1GB cap, then a small add trips it.
	_ = st.RecordMeter(ctx, u.ID, MeterUpload, 1<<30, 100)
	if over, _ := svc.overTraffic(ctx, u.ID, 1); !over {
		t.Fatal("already at 1GB → any add must exceed the free traffic cap")
	}
}

func TestPlanForUserFallsBackToFree(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "z@example.com", "")
	_ = st.SetUserPlan(ctx, u.ID, "nonexistent-plan", svc.now().Unix())
	if p, err := svc.planForUser(ctx, u.ID); p.ID != "free" || err != nil {
		t.Fatalf("unknown plan_id must fall back to free with nil err, got %q, %v", p.ID, err)
	}
}

// TestPlanForUserMissingUser covers the other fallback path: no such user row
// at all (vs. an existing user pointing at an unknown plan_id above).
func TestPlanForUserMissingUser(t *testing.T) {
	svc, _ := newPlanService(t)
	ctx := context.Background()
	if p, err := svc.planForUser(ctx, "nonexistent-user-id"); p.ID != "free" || err != nil {
		t.Fatalf("missing user must fall back to free with nil err, got %q, %v", p.ID, err)
	}
}

// errUserStore wraps a *SQLiteStore but forces GetUserByID to error, to prove the
// enforcement gates fail OPEN (allow) on a real DB error rather than silently
// applying the Free cap.
type errUserStore struct {
	Store
}

func (e errUserStore) GetUserByID(ctx context.Context, id string) (User, error) {
	return User{}, context.DeadlineExceeded
}

func TestOverHelpersFailOpenOnStoreError(t *testing.T) {
	st := newTestStore(t)
	svc := &Service{store: errUserStore{st}, cfg: Config{}, now: func() time.Time { return time.Unix(100, 0) }}
	if err := (&Service{store: st, cfg: Config{}, now: svc.now}).SeedPlans(context.Background()); err != nil {
		t.Fatal(err)
	}
	over, err := svc.overTraffic(context.Background(), "any", 1<<60)
	if err == nil {
		t.Fatal("a store error must propagate from overTraffic (so the gate fails open)")
	}
	_ = over // gate uses `err == nil && over`, so a non-nil err means "don't block"
}

// TestOverGlobalStorage covers the global logical cap: disabled by default
// (cap<=0), and enforced with an exact used+add>cap boundary once set.
func TestOverGlobalStorage(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()

	// Disabled by default: newPlanService's Config{} leaves StorageDiskCap at
	// its zero value, so resolveSettings().StorageDiskCap <= 0 and the check
	// short-circuits to false regardless of how much is being added.
	if over, err := svc.overGlobalStorage(ctx, 1<<40); err != nil || over {
		t.Fatalf("overGlobalStorage with no cap set = %v,%v want false,nil", over, err)
	}

	// Enable the cap at 1000 bytes (SetSetting's "at" uses the fixed service
	// clock, s.now().Unix() == 100, matching newPlanService's stub).
	if err := st.SetSetting(ctx, SettingStorageDiskCap, 1000, svc.now().Unix()); err != nil {
		t.Fatal(err)
	}

	// Seed 900 live bytes of global storage (any user; the check is unscoped).
	// ExpiresAt must be in the future relative to now=100 to count as "live".
	u, _ := st.UpsertUserByEmail(ctx, "global-storage@example.com", "")
	if err := st.CreateStoredFile(ctx, StoredFile{
		ID: authx.NewID(), UserID: u.ID, BlobKey: "gb1", EncManifest: []byte("x"),
		Size: 900, CreatedAt: 1, ExpiresAt: 1 << 40, // 1<<40 unix seconds ≫ now=100, so it's live
	}); err != nil {
		t.Fatal(err)
	}

	// 900 + 50 = 950 <= 1000 cap → not over.
	if over, err := svc.overGlobalStorage(ctx, 50); err != nil || over {
		t.Fatalf("overGlobalStorage(900+50=950 vs cap 1000) = %v,%v want false,nil", over, err)
	}
	// 900 + 200 = 1100 > 1000 cap → over.
	if over, err := svc.overGlobalStorage(ctx, 200); err != nil || !over {
		t.Fatalf("overGlobalStorage(900+200=1100 vs cap 1000) = %v,%v want true,nil", over, err)
	}
}

// TestPlanRetentionCap asserts the retention ceiling passed through from the
// user's assigned plan (here the seeded free plan: 3 days = 259200s).
func TestPlanRetentionCap(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "retention@example.com", "")
	_ = st.SetUserPlan(ctx, u.ID, "free", svc.now().Unix())

	const wantFreeRetentionSecs = 1 * 86400 // matches defaultPlans()'s seeded "free" entry
	if got := svc.planRetentionCap(ctx, u.ID); got != wantFreeRetentionSecs {
		t.Fatalf("planRetentionCap(free) = %d, want %d", got, wantFreeRetentionSecs)
	}

	// Reassign to a plan with a distinct, deliberately-chosen retention value
	// to prove the cap tracks the assigned plan rather than being hardcoded.
	const customRetentionSecs = 7 * 86400
	if err := st.UpsertPlan(ctx, Plan{
		ID: "custom-retention", Name: "Custom", StorageBytes: 1 << 30, TrafficBytes: 1 << 30,
		RetentionSecs: customRetentionSecs, Active: true, UpdatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	_ = st.SetUserPlan(ctx, u.ID, "custom-retention", svc.now().Unix())
	if got := svc.planRetentionCap(ctx, u.ID); got != customRetentionSecs {
		t.Fatalf("planRetentionCap(custom) = %d, want %d", got, customRetentionSecs)
	}
}

// TestOverStorageExactBoundary proves overStorage uses strict '>', not '>=':
// used(0) + add(cap) must land exactly at the cap and NOT be flagged as over.
func TestOverStorageExactBoundary(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "storage-boundary@example.com", "")

	const capBytes = 100
	if err := st.UpsertPlan(ctx, Plan{
		ID: "storage-cap-100", Name: "StorageCap100", StorageBytes: capBytes, TrafficBytes: 1 << 30,
		RetentionSecs: 86400, Active: true, UpdatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	_ = st.SetUserPlan(ctx, u.ID, "storage-cap-100", svc.now().Unix())

	// No existing storage: used=0. 0+100 == cap(100) → NOT over.
	if over, err := svc.overStorage(ctx, u.ID, capBytes); err != nil || over {
		t.Fatalf("overStorage(used=0, add=100, cap=100) = %v,%v want false,nil (== cap is not over)", over, err)
	}
	// 0+101 == cap(100)+1 → over.
	if over, err := svc.overStorage(ctx, u.ID, capBytes+1); err != nil || !over {
		t.Fatalf("overStorage(used=0, add=101, cap=100) = %v,%v want true,nil (> cap is over)", over, err)
	}
}

// TestOverTrafficExactBoundary is overStorage's boundary case, mirrored for
// overTraffic: used+add landing exactly on the cap must not trip it.
//
// overTraffic's cap now comes from monthlyTrafficCap, which sums prorated
// segments for a user who changed plans THIS month (see quota_proration_test.go).
// To keep this test's cap a clean, unprorated 500 — the exact boundary the test
// name promises — the plan assignment below happens in the month BEFORE the
// service clock's "now" (svc.now()==100, period "197001"), by passing a
// timestamp of -1 (period "196912"). That lands u.QuotaAccruedPeriod in a past
// period, so monthlyTrafficCap takes its "no change this month" branch and
// returns plan.TrafficBytes verbatim, with no proration.
func TestOverTrafficExactBoundary(t *testing.T) {
	svc, st := newPlanService(t)
	ctx := context.Background()
	u, _ := st.UpsertUserByEmail(ctx, "traffic-boundary@example.com", "")

	const capBytes = 500
	if err := st.UpsertPlan(ctx, Plan{
		ID: "traffic-cap-500", Name: "TrafficCap500", StorageBytes: 1 << 30, TrafficBytes: capBytes,
		RetentionSecs: 86400, Active: true, UpdatedAt: 1,
	}); err != nil {
		t.Fatal(err)
	}
	_ = st.SetUserPlan(ctx, u.ID, "traffic-cap-500", -1) // previous period — see comment above

	// Record 300 bytes of used traffic in the current month (now=100, per
	// newPlanService's stub clock, so periodOf(100) is "this period").
	if err := st.RecordMeter(ctx, u.ID, MeterUpload, 300, svc.now().Unix()); err != nil {
		t.Fatal(err)
	}

	// used(300) + add(200) == cap(500) → NOT over.
	if over, err := svc.overTraffic(ctx, u.ID, capBytes-300); err != nil || over {
		t.Fatalf("overTraffic(used=300, add=200, cap=500) = %v,%v want false,nil (== cap is not over)", over, err)
	}
	// used(300) + add(201) == cap(500)+1 → over.
	if over, err := svc.overTraffic(ctx, u.ID, capBytes-300+1); err != nil || !over {
		t.Fatalf("overTraffic(used=300, add=201, cap=500) = %v,%v want true,nil (> cap is over)", over, err)
	}
}
