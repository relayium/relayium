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
// 把 Free 改回 2 GiB 不该在下次调用迁移时被静默覆盖。迁移现在挂在 Service 上
// （MigrateFreeTrafficCap），不再依赖 OpenSQLite 的开关次数，所以用一个
// :memory: store 反复调用它来模拟"多次启动"即可，不需要文件 DB。
func TestFreeTrafficMigrationRunsOnce(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t) // newPlanService 已经跑过 SeedPlans（free=1GiB）

	// 模拟迁移之前的老库：把 free 档手工改回旧值 2 GiB。
	if err := store.UpsertPlan(ctx, Plan{ID: "free", Name: "Free", StorageBytes: 104857600,
		TrafficBytes: 2147483648, RetentionSecs: 259200, Active: true, UpdatedAt: 1}); err != nil {
		t.Fatalf("seed free (old value): %v", err)
	}

	// 第一次"启动"：迁移应该把 2 GiB 降到 1 GiB。
	if err := svc.MigrateFreeTrafficCap(ctx); err != nil {
		t.Fatalf("MigrateFreeTrafficCap (1st run): %v", err)
	}
	p, _, err := store.GetPlan(ctx, "free")
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if p.TrafficBytes != 1073741824 {
		t.Fatalf("after migration free traffic = %d, want 1073741824", p.TrafficBytes)
	}

	// 幂等：再跑一次迁移应该是 no-op（仍是 1 GiB）。
	if err := svc.MigrateFreeTrafficCap(ctx); err != nil {
		t.Fatalf("MigrateFreeTrafficCap (2nd run, idempotent): %v", err)
	}
	p, _, err = store.GetPlan(ctx, "free")
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if p.TrafficBytes != 1073741824 {
		t.Fatalf("idempotent re-run changed free traffic to %d, want 1073741824", p.TrafficBytes)
	}

	// 管理员事后主动改回 2 GiB。
	p.TrafficBytes = 2147483648
	if err := store.UpsertPlan(ctx, p); err != nil {
		t.Fatalf("admin edit: %v", err)
	}

	// 再跑一次迁移（模拟又一次重启）：标记已经烧掉，管理员的 2 GiB 不该被动。
	if err := svc.MigrateFreeTrafficCap(ctx); err != nil {
		t.Fatalf("MigrateFreeTrafficCap (3rd run, post admin edit): %v", err)
	}
	p3, _, err := store.GetPlan(ctx, "free")
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if p3.TrafficBytes != 2147483648 {
		t.Fatalf("admin's 2 GiB was silently overwritten to %d; migration must run only once", p3.TrafficBytes)
	}
}

// 回归测试：修的就是这个缺陷 —— 迁移曾经挂在 OpenSQLite 里，早于 SeedPlans
// 运行；全新安装第一次启动时 plans 表还是空的，UPDATE 影响 0 行，EXISTS 守卫
// 又为假导致标记也没写入。等 SeedPlans 把 free 档种成 1 GiB、管理员随后把它
// 手工调到 2 GiB（正好撞上旧的哨兵值）后，下一次启动那个从未写入的标记仍不
// 存在，free 又恰好等于旧值 —— 迁移被触发，把管理员的设置静默改回 1 GiB。
//
// 现在迁移移到 Service 层、在 SeedPlans 之后调用，跑迁移时 free 档必然已经
// 存在，标记无条件写入，这条时序窗口应该被彻底堵死：全新库播种 → 管理员调到
// 2 GiB → 再跑一次迁移 → 必须仍是 2 GiB。
func TestFreshInstallAdminOverrideSurvivesMigration(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t) // 全新库：newPlanService 内部已跑过 SeedPlans

	p, ok, err := store.GetPlan(ctx, "free")
	if err != nil || !ok {
		t.Fatalf("GetPlan(free) after SeedPlans = %v, ok=%v, err=%v", p, ok, err)
	}
	if p.TrafficBytes != 1073741824 {
		t.Fatalf("freshly seeded free traffic = %d, want 1073741824 (1 GiB)", p.TrafficBytes)
	}

	// 第一次启动跑迁移：free 已经是 1 GiB，迁移应该是 no-op，但要把标记写下。
	if err := svc.MigrateFreeTrafficCap(ctx); err != nil {
		t.Fatalf("MigrateFreeTrafficCap (fresh install): %v", err)
	}

	// 管理员把 Free 调到旧的哨兵值 2 GiB —— 这是他们的主动选择，不是遗留数据。
	p.TrafficBytes = 2147483648
	if err := store.UpsertPlan(ctx, p); err != nil {
		t.Fatalf("admin edit: %v", err)
	}

	// 再次"重启"跑迁移：标记已经存在，2 GiB 不该被覆盖。
	if err := svc.MigrateFreeTrafficCap(ctx); err != nil {
		t.Fatalf("MigrateFreeTrafficCap (post admin edit): %v", err)
	}
	p2, _, err := store.GetPlan(ctx, "free")
	if err != nil {
		t.Fatalf("GetPlan: %v", err)
	}
	if p2.TrafficBytes != 2147483648 {
		t.Fatalf("fresh-install admin override was overwritten to %d; want 2147483648 (2 GiB) preserved", p2.TrafficBytes)
	}
}

