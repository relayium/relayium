package account

import (
	"context"
	"testing"
	"time"
)

// The strict quota chain and the original must agree whenever nothing fails.
//
// They exist as two functions because they differ on ONE axis: what an
// unreadable row means. Renewal refuses; the initial endpoint carries on. That
// difference is deliberate and is asserted elsewhere
// (TestRenewFailsClosedOnEveryNestedPolicyRead).
//
// What is NOT deliberate is any difference in the ARITHMETIC. The strict
// variants restate the mid-month proration, the effective-tier comparison and
// the settings resolution rather than sharing one body, so nothing but a test
// stops the two from drifting. If they ever disagree on a healthy store, a
// renewal and a first credential would be judged against different caps for the
// same account — which is a money-path divergence, discovered from a billing
// complaint rather than from a build.
//
// So: for a HEALTHY store, across every shape that makes the formula branch,
// strict == original, exactly.

// equalityCase is one account shape the two chains must agree on.
type equalityCase struct {
	name  string
	setup func(t *testing.T, f *renewFixture)
}

func strictEqualityCases() []equalityCase {
	return []equalityCase{
		{"plain free account", func(*testing.T, *renewFixture) {}},
		{"no usage at all, mid-month", func(t *testing.T, f *renewFixture) {
			// periodOf(now) with no accrual row: the "full month" branch.
			f.now = time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC).Unix()
		}},
		{"paid tier", func(t *testing.T, f *renewFixture) {
			setUserPlan(t, f, "pro")
		}},
		{"unlimited tier", func(t *testing.T, f *renewFixture) {
			// A plan whose traffic cap is non-positive takes the early
			// "unlimited" return in both chains.
			setPlanTraffic(t, f, "free", 0)
		}},
		{"mid-month plan change, prorated segment", func(t *testing.T, f *renewFixture) {
			setUserPlan(t, f, "plus")
			accrueMidMonth(t, f, 3<<20)
		}},
		{"mid-month change on an unlimited tier", func(t *testing.T, f *renewFixture) {
			setPlanTraffic(t, f, "pro", 0)
			setUserPlan(t, f, "pro")
			accrueMidMonth(t, f, 1<<20)
		}},
		{"live admin grant above the current tier", func(t *testing.T, f *renewFixture) {
			grantPlan(t, f, "max")
		}},
		{"live admin grant BELOW the current tier", func(t *testing.T, f *renewFixture) {
			// The grant must lose; both chains must agree that it does.
			// Written directly: GrantAdminPlan refuses to CREATE a downgrade,
			// but a row can hold one — a tier renamed or repriced after the
			// grant was issued leaves exactly this state, and it is where
			// effectivePlanID's comparison actually branches.
			setUserPlan(t, f, "max")
			writeGrantRow(t, f, "free")
		}},
		{"admin grant naming a plan that does not exist", func(t *testing.T, f *renewFixture) {
			// Same reasoning: a deleted plan leaves a grant pointing at nothing.
			writeGrantRow(t, f, "no-such-tier")
		}},
		{"admin grant plus a prorated segment", func(t *testing.T, f *renewFixture) {
			setUserPlan(t, f, "plus")
			grantPlan(t, f, "max")
			accrueMidMonth(t, f, 7<<20)
		}},
		{"recorded relay usage", func(t *testing.T, f *renewFixture) {
			recordRelay(t, f, "equality-alloc", 5<<20)
		}},
		{"usage past the cap", func(t *testing.T, f *renewFixture) {
			setPlanTraffic(t, f, "free", 1<<20)
			recordRelay(t, f, "equality-over", 4<<20)
		}},
		{"usage exactly at the cap", func(t *testing.T, f *renewFixture) {
			// The boundary both chains define as SPENT.
			setPlanTraffic(t, f, "free", 2<<20)
			recordRelay(t, f, "equality-exact", 2<<20)
		}},
		{"admin-edited node traffic setting", func(t *testing.T, f *renewFixture) {
			setSetting(t, f, SettingNodeTrafficDefault, 9<<30)
		}},
		{"admin-edited settings across the board", func(t *testing.T, f *renewFixture) {
			for key, value := range map[string]int64{
				SettingMaxFileSize: 1 << 20, SettingDailyQuota: 2 << 20,
				SettingDefaultTTL: 3600, SettingMaxTTL: 7200,
				SettingDefaultRetention: 1, SettingDefaultMaxDownloads: 4,
				SettingMaxMaxDownloads: 9, SettingAccountGraceDays: 11,
				SettingAccountReminderDays: 3, SettingStorageDiskCap: 5 << 30,
				SettingDisableCentralFallback: 1, SettingNodeTrafficDefault: 6 << 30,
			} {
				setSetting(t, f, key, value)
			}
		}},
	}
}

func setUserPlan(t *testing.T, f *renewFixture, plan string) {
	t.Helper()
	if _, err := f.store.Store.(*SQLiteStore).db.Exec(`UPDATE users SET plan_id=? WHERE id=?`, plan, f.owner.ID); err != nil {
		t.Fatalf("set plan: %v", err)
	}
}

func setPlanTraffic(t *testing.T, f *renewFixture, plan string, bytes int64) {
	t.Helper()
	if _, err := f.store.Store.(*SQLiteStore).db.Exec(`UPDATE plans SET traffic_bytes=? WHERE id=?`, bytes, plan); err != nil {
		t.Fatalf("set plan traffic: %v", err)
	}
}

