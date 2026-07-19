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
//
//	月首 → t1 是 free 段，t1 → 月末 是 plus 段。
//
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

// TestProrate 直接测 prorate 本身。上面几条 TestAccrue* 只是通过
// accrueQuotaTx 间接跑到它，覆盖不到两条它独有、受 spec 约束的行为：无限档
// 不贡献累计、以及大 cap × 大 segSecs 不溢出。
func TestProrate(t *testing.T) {
	cases := []struct {
		name                         string
		capBytes, segSecs, monthSecs int64
		check                        func(t *testing.T, got int64)
	}{
		{
			// cap<=0 在整个代码库里表示"无限档"；用户离开无限档后，那一段
			// 不该折算出任何累计，否则无限档反而变成有限档里额度最高的那个。
			name:     "unlimited tier contributes nothing",
			capBytes: 0, segSecs: 1000, monthSecs: 2000,
			check: wantExact(0),
		},
		{
			// 同上，负值也必须按"无限"处理，不能被当成有效上限带出负累计。
			name:     "negative cap treated as unlimited",
			capBytes: -1, segSecs: 1000, monthSecs: 2000,
			check: wantExact(0),
		},
		{
			// 空段（比如两次改档时间戳相同）不该凭空长出额度。
			name:     "zero-length segment earns nothing",
			capBytes: 1000, segSecs: 0, monthSecs: 2000,
			check: wantExact(0),
		},
		{
			// 负的段长是调用方的 bug，但 prorate 自己也得兜底，不能算出负数
			// 或者除零 panic。
			name:     "negative segSecs guarded",
			capBytes: 1000, segSecs: -1, monthSecs: 2000,
			check: wantExact(0),
		},
		{
			// monthSecs<=0（比如 monthRange 解析失败返回 0,0）必须短路，
			// 否则下面的除法直接除零 panic。
			name:     "zero monthSecs guarded (would otherwise divide by zero)",
			capBytes: 1000, segSecs: 500, monthSecs: 0,
			check: wantExact(0),
		},
		{
			// 整段等于整月：应当拿到档位的全部上限，一分不多一分不少。
			name:     "full month earns the whole cap",
			capBytes: 12345, segSecs: 2592000, monthSecs: 2592000,
			check: wantExact(12345),
		},
		{
			// 半个月应该约等于一半——留一点余量给整数除法的截断。
			name:     "half month earns about half the cap",
			capBytes: 1000000, segSecs: 1296000, monthSecs: 2592000,
			check: wantApprox(500000, 1),
		},
		{
			// 溢出安全：cap=5 TiB、几乎整月的段，朴素的 cap*segSecs 会先算出
			// ≈1.3e19，超过 int64 上限 9.2e18 直接溢出成负数或荒谬的大数。
			// prorate 的先除后乘必须躲开这一步，结果应当为正且不超过 cap。
			name:     "large cap × near-full-month segment does not overflow",
			capBytes: 5 << 40, segSecs: 31*86400 - 1, monthSecs: 31 * 86400,
			check: func(t *testing.T, got int64) {
				t.Helper()
				capBytes := int64(5 << 40)
				if got <= 0 {
					t.Fatalf("prorate(5TiB, monthSecs-1, monthSecs) = %d, want positive (overflow?)", got)
				}
				if got > capBytes {
					t.Fatalf("prorate(5TiB, monthSecs-1, monthSecs) = %d, want <= cap %d", got, capBytes)
				}
			},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := prorate(c.capBytes, c.segSecs, c.monthSecs)
			c.check(t, got)
		})
	}

	// 一致性检查：在不会溢出的小输入上，prorate 必须和"先乘后除"的朴素算法
	// 给出完全一样的结果——两段式拆分只是为了避开溢出，不能改变截断行为，
	// 否则写路径（accrueQuotaTx）和读路径（monthlyTrafficCap）对同一笔额度
	// 的算法要是碰巧走到不同分支，就会悄悄对不上。
	t.Run("matches naive cap*segSecs/monthSecs on small inputs", func(t *testing.T) {
		small := []struct{ capBytes, segSecs, monthSecs int64 }{
			{1073741824, 1296000, 2592000},  // 1 GiB 档，半个月
			{322122547200, 700000, 2678400}, // 300 GiB 档（plus 月流量），任意段
			{7, 3, 5},                       // 会产生非零余数的小数字
			{1000000, 2592000, 2592000},     // 整段等于整月
		}
		for _, s := range small {
			got := prorate(s.capBytes, s.segSecs, s.monthSecs)
			want := s.capBytes * s.segSecs / s.monthSecs
			if got != want {
				t.Fatalf("prorate(%d, %d, %d) = %d, want %d (naive cap*segSecs/monthSecs)",
					s.capBytes, s.segSecs, s.monthSecs, got, want)
			}
		}
	})
}

// wantExact 断言 prorate 的结果恰好等于 want。
func wantExact(want int64) func(t *testing.T, got int64) {
	return func(t *testing.T, got int64) {
		t.Helper()
		if got != want {
			t.Fatalf("prorate result = %d, want exactly %d", got, want)
		}
	}
}

// wantApprox 断言 prorate 的结果落在 [want-tolerance, want+tolerance] 区间内，
// 用于半个月这类必然带整数除法截断误差的场景。
func wantApprox(want, tolerance int64) func(t *testing.T, got int64) {
	return func(t *testing.T, got int64) {
		t.Helper()
		diff := got - want
		if diff < -tolerance || diff > tolerance {
			t.Fatalf("prorate result = %d, want within ±%d of %d", got, tolerance, want)
		}
	}
}