// 新列必须能被 GetUserByID 读回来 —— 忘了扩 SELECT/Scan 是这类改动最常见的漏。
// 存量用户是零值，语义上等于"本月没改过档"。
func TestUserQuotaColumnsRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	u, err := store.UpsertUserByEmail(ctx, "a@b.c", "")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	got, err := store.GetUserByID(ctx, u.ID)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if got.PlanStartedAt != 0 || got.QuotaAccruedBytes != 0 || got.QuotaAccruedPeriod != "" {
		t.Fatalf("fresh user quota fields = (%d, %d, %q), want all zero",
			got.PlanStartedAt, got.QuotaAccruedBytes, got.QuotaAccruedPeriod)
	}
}

// monthAt 返回给定 'YYYYMM' 的月首、月末与月长（秒），供比例断言使用。
func monthAt(t *testing.T, period string) (start, end, secs int64) {
	t.Helper()
	start, end = monthRange(period)
	if start == 0 && end == 0 {
		t.Fatalf("monthRange(%q) = 0,0 — malformed period", period)
	}
	return start, end, end - start
}

// 月中升级必须冻结旧档已得的那一段，而不是从零开始重算。
// 时间线（用 1970-01 这个月，因为测试时钟就落在这里）：
//   月首 → t1 是 free 段，t1 → 月末 是 plus 段。
// 冻结值应当是 freeCap × (t1-月首)/月长。
func TestAccrueFreezesPreviousSegment(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t)
	// InsertUser isn't a real Store method (see quota_proration_test.go's
	// existing TestUserQuotaColumnsRoundTrip / task 2's report for the same
	// substitution): use UpsertUserByEmail and its generated id instead.
	newUser, err := store.UpsertUserByEmail(ctx, "a@b.c", "")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	uid := newUser.ID
	monthStart, _, monthSecs := monthAt(t, periodOf(svc.now().Unix()))
	t1 := monthStart + monthSecs/2 // 月中

	if err := store.SetUserPlan(ctx, uid, "plus", t1); err != nil {
		t.Fatalf("SetUserPlan: %v", err)
	}
	u, err := store.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	freeCap := int64(1073741824)
	want := freeCap/monthSecs*(monthSecs/2) + (freeCap%monthSecs)*(monthSecs/2)/monthSecs
	if u.QuotaAccruedBytes != want {
		t.Fatalf("accrued = %d, want %d (free cap × half a month)", u.QuotaAccruedBytes, want)
	}
	if u.PlanStartedAt != t1 {
		t.Fatalf("plan_started_at = %d, want %d", u.PlanStartedAt, t1)
	}
	if u.QuotaAccruedPeriod != periodOf(t1) {
		t.Fatalf("accrued period = %q, want %q", u.QuotaAccruedPeriod, periodOf(t1))
	}
	if u.PlanID != "plus" {
		t.Fatalf("plan_id = %q, want plus", u.PlanID)
	}
}