// accrueMidMonth puts the account in the "changed tier this month" branch, the
// one that prorates the remaining segment on top of what is already accrued.
func accrueMidMonth(t *testing.T, f *renewFixture, accrued int64) {
	t.Helper()
	f.now = time.Date(2026, 9, 20, 0, 0, 0, 0, time.UTC).Unix()
	started := time.Date(2026, 9, 11, 0, 0, 0, 0, time.UTC).Unix()
	if _, err := f.store.Store.(*SQLiteStore).db.Exec(
		`UPDATE users SET quota_accrued_period=?, quota_accrued_bytes=?, plan_started_at=? WHERE id=?`,
		periodOf(f.now), accrued, started, f.owner.ID); err != nil {
		t.Fatalf("accrue: %v", err)
	}
}

func grantPlan(t *testing.T, f *renewFixture, plan string) {
	t.Helper()
	if _, err := f.store.Store.(*SQLiteStore).GrantAdminPlan(
		context.Background(), f.owner.ID, plan, AdminGrantModeFromNow, 30, f.now); err != nil {
		t.Fatalf("grant %s: %v", plan, err)
	}
}

// writeGrantRow stages an admin grant the public API would refuse to create,
// for the states a live database can still hold after a plan is renamed,
// repriced or removed.
func writeGrantRow(t *testing.T, f *renewFixture, plan string) {
	t.Helper()
	if _, err := f.store.Store.(*SQLiteStore).db.Exec(
		`UPDATE users SET admin_grant_plan_id=?, admin_grant_granted_at=?, admin_grant_expires_at=? WHERE id=?`,
		plan, f.now, f.now+86400, f.owner.ID); err != nil {
		t.Fatalf("write grant row: %v", err)
	}
}

func recordRelay(t *testing.T, f *renewFixture, alloc string, bytes int64) {
	t.Helper()
	if err := f.store.Store.(*SQLiteStore).RecordUsage(context.Background(), UsageEvent{
		AllocID: alloc, Token: f.tag, UserID: f.owner.ID,
		RelayedBytes: bytes, RecordedAt: f.now, Billable: true,
	}); err != nil {
		t.Fatalf("record usage: %v", err)
	}
}

func setSetting(t *testing.T, f *renewFixture, key string, value int64) {
	t.Helper()
	if err := f.store.Store.(*SQLiteStore).SetSetting(context.Background(), key, value, f.now); err != nil {
		t.Fatalf("set %s: %v", key, err)
	}
}

func TestStrictQuotaChainMatchesTheOriginalOnAHealthyStore(t *testing.T) {
	for _, c := range strictEqualityCases() {
		t.Run(c.name, func(t *testing.T) {
			f := newRenewFixture(t)
			c.setup(t, f)
			ctx := context.Background()

			// The effective tier, which is where the admin grant is compared.
			wantTier := func() string {
				u, err := f.store.GetUserByID(ctx, f.owner.ID)
				if err != nil {
					t.Fatalf("user: %v", err)
				}
				return f.svc.effectivePlanID(ctx, u)
			}()
			u, err := f.store.GetUserByID(ctx, f.owner.ID)
			if err != nil {
				t.Fatalf("user: %v", err)
			}
			gotTier, err := f.svc.effectivePlanIDStrict(ctx, u)
			if err != nil {
				t.Fatalf("strict tier on a healthy store: %v", err)
			}
			if gotTier != wantTier {
				t.Fatalf("effective tier: strict %q, original %q", gotTier, wantTier)
			}

			// The cap, including the mid-month proration.
			wantCap, err := f.svc.monthlyTrafficCap(ctx, f.owner.ID)
			if err != nil {
				t.Fatalf("original cap: %v", err)
			}
			gotCap, err := f.svc.monthlyTrafficCapStrict(ctx, f.owner.ID)
			if err != nil {
				t.Fatalf("strict cap on a healthy store: %v", err)
			}
			if gotCap != wantCap {
				t.Fatalf("monthly traffic cap: strict %d, original %d", gotCap, wantCap)
			}

			// The gate both endpoints actually ask.
			wantSpent, err := f.svc.trafficAllowanceSpent(ctx, f.owner.ID)
			if err != nil {
				t.Fatalf("original spent: %v", err)
			}
			gotSpent, err := f.svc.trafficAllowanceSpentStrict(ctx, f.owner.ID)
			if err != nil {
				t.Fatalf("strict spent on a healthy store: %v", err)
			}
			if gotSpent != wantSpent {
				t.Fatalf("allowance spent: strict %v, original %v (cap %d)", gotSpent, wantSpent, gotCap)
			}

			// And the settings the node budget is read from.
			wantSettings := f.svc.ResolveSettings(ctx)
			gotSettings, err := f.svc.ResolveSettingsStrict(ctx)
			if err != nil {
				t.Fatalf("strict settings on a healthy store: %v", err)
			}
			if gotSettings != wantSettings {
				t.Fatalf("settings: strict %+v, original %+v", gotSettings, wantSettings)
			}
		})
	}
}

// The guard on the guard: with the store healthy the two chains agree, so a
// disagreement can only come from the arithmetic. This pins that the equality
// test above would actually notice one.
func TestStrictEqualityTestWouldNoticeADivergence(t *testing.T) {
	f := newRenewFixture(t)
	accrueMidMonth(t, f, 3<<20)
	setUserPlan(t, f, "plus")
	ctx := context.Background()

	cap, err := f.svc.monthlyTrafficCapStrict(ctx, f.owner.ID)
	if err != nil {
		t.Fatalf("strict cap: %v", err)
	}
	// A prorated segment is neither zero nor the plan's whole nominal cap; if
	// it were either, the equality above would hold for trivial reasons and
	// would not be exercising the branch it names.
	plan, ok, err := f.store.GetPlan(ctx, "plus")
	if err != nil || !ok {
		t.Fatalf("plus plan: %v %v", ok, err)
	}
	if cap <= 0 || cap == plan.TrafficBytes {
		t.Fatalf("proration produced %d against a nominal %d — the branch is not being exercised",
			cap, plan.TrafficBytes)
	}
}