// 档位没变时不得累计。Stripe 的 subscription.updated 会在纯状态变更（比如
// 续费成功）时反复投递同一个 plan_id；每次都切一段虽然数学上等价，但整数
// 除法的截断会一点点吃掉用户的额度。
func TestAccrueSkipsWhenPlanUnchanged(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t)
	newUser, err := store.UpsertUserByEmail(ctx, "a@b.c", "")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	uid := newUser.ID
	monthStart, _, monthSecs := monthAt(t, periodOf(svc.now().Unix()))
	t1 := monthStart + monthSecs/2

	if err := store.SetUserPlan(ctx, uid, "plus", t1); err != nil {
		t.Fatalf("SetUserPlan 1: %v", err)
	}
	first, _ := store.GetUserByID(ctx, uid)

	// 同一个档再写一次，晚 1000 秒。
	if err := store.SetUserSubscription(ctx, uid, "plus", "active", 0, "stripe", t1+1000); err != nil {
		t.Fatalf("SetUserSubscription: %v", err)
	}
	second, _ := store.GetUserByID(ctx, uid)

	if second.QuotaAccruedBytes != first.QuotaAccruedBytes {
		t.Fatalf("accrued changed on a no-op plan write: %d → %d",
			first.QuotaAccruedBytes, second.QuotaAccruedBytes)
	}
	if second.PlanStartedAt != first.PlanStartedAt {
		t.Fatalf("plan_started_at moved on a no-op plan write: %d → %d",
			first.PlanStartedAt, second.PlanStartedAt)
	}
}

// 跨月的累计值必须作废：上个月冻结的额度不能带进新的一个月。
func TestAccrueDropsStaleMonth(t *testing.T) {
	ctx := context.Background()
	_, store := newPlanService(t)
	newUser, err := store.UpsertUserByEmail(ctx, "a@b.c", "")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	uid := newUser.ID
	janStart, janEnd, janSecs := monthAt(t, "197001")
	if err := store.SetUserPlan(ctx, uid, "plus", janStart+janSecs/2); err != nil {
		t.Fatalf("SetUserPlan jan: %v", err)
	}
	// 二月里再改一次档。一月冻结的那笔必须被丢弃。
	febMid := janEnd + 3600
	if err := store.SetUserPlan(ctx, uid, "pro", febMid); err != nil {
		t.Fatalf("SetUserPlan feb: %v", err)
	}
	u, _ := store.GetUserByID(ctx, uid)
	if u.QuotaAccruedPeriod != periodOf(febMid) {
		t.Fatalf("accrued period = %q, want %q", u.QuotaAccruedPeriod, periodOf(febMid))
	}
	febStart, _, febSecs := monthAt(t, periodOf(febMid))
	plusCap := int64(300) << 30
	seg := febMid - febStart
	want := plusCap/febSecs*seg + (plusCap%febSecs)*seg/febSecs
	if u.QuotaAccruedBytes != want {
		t.Fatalf("accrued = %d, want %d (february's plus segment only)", u.QuotaAccruedBytes, want)
	}
}

// admin 手工改档是三个改档入口里唯一不经 Stripe 的一条，必须同样冻结前一段
// ——漏掉它，管理员给用户提档就成了绕过防套利的后门。
func TestAccrueOnAdminPlanChange(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t)
	newUser, err := store.UpsertUserByEmail(ctx, "a@b.c", "")
	if err != nil {
		t.Fatalf("UpsertUserByEmail: %v", err)
	}
	uid := newUser.ID
	monthStart, _, monthSecs := monthAt(t, periodOf(svc.now().Unix()))
	t1 := monthStart + monthSecs/2

	if err := store.SetUserPlanAdmin(ctx, uid, "pro", t1); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}
	u, err := store.GetUserByID(ctx, uid)
	if err != nil {
		t.Fatalf("GetUserByID: %v", err)
	}
	if u.PlanStartedAt != t1 || u.QuotaAccruedPeriod != periodOf(t1) {
		t.Fatalf("admin change did not stamp the segment: started=%d period=%q",
			u.PlanStartedAt, u.QuotaAccruedPeriod)
	}
	freeCap := int64(1073741824)
	want := freeCap/monthSecs*(monthSecs/2) + (freeCap%monthSecs)*(monthSecs/2)/monthSecs
	if u.QuotaAccruedBytes != want {
		t.Fatalf("accrued = %d, want %d", u.QuotaAccruedBytes, want)
	}
	// admin 路径既有的副作用必须保留。
	if u.PlanSource != "admin" || u.SubscriptionStatus != "" || u.SubscriptionEnd != 0 {
		t.Fatalf("admin path lost its existing side effects: source=%q status=%q end=%d",
			u.PlanSource, u.SubscriptionStatus, u.SubscriptionEnd)
	}
}
