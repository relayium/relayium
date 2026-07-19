# 免费额度调整、月中改档防套利与用户侧用量可见性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把免费档月流量从 2 GiB 下调到 1 GiB，堵住"月末按比例升级白拿整月额度"的线上套利漏洞，并让用户在个人中心看到当月用量、在接近上限时收到提醒。

**Architecture:** 三层改动。存储层在 `users` 表加三列记录"当前档从何时生效 + 本月此前各段已累计的额度"，并把累计动作塞进现有的三个 plan 写入方法内部（事务内），使得 webhook / admin / 站内升降级三个 HTTP 调用点几乎不用改。服务层新增 `monthlyTrafficCap()` 作为 `overTraffic()` 的唯一 cap 来源，并暴露 `GET /api/me/usage`。前端在个人中心加两条进度条，并用一个自取数的独立组件 `QuotaNotice.svelte` 在传输界面渲染 80% 提醒条。

**Tech Stack:** Go 1.22+（`net/http` 方法前缀路由、`database/sql` + modernc sqlite）、Svelte 5 runes、TypeScript、Vitest。

## Global Constraints

- Spec：`docs/superpowers/specs/2026-07-19-quota-free-tier-and-usage-visibility-design.md`。有冲突以 spec 为准。
- **不改**订阅模式、`periodOf()` / `monthRange()` 语义、付费三档数值、以及"免费额度 + 套餐额度叠加"（明确不做叠加）。
- 分段累加**只对流量生效**。存储不按比例发放，改档后立即是新档全额。
- `cap <= 0` 一律表示"无限"，这个既有约定在所有新代码中保持。
- 配额门保持 **fail-open**：真实的 store 错误向上传播让门放行，不得误判成 Free（`plan_enforce.go:11-13`）。
- 本仓注释密度很高，且大量注释解释"为什么"而非"是什么"。新代码必须匹配这个风格（`CONTRIBUTING.md:51-56`）。
- Commit 前缀用 conventional commits：`feat(server):` / `fix(server):` / `feat(web):`。
- i18n 共 9 种语言：`zh, en, ja, ko, de, fr, ar, es, pt`。新增 key 必须九个文件全部补齐，否则 `npm run check` 会报错。
- 测试命令：`cd server && go test ./...`；`cd web && npx vitest run && npm run check`。
- 单位常量：1 GiB = `1073741824`，2 GiB = `2147483648`。

---

## Pre-flight（无代码，开工前由人执行一次）

**验证线上 `plans` 表的 `stripe_price_yearly_id` 是否配置。** 年付 UI 已存在于 `web/src/lib/Pricing.svelte`，若 price id 为空，用户点年付会失败。

在生产库上执行：

```sql
SELECT id, stripe_price_monthly_id, stripe_price_yearly_id FROM plans WHERE id != 'free';
```

- 三行的 `stripe_price_yearly_id` 均非空 → 保留年付，本计划无额外任务。
- 存在空值 → 从 `Pricing.svelte` 撤掉年付切换，作为独立的一次改动，**不属于本计划范围**，另开任务。

---

## File Structure

**新建**

| 文件 | 职责 |
| --- | --- |
| `server/internal/account/quota_proration_test.go` | 分段累加的读写两侧测试 |
| `server/internal/account/me_usage_test.go` | `GET /api/me/usage` 的 HTTP 测试 |
| `web/src/lib/QuotaNotice.svelte` | 自取数的 80% 提醒条，供传输界面渲染 |
| `web/src/lib/QuotaMeters.svelte` | 个人中心的两条用量进度条 |

**修改**

| 文件 | 改动 |
| --- | --- |
| `server/internal/account/settings.go:203` | Free 档 `TrafficBytes` 2 GiB → 1 GiB |
| `server/internal/account/sqlite.go` | ALTER 加三列；一次性迁移；`GetUserByID` 扩列；`accrueQuotaTx`；三个 plan 写入方法改事务 |
| `server/internal/account/store.go` | `User` 加三字段；三个 plan 写入方法签名加 `now int64` |
| `server/internal/account/plan_enforce.go` | 新增 `monthlyTrafficCap`；`overTraffic` 改用它 |
| `server/internal/account/handlers.go` | 注册 `GET /api/me/usage`；新增 `handleMeUsage` |
| `server/internal/account/billing.go` | 三处 `SetUserSubscription` 调用加 `now` 实参 |
| `server/internal/account/admin.go` | `SetUserPlanAdmin` 调用加 `now` 实参 |
| `web/src/lib/i18n/types.ts` | 新增 `quota` 消息组 |
| `web/src/lib/i18n/{zh,en,ja,ko,de,fr,ar,es,pt}.ts` | 补齐 `quota` 组 |
| `web/src/lib/MePage.svelte` | 渲染 `QuotaMeters` |
| `web/src/App.svelte:1300` | 在 `transferSurface` 里渲染 `QuotaNotice` |

**设计要点：为什么把累计逻辑放进 store 方法内部**

三个改档入口走三个不同的 store 方法（`billing.go:346/373` → `SetUserSubscription`，`admin.go:595` → `SetUserPlanAdmin`，测试/播种 → `SetUserPlan`），而 `handleBillingChangePlan` 根本不写 `plan_id`（它只调 Stripe 并写 `scheduled_plan_id` 这个展示提示，webhook 才是唯一权威）。把累计塞进这三个方法内部、与 `UPDATE users SET plan_id` 同事务，既满足 spec 的原子性要求，又让 HTTP 层只需多传一个 `now` 实参。若改为在 handler 里额外调一次 store，会出现"累计已写、plan_id 未写"的崩溃窗口。

---

### Task 1: Free 档降到 1 GiB + 一次性迁移

**Files:**
- Modify: `server/internal/account/settings.go:203`
- Modify: `server/internal/account/sqlite.go`（`OpenSQLite` 内，紧接 `max_downloads` 回填之后）
- Test: `server/internal/account/quota_proration_test.go`（新建）

**Interfaces:**
- Consumes: 无
- Produces: 无新导出符号。行为契约：新库 Free 档 `TrafficBytes == 1073741824`；老库若 Free 仍为 2 GiB 则被改成 1 GiB，且只改一次。

- [ ] **Step 1: 写失败测试**

新建 `server/internal/account/quota_proration_test.go`：

```go
package account

import (
	"context"
	"testing"
)

// Free 档的月流量在 2026-07 从 2 GiB 降到 1 GiB。新库直接由 defaultPlans 播种。
func TestFreePlanTrafficIsOneGiB(t *testing.T) {
	svc, store := newPlanService(t)
	_ = svc
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/account/ -run 'TestFreePlanTrafficIsOneGiB|TestFreeTrafficMigrationRunsOnce' -v`
Expected: FAIL —— `free traffic = 2147483648, want 1073741824`

- [ ] **Step 3: 改默认档值**

`server/internal/account/settings.go:203`，把 `TrafficBytes: 2 * gb` 改为 `1 * gb`：

```go
		{ID: "free", Name: "Free", StorageBytes: 100 * mb, TrafficBytes: 1 * gb, RetentionSecs: 3 * day, PriceMonthly: 0, PriceYearly: 0, SortOrder: 0, Active: true},
```

- [ ] **Step 4: 加一次性迁移**

`server/internal/account/sqlite.go`，在 `OpenSQLite` 里 `UPDATE stored_files SET max_downloads = 1 ...` 那段之后插入：

```go
	// One-shot: 2026-07 定价调整把 Free 档月流量从 2 GiB 降到 1 GiB。
	//
	// SeedPlans 只在 plan id 不存在时写入（保护管理员的手工编辑），所以光改
	// defaultPlans() 对已上线的库无效，必须在这里显式改一次。
	//
	// 用 settings 里的一次性标记而不是只靠值判断：如果管理员之后主动把 Free
	// 设回 2 GiB，纯值判断会在下次启动时静默改回 1 GiB，等于管理员永远改不动
	// 这个数。值判断仍然保留 —— 管理员若已经把 Free 挪到别的数，我们不动它的
	// 数字，只把标记烧掉。
	//
	// 顺序不能反：先 UPDATE 再写标记。反过来会让 UPDATE 的 NOT EXISTS 立刻为
	// 假，迁移永远不执行。
	if _, err := db.ExecContext(context.Background(),
		`UPDATE plans SET traffic_bytes = 1073741824, updated_at = ?
		   WHERE id = 'free' AND traffic_bytes = 2147483648
		     AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'migration.free_traffic_1gib')`,
		time.Now().Unix()); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.ExecContext(context.Background(),
		`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('migration.free_traffic_1gib', 1, ?)`,
		time.Now().Unix()); err != nil {
		db.Close()
		return nil, err
	}
```

`time` 已在 `sqlite.go` 导入（`periodOf` 用到），无需改 import。这里直接用 `time.Now()` 是可以的：这是启动期的一次性 DDL，不参与任何被测试注入时钟的业务路径。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && go test ./internal/account/ -run 'TestFreePlanTrafficIsOneGiB|TestFreeTrafficMigrationRunsOnce' -v`
Expected: PASS（两个都 ok）

- [ ] **Step 6: 跑全量测试**

Run: `cd server && go test ./...`
Expected: ok —— 如果有测试硬编码了 Free = 2 GiB，改成 1 GiB（`grep -rn "2147483648\|2 \* gb" internal/account/*_test.go`）

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/settings.go server/internal/account/sqlite.go server/internal/account/quota_proration_test.go
git commit -m "feat(server): 免费档月流量 2 GiB 降至 1 GiB，含一次性幂等迁移"
```

---

### Task 2: `users` 表加配额分段列

**Files:**
- Modify: `server/internal/account/sqlite.go`（ALTER 循环、`GetUserByID`）
- Modify: `server/internal/account/store.go`（`User` 结构体）
- Test: `server/internal/account/quota_proration_test.go`

**Interfaces:**
- Consumes: Task 1 的迁移模式
- Produces: `User` 新增三个字段，供 Task 3/4 使用：
  - `PlanStartedAt int64` — 当前档生效时刻（unix 秒），0 = 从未改过档
  - `QuotaAccruedBytes int64` — 本月此前各段已累计的流量额度
  - `QuotaAccruedPeriod string` — 上述累计值所属的 `'YYYYMM'`；与当前 period 不符即视为过期

- [ ] **Step 1: 写失败测试**

追加到 `server/internal/account/quota_proration_test.go`：

```go
// 新列必须能被 GetUserByID 读回来 —— 忘了扩 SELECT/Scan 是这类改动最常见的漏。
// 存量用户是零值，语义上等于"本月没改过档"。
func TestUserQuotaColumnsRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	u, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, "")
	if err != nil {
		t.Fatalf("InsertUser: %v", err)
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
```

`InsertUser` 的确切签名以 `store.go` 的 `// users + identities` 段为准；若与上面不符，照实际签名调整这一行（其余断言不变）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/account/ -run TestUserQuotaColumnsRoundTrip -v`
Expected: FAIL —— 编译错误 `got.PlanStartedAt undefined`

- [ ] **Step 3: 加三个字段**

`server/internal/account/store.go`，在 `User` 结构体的 `ScheduledPlanID` 之后追加：

```go
	// PlanStartedAt 是当前档位生效的时刻（unix 秒）；0 表示从未改过档。
	// 与 QuotaAccrued* 一起把当月切成若干"档位段"，用来给月中改档的用户按段
	// 计算流量上限，而不是每次改档都白送一整个月的额度。
	PlanStartedAt int64
	// QuotaAccruedBytes 是本月 PlanStartedAt 之前那些已结束的段累计下来的流量
	// 额度（每段 = 该段档位上限 × 该段占全月的比例）。
	QuotaAccruedBytes int64
	// QuotaAccruedPeriod 是 QuotaAccruedBytes 所属的 'YYYYMM' 桶。与当前月份不
	// 符即视为过期作废，用户直接拿当前档的整月上限——这也让存量用户（三列全为
	// 零值）天然走满额分支，无需回填。
	QuotaAccruedPeriod string
```

- [ ] **Step 4: 加 ALTER**

`server/internal/account/sqlite.go`，在 ALTER 字符串切片的末尾（`scheduled_plan_id` 那条之后）追加：

```go
		// 配额防套利（2026-07）：月中改档不再白送整月流量额度，而是把当月按档位
		// 分段、每段按占比计算。见 accrueQuotaTx 与 Service.monthlyTrafficCap。
		`ALTER TABLE users ADD COLUMN plan_started_at INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN quota_accrued_bytes INTEGER NOT NULL DEFAULT 0`,
		`ALTER TABLE users ADD COLUMN quota_accrued_period TEXT NOT NULL DEFAULT ''`,
```

零值即"本月没改过档"，因此**不需要任何回填 UPDATE**。

- [ ] **Step 5: 扩 `GetUserByID`**

`server/internal/account/sqlite.go:596`，SELECT 列表与 Scan 参数同步加三项：

```go
func (s *SQLiteStore) GetUserByID(ctx context.Context, id string) (User, error) {
	var u User
	var strict int
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, only_own_nodes, deleted_at, purge_after, plan_id,
		        stripe_customer_id, subscription_status, subscription_end, plan_source, scheduled_plan_id,
		        plan_started_at, quota_accrued_bytes, quota_accrued_period
		   FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &strict, &u.DeletedAt, &u.PurgeAfter, &u.PlanID,
		&u.StripeCustomerID, &u.SubscriptionStatus, &u.SubscriptionEnd, &u.PlanSource, &u.ScheduledPlanID,
		&u.PlanStartedAt, &u.QuotaAccruedBytes, &u.QuotaAccruedPeriod)
	if err == sql.ErrNoRows {
		return User{}, ErrNotFound
	}
	u.OnlyOwnNodes = strict != 0
	return u, err
}
```

**只改 `GetUserByID`。** 其它 `SELECT ... FROM users` 站点（`GetUserByStripeCustomer`、`ListUsersToPurge`、`ListUsersToRemind`、`UserByCanonicalEmail` 等）各自扫进自己的字段列表，不读新列就不需要动——本计划的读路径只经 `GetUserByID`。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd server && go test ./internal/account/ -run TestUserQuotaColumnsRoundTrip -v`
Expected: PASS

- [ ] **Step 7: 跑全量测试**

Run: `cd server && go test ./...`
Expected: ok

- [ ] **Step 8: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/quota_proration_test.go
git commit -m "feat(server): users 表新增配额分段列 plan_started_at/quota_accrued_*"
```

---

### Task 3: 改档时冻结已得额度（写路径）

**Files:**
- Modify: `server/internal/account/sqlite.go`（新增 `accrueQuotaTx`；改 `SetUserPlan` / `SetUserPlanAdmin` / `SetUserSubscription`）
- Modify: `server/internal/account/store.go`（三个方法签名加 `now int64`）
- Modify: `server/internal/account/billing.go:330, 346, 373`
- Modify: `server/internal/account/admin.go:595`
- Test: `server/internal/account/quota_proration_test.go`

**Interfaces:**
- Consumes: Task 2 的三个 `User` 字段
- Produces:
  - `func accrueQuotaTx(ctx context.Context, tx *sql.Tx, userID, newPlanID string, now int64) error`（包内私有）
  - Store 接口签名变更，Task 4/5 依赖 `GetUserByID` 读到的值已由此写入：
    - `SetUserPlan(ctx context.Context, userID, planID string, now int64) error`
    - `SetUserPlanAdmin(ctx context.Context, userID, planID string, now int64) error`
    - `SetUserSubscription(ctx context.Context, userID, planID, status string, end int64, source string, now int64) error`

- [ ] **Step 1: 写失败测试**

追加到 `server/internal/account/quota_proration_test.go`：

```go
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
	if _, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, ""); err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	monthStart, _, monthSecs := monthAt(t, periodOf(svc.now().Unix()))
	t1 := monthStart + monthSecs/2 // 月中

	if err := store.SetUserPlan(ctx, "u1", "plus", t1); err != nil {
		t.Fatalf("SetUserPlan: %v", err)
	}
	u, err := store.GetUserByID(ctx, "u1")
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
	if _, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, ""); err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	monthStart, _, monthSecs := monthAt(t, periodOf(svc.now().Unix()))
	t1 := monthStart + monthSecs/2

	if err := store.SetUserPlan(ctx, "u1", "plus", t1); err != nil {
		t.Fatalf("SetUserPlan 1: %v", err)
	}
	first, _ := store.GetUserByID(ctx, "u1")

	// 同一个档再写一次，晚 1000 秒。
	if err := store.SetUserSubscription(ctx, "u1", "plus", "active", 0, "stripe", t1+1000); err != nil {
		t.Fatalf("SetUserSubscription: %v", err)
	}
	second, _ := store.GetUserByID(ctx, "u1")

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
	if _, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, ""); err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	janStart, janEnd, janSecs := monthAt(t, "197001")
	if err := store.SetUserPlan(ctx, "u1", "plus", janStart+janSecs/2); err != nil {
		t.Fatalf("SetUserPlan jan: %v", err)
	}
	// 二月里再改一次档。一月冻结的那笔必须被丢弃。
	febMid := janEnd + 3600
	if err := store.SetUserPlan(ctx, "u1", "pro", febMid); err != nil {
		t.Fatalf("SetUserPlan feb: %v", err)
	}
	u, _ := store.GetUserByID(ctx, "u1")
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
	if _, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, ""); err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	monthStart, _, monthSecs := monthAt(t, periodOf(svc.now().Unix()))
	t1 := monthStart + monthSecs/2

	if err := store.SetUserPlanAdmin(ctx, "u1", "pro", t1); err != nil {
		t.Fatalf("SetUserPlanAdmin: %v", err)
	}
	u, err := store.GetUserByID(ctx, "u1")
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
```

**关于事务性**：`accrueQuotaTx` 与 `UPDATE users SET plan_id` 的原子性靠 `BeginTx` + `defer tx.Rollback()` 保证，没有为它单写测试——要触发"累计已提交、plan_id 未提交"需要在两条语句之间注入故障，而 `SQLiteStore` 没有暴露这样的接缝，硬造接缝的成本高于收益。评审时请人工确认三个方法都是「BeginTx → accrue → UPDATE → Commit」这个形状，且 `defer tx.Rollback()` 在 `BeginTx` 错误检查之后。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/account/ -run 'TestAccrue' -v`
Expected: FAIL —— 编译错误 `too many arguments in call to store.SetUserPlan`

- [ ] **Step 3: 实现 `accrueQuotaTx`**

`server/internal/account/sqlite.go`，加在 `SetUserPlan` 之前：

```go
// accrueQuotaTx 冻结用户在**当前**档位下已经挣到的那部分流量额度，然后把新段
// 的起点打上时间戳。必须在同一个事务里、并且在覆盖 plan_id **之前**调用——
// 覆盖之后就读不到改档前的档位了。
//
// 当月的流量上限 = Σ(各档位段的 cap × 该段秒数 / 当月秒数)。每次改档都冻结一
// 次，是为了堵住这个套利：31 号从 Plus 升到 Max，Stripe 只按 ~2/31 的比例收
// 几毛钱差价，但按整月发额度的话用户当场白拿一整个 Max 月的流量。
//
// 三条短路：
//   1. 档位没变 → 直接返回。Stripe 的 subscription.updated 会在纯状态变更时
//      反复投递同一个 plan_id；每次切段数学上等价，但整数除法的截断会一点点
//      蚕食用户额度。
//   2. 累计值属于上个月 → 归零。上月冻结的额度不能带进新月份。
//   3. 旧档是无限档（traffic_bytes <= 0）→ 不贡献任何累计。cap<=0 在别处一律
//      表示"无限"，用户离开该档后本月应当回落到新档的普通比例，而不是继承一
//      个无意义的天文数字。
func accrueQuotaTx(ctx context.Context, tx *sql.Tx, userID, newPlanID string, now int64) error {
	var curPlan, accruedPeriod string
	var startedAt, accrued int64
	err := tx.QueryRowContext(ctx,
		`SELECT plan_id, plan_started_at, quota_accrued_bytes, quota_accrued_period
		   FROM users WHERE id = ?`, userID).
		Scan(&curPlan, &startedAt, &accrued, &accruedPeriod)
	if err == sql.ErrNoRows {
		return nil // 用户不存在：让后面的 UPDATE 自己去影响 0 行，语义不变
	}
	if err != nil {
		return err
	}
	if curPlan == newPlanID {
		return nil
	}

	period := periodOf(now)
	monthStart, monthEnd := monthRange(period)
	if accruedPeriod != period {
		accrued = 0
	}

	var cap sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT traffic_bytes FROM plans WHERE id = ?`, curPlan).Scan(&cap); err != nil && err != sql.ErrNoRows {
		return err
	}

	segStart := startedAt
	if segStart < monthStart {
		segStart = monthStart // 上个月就开始的段，本月只从月首算起
	}
	monthSecs := monthEnd - monthStart
	segSecs := now - segStart
	if cap.Valid && cap.Int64 > 0 && segSecs > 0 && monthSecs > 0 {
		// 先除后乘，避免 cap × segSecs 溢出：5 TiB × 2.6e6 秒 ≈ 1.4e19 > int64
		// 上限。拆成商部分和余数部分两段相加，结果与直接乘除的整数除法一致。
		accrued += cap.Int64/monthSecs*segSecs + (cap.Int64%monthSecs)*segSecs/monthSecs
	}

	_, err = tx.ExecContext(ctx,
		`UPDATE users SET quota_accrued_bytes = ?, quota_accrued_period = ?, plan_started_at = ? WHERE id = ?`,
		accrued, period, now, userID)
	return err
}
```

- [ ] **Step 4: 三个写入方法改成事务**

`server/internal/account/sqlite.go`，替换 `SetUserPlan`（:617）、`SetUserPlanAdmin`（:623）、`SetUserSubscription`（:674）三个方法体。**保留各自原有的文档注释**，只在末尾补一句说明累计。

```go
func (s *SQLiteStore) SetUserPlan(ctx context.Context, userID, planID string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // Commit 成功后是 no-op
	if err := accrueQuotaTx(ctx, tx, userID, planID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE users SET plan_id = ? WHERE id = ?`, planID, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLiteStore) SetUserPlanAdmin(ctx context.Context, userID, planID string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := accrueQuotaTx(ctx, tx, userID, planID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET plan_id = ?, plan_source = 'admin', subscription_status = '', subscription_end = 0 WHERE id = ?`,
		planID, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLiteStore) SetUserSubscription(ctx context.Context, userID, planID, status string, end int64, source string, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := accrueQuotaTx(ctx, tx, userID, planID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET plan_id = ?, subscription_status = ?, subscription_end = ?, plan_source = ? WHERE id = ?`,
		planID, status, end, source, userID); err != nil {
		return err
	}
	return tx.Commit()
}
```

在每个方法的注释末尾补一句：

```go
// 累计与 plan_id 的写入放在同一事务里：如果两者分开，进程在中间崩溃会留下
// "额度已冻结但档位没变"或反之的脏状态，用户的当月上限就永久算错了。
```

- [ ] **Step 5: 同步接口签名**

`server/internal/account/store.go:358-372`，三行改为：

```go
	// SetUserPlan assigns a user's billing tier (plans.id). now is the change
	// timestamp, used to freeze the outgoing tier's earned quota segment.
	SetUserPlan(ctx context.Context, userID, planID string, now int64) error
	// SetUserPlanAdmin assigns a user's billing tier from the admin console,
	// recording plan_source='admin' so a later Stripe webhook won't override it.
	SetUserPlanAdmin(ctx context.Context, userID, planID string, now int64) error
```

```go
	// SetUserSubscription updates plan_id, subscription_status, subscription_end,
	// and plan_source together (Stripe webhook path). now is the change timestamp,
	// used to freeze the outgoing tier's earned quota segment.
	SetUserSubscription(ctx context.Context, userID, planID, status string, end int64, source string, now int64) error
```

- [ ] **Step 6: 更新四个调用点**

`server/internal/account/billing.go` 三处，各加最后一个实参 `s.now().Unix()`：

- `:330` → `s.store.SetUserSubscription(ctx, u.ID, u.PlanID, ev.Status, ev.CurrentPeriodEnd, "admin", s.now().Unix())`
- `:346` → `s.store.SetUserSubscription(ctx, u.ID, planID, ev.Status, ev.CurrentPeriodEnd, "stripe", s.now().Unix())`
- `:373` → `s.store.SetUserSubscription(ctx, u.ID, planID, "canceled", ev.CurrentPeriodEnd, source, s.now().Unix())`

`server/internal/account/admin.go:595` → `s.store.SetUserPlanAdmin(r.Context(), <userID 变量>, <planID 变量>, s.now().Unix())`（保留原有的实参名）。

`handleBillingChangePlan` **不用动**——它只调 Stripe 并写 `scheduled_plan_id`，不写 `plan_id`；真正的档位变更由 webhook 落库。

- [ ] **Step 7: 修其余编译错误**

Run: `cd server && go build ./...`
Expected: 若有测试或播种代码调用这三个方法，编译器会逐个指出；一律补 `now` 实参（测试里用 `svc.now().Unix()` 或一个显式常量）。

因为测试替身都是**内嵌 `Store` 接口**的包装器（`plan_enforce_test.go:66`、`webhook_test.go:463`），只覆盖单个方法，签名变更不会波及它们。

- [ ] **Step 8: 跑测试确认通过**

Run: `cd server && go test ./internal/account/ -run 'TestAccrue' -v`
Expected: PASS（四个都 ok）

- [ ] **Step 9: 跑全量测试**

Run: `cd server && go test ./...`
Expected: ok

- [ ] **Step 10: Commit**

```bash
git add server/internal/account/
git commit -m "feat(server): 改档时按段冻结已得流量额度，堵住月末按比例升级套利"
```

---

### Task 4: 分段计算当月流量上限（读路径）

**Files:**
- Modify: `server/internal/account/plan_enforce.go`
- Test: `server/internal/account/quota_proration_test.go`

**Interfaces:**
- Consumes: Task 2 的 `User` 字段、Task 3 写入的值
- Produces: `func (s *Service) monthlyTrafficCap(ctx context.Context, userID string) (int64, error)` —— 返回值 `<= 0` 表示无限。Task 5 直接调用它。

- [ ] **Step 1: 写失败测试**

追加到 `server/internal/account/quota_proration_test.go`：

```go
// 本月没改过档的用户走满额分支 —— 绝大多数用户都在这条路上，不能有任何折扣。
func TestMonthlyCapFullWhenNoChangeThisMonth(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t)
	if _, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, ""); err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	cap, err := svc.monthlyTrafficCap(ctx, "u1")
	if err != nil {
		t.Fatalf("monthlyTrafficCap: %v", err)
	}
	if cap != 1073741824 {
		t.Fatalf("cap = %d, want 1073741824 (full free tier)", cap)
	}
}

// 月中升级的当月上限 = 旧档冻结的那段 + 新档剩余那段。这正是 spec 里那个例子：
// 单纯按比例只给新档的一小段，会让月中超额的用户升级后几乎没解封。
func TestMonthlyCapSumsSegmentsAfterUpgrade(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t)
	if _, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, ""); err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	period := periodOf(svc.now().Unix())
	monthStart, monthEnd, monthSecs := monthAt(t, period)
	t1 := monthStart + monthSecs/2

	if err := store.SetUserPlan(ctx, "u1", "plus", t1); err != nil {
		t.Fatalf("SetUserPlan: %v", err)
	}
	// 把服务时钟推到 t1 之后，让读路径看到"本月已改过档"。
	svc.now = func() time.Time { return time.Unix(t1+60, 0) }

	u, _ := store.GetUserByID(ctx, "u1")
	plusCap := int64(300) << 30
	segSecs := monthEnd - t1
	wantSeg := plusCap/monthSecs*segSecs + (plusCap%monthSecs)*segSecs/monthSecs
	want := u.QuotaAccruedBytes + wantSeg

	got, err := svc.monthlyTrafficCap(ctx, "u1")
	if err != nil {
		t.Fatalf("monthlyTrafficCap: %v", err)
	}
	if got != want {
		t.Fatalf("cap = %d, want %d (accrued %d + plus segment %d)",
			got, want, u.QuotaAccruedBytes, wantSeg)
	}
	// 关键性质：分段累加必须严格大于"纯按比例"，否则月中超额用户升级后没解封。
	if got <= wantSeg {
		t.Fatalf("segment sum %d must exceed the new tier's slice alone %d", got, wantSeg)
	}
}

// 无限档（cap<=0）在任何分支下都必须继续表示无限，不能被比例计算变成有限值。
func TestMonthlyCapUnlimitedStaysUnlimited(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t)
	if err := store.UpsertPlan(ctx, Plan{ID: "unl", Name: "Unlimited", StorageBytes: 0,
		TrafficBytes: 0, RetentionSecs: 0, Active: true, UpdatedAt: 1}); err != nil {
		t.Fatalf("UpsertPlan: %v", err)
	}
	if _, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, ""); err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	monthStart, _, monthSecs := monthAt(t, periodOf(svc.now().Unix()))
	t1 := monthStart + monthSecs/2
	if err := store.SetUserPlan(ctx, "u1", "unl", t1); err != nil {
		t.Fatalf("SetUserPlan: %v", err)
	}
	svc.now = func() time.Time { return time.Unix(t1+60, 0) }

	cap, err := svc.monthlyTrafficCap(ctx, "u1")
	if err != nil {
		t.Fatalf("monthlyTrafficCap: %v", err)
	}
	if cap > 0 {
		t.Fatalf("cap = %d, want <= 0 (unlimited)", cap)
	}
	over, err := svc.overTraffic(ctx, "u1", 1<<50)
	if err != nil {
		t.Fatalf("overTraffic: %v", err)
	}
	if over {
		t.Fatal("unlimited tier must never be over quota")
	}
}

// fail-open：store 报错时门必须放行，而不是把付费用户误判成 Free。
// 复用 plan_enforce_test.go:66 的 errUserStore 包装器。
func TestMonthlyCapFailsOpenOnStoreError(t *testing.T) {
	svc, store := newPlanService(t)
	svc.store = errUserStore{Store: store}
	if _, err := svc.monthlyTrafficCap(context.Background(), "u1"); err == nil {
		t.Fatal("monthlyTrafficCap must propagate store errors so the gate fails open")
	}
	over, err := svc.overTraffic(context.Background(), "u1", 1)
	if err == nil {
		t.Fatal("overTraffic must propagate the store error")
	}
	if over {
		t.Fatal("overTraffic must fail OPEN (false) on a store error")
	}
}
```

```go
// 月长不是常数：2 月 28/29 天、其它月 30/31 天。比例分母必须取当月的真实秒
// 数，用固定的 30 天会让 2 月的额度虚高、31 天的月份虚低。这里用闰年 2 月
// （1972-02，29 天）把这个错误钉死。
func TestMonthlyCapUsesRealMonthLength(t *testing.T) {
	ctx := context.Background()
	svc, store := newPlanService(t)
	if _, err := store.InsertUser(ctx, User{ID: "u1", Email: "a@b.c", CreatedAt: 1}, ""); err != nil {
		t.Fatalf("InsertUser: %v", err)
	}
	febStart, febEnd, febSecs := monthAt(t, "197202")
	if febSecs != 29*86400 {
		t.Fatalf("1972-02 length = %d s, want %d (29 days, leap year)", febSecs, 29*86400)
	}
	// 月中改档，然后把读侧时钟也挪进这个月。
	t1 := febStart + febSecs/2
	if err := store.SetUserPlan(ctx, "u1", "plus", t1); err != nil {
		t.Fatalf("SetUserPlan: %v", err)
	}
	svc.now = func() time.Time { return time.Unix(t1+60, 0) }

	u, _ := store.GetUserByID(ctx, "u1")
	plusCap := int64(300) << 30
	segSecs := febEnd - t1
	wantSeg := plusCap/febSecs*segSecs + (plusCap%febSecs)*segSecs/febSecs
	got, err := svc.monthlyTrafficCap(ctx, "u1")
	if err != nil {
		t.Fatalf("monthlyTrafficCap: %v", err)
	}
	if got != u.QuotaAccruedBytes+wantSeg {
		t.Fatalf("cap = %d, want %d — the divisor must be february's real length",
			got, u.QuotaAccruedBytes+wantSeg)
	}
	// 半个月的 plus 段必须明显小于整月 cap，否则比例根本没生效。
	if wantSeg >= plusCap {
		t.Fatalf("half-month segment %d must be well under the full cap %d", wantSeg, plusCap)
	}
}
```

测试文件需要 `"time"` import；若 `errUserStore` 的字段名与上面不符，照 `plan_enforce_test.go:66` 的实际定义调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/account/ -run 'TestMonthlyCap' -v`
Expected: FAIL —— `svc.monthlyTrafficCap undefined`

- [ ] **Step 3: 实现 `monthlyTrafficCap` 并改 `overTraffic`**

`server/internal/account/plan_enforce.go`，在 `currentMonthTraffic` 之后插入，并替换 `overTraffic`：

```go
// monthlyTrafficCap 返回用户当月的流量上限。通常就是其档位的整月 cap；只有当
// 本月改过档时，才把当月拆成若干段、每段按 cap × 该段占全月的比例相加（写侧
// 见 accrueQuotaTx）。返回值 <= 0 表示"无限"，与 overTraffic/overStorage 的既
// 有约定一致。
//
// 这里没有复用 planForUser：分段计算既要档位也要用户行上的三个配额字段，而
// planForUser 只返回 Plan。错误处理沿用同一条原则——真实的 store 错误往上传，
// 让门 fail-open；查不到的用户/档位才回落到 Free。
func (s *Service) monthlyTrafficCap(ctx context.Context, userID string) (int64, error) {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		if err == ErrNotFound {
			return freePlanFallback().TrafficBytes, nil
		}
		return 0, err
	}
	plan, ok, err := s.store.GetPlan(ctx, u.PlanID)
	if err != nil {
		return 0, err
	}
	if !ok {
		plan = freePlanFallback()
	}

	period := periodOf(s.now().Unix())
	// 本月没改过档（含全部存量用户，三列都是零值）→ 整月满额。
	if u.QuotaAccruedPeriod != period {
		return plan.TrafficBytes, nil
	}
	// 无限档不参与比例计算，否则会被算成一个有限的小数字。
	if plan.TrafficBytes <= 0 {
		return plan.TrafficBytes, nil
	}

	monthStart, monthEnd := monthRange(period)
	segStart := u.PlanStartedAt
	if segStart < monthStart {
		segStart = monthStart
	}
	monthSecs := monthEnd - monthStart
	segSecs := monthEnd - segStart
	if monthSecs <= 0 || segSecs <= 0 {
		return u.QuotaAccruedBytes, nil
	}
	// 先除后乘，避免溢出——同 accrueQuotaTx 里的理由。
	seg := plan.TrafficBytes/monthSecs*segSecs + (plan.TrafficBytes%monthSecs)*segSecs/monthSecs
	return u.QuotaAccruedBytes + seg, nil
}

// overTraffic reports whether userID's month-to-date traffic plus add exceeds
// their monthly traffic allowance. A non-positive cap means "unlimited".
func (s *Service) overTraffic(ctx context.Context, userID string, add int64) (bool, error) {
	cap, err := s.monthlyTrafficCap(ctx, userID)
	if err != nil {
		return false, err
	}
	if cap <= 0 {
		return false, nil
	}
	used, err := s.currentMonthTraffic(ctx, userID)
	if err != nil {
		return false, err
	}
	return used+add > cap, nil
}
```

`overStorage`、`overGlobalStorage`、`planRetentionCap` 保持不动——存储不按比例发放。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd server && go test ./internal/account/ -run 'TestMonthlyCap' -v`
Expected: PASS（五个都 ok）

- [ ] **Step 5: 跑全量测试**

Run: `cd server && go test ./...`
Expected: ok —— 尤其确认 `plan_enforce_test.go`、`files_plan_test.go` 的既有边界测试（严格 `>` 而非 `>=`）仍然通过

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/plan_enforce.go server/internal/account/quota_proration_test.go
git commit -m "feat(server): overTraffic 改用分段累加的当月流量上限"
```

---

### Task 5: `GET /api/me/usage`

**Files:**
- Modify: `server/internal/account/handlers.go`
- Test: `server/internal/account/me_usage_test.go`（新建）

**Interfaces:**
- Consumes: Task 4 的 `monthlyTrafficCap`
- Produces: HTTP 契约，Task 7/8 的前端依赖：

```json
{ "period": "202607", "resetsAt": 1754006400,
  "traffic": { "used": 0, "cap": 0 },
  "storage": { "used": 0, "cap": 0 } }
```

`cap == 0` 表示无限，前端据此隐藏进度条。

- [ ] **Step 1: 写失败测试**

新建 `server/internal/account/me_usage_test.go`：

```go
package account

import (
	"encoding/json"
	"net/http"
	"testing"
)

// /api/me/usage 报的必须是**当月**用量与当月上限，而不是 /api/stats 那个终身
// 累计——两者是不同的数，混淆会让用户以为自己还有额度。
func TestMeUsageReportsMonthToDate(t *testing.T) {
	ts, svc, store, mail := newBillingServer(t)
	cookie := loginCookie(t, ts, mail, "a@b.c")

	u, err := store.UserByCanonicalEmail(t.Context(), "a@b.c")
	if err != nil {
		t.Fatalf("lookup user: %v", err)
	}
	now := svc.now().Unix()
	if err := store.RecordMeter(t.Context(), u.ID, "upload", 500, now); err != nil {
		t.Fatalf("RecordMeter: %v", err)
	}

	req, _ := http.NewRequest("GET", ts.URL+"/api/me/usage", nil)
	req.AddCookie(cookie)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", res.StatusCode)
	}
	var body struct {
		Period   string `json:"period"`
		ResetsAt int64  `json:"resetsAt"`
		Traffic  struct{ Used, Cap int64 } `json:"traffic"`
		Storage  struct{ Used, Cap int64 } `json:"storage"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Period != periodOf(now) {
		t.Fatalf("period = %q, want %q", body.Period, periodOf(now))
	}
	_, wantEnd := monthRange(periodOf(now))
	if body.ResetsAt != wantEnd {
		t.Fatalf("resetsAt = %d, want %d (end of the current month)", body.ResetsAt, wantEnd)
	}
	if body.Traffic.Used != 500 {
		t.Fatalf("traffic.used = %d, want 500", body.Traffic.Used)
	}
	if body.Traffic.Cap != 1073741824 {
		t.Fatalf("traffic.cap = %d, want 1073741824 (free tier)", body.Traffic.Cap)
	}
	if body.Storage.Cap != 104857600 {
		t.Fatalf("storage.cap = %d, want 104857600 (free tier)", body.Storage.Cap)
	}
}

// 未登录必须 401 —— 用量是账号私有数据。
func TestMeUsageRequiresSession(t *testing.T) {
	ts, _, _, _ := newBillingServer(t)
	res, err := http.Get(ts.URL + "/api/me/usage")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", res.StatusCode)
	}
}
```

`newBillingServer` 走 `NewService`，它会调 `SeedPlans`；若不会，在测试开头补 `mustPlan(t, store, ...)` 播种 free 档。`RecordMeter` / `UserByCanonicalEmail` 的确切签名以 `sqlite.go` 与 `store.go` 为准，不符则照实际调整。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && go test ./internal/account/ -run 'TestMeUsage' -v`
Expected: FAIL —— `status = 404, want 200`

- [ ] **Step 3: 实现 handler**

`server/internal/account/handlers.go`，加在 `handleMe` 之后：

```go
// handleMeUsage 报告调用者当月的配额位置：当月流量对当月上限（可能因为月中改
// 档而按段计算），以及当前存活存储对档位上限。cap == 0 表示无限，前端据此隐
// 藏进度条。
//
// 这是用户侧第一个能看到配额的接口。在它之前，用户只有撞上 429 才知道自己超
// 了；而 /api/stats 报的是**终身累计**，和真正生效的当月配额是两个数，反而误
// 导人。
func (s *Service) handleMeUsage(w http.ResponseWriter, r *http.Request, u User) {
	ctx := r.Context()
	now := s.now().Unix()
	period := periodOf(now)
	_, monthEnd := monthRange(period)

	traffic, err := s.currentMonthTraffic(ctx, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	trafficCap, err := s.monthlyTrafficCap(ctx, u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	storage, err := s.store.CurrentStorage(ctx, u.ID, now)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	plan, ok, err := s.store.GetPlan(ctx, u.PlanID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok {
		plan = freePlanFallback()
	}

	// 对外一律把"无限"规约成 0，前端只需判断一个值。
	storageCap := plan.StorageBytes
	if storageCap < 0 {
		storageCap = 0
	}
	if trafficCap < 0 {
		trafficCap = 0
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"period":   period,
		"resetsAt": monthEnd,
		"traffic":  map[string]any{"used": traffic, "cap": trafficCap},
		"storage":  map[string]any{"used": storage, "cap": storageCap},
	})
}
```

- [ ] **Step 4: 注册路由**

`server/internal/account/handlers.go:124` 附近，在 `GET /api/me` 那行之后加：

```go
	mux.HandleFunc("GET /api/me/usage", s.RequireSession(s.handleMeUsage))
```

Go 1.22 的方法前缀路由中 `/api/me` 与 `/api/me/usage` 是两个互不冲突的精确模式。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd server && go test ./internal/account/ -run 'TestMeUsage' -v`
Expected: PASS（两个都 ok）

- [ ] **Step 6: 跑全量测试**

Run: `cd server && go test ./...`
Expected: ok

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/handlers.go server/internal/account/me_usage_test.go
git commit -m "feat(server): 新增 GET /api/me/usage 暴露当月用量与上限"
```

---

### Task 6: i18n `quota` 消息组

**Files:**
- Modify: `web/src/lib/i18n/types.ts`
- Modify: `web/src/lib/i18n/{zh,en,ja,ko,de,fr,ar,es,pt}.ts`

**Interfaces:**
- Consumes: 无
- Produces: `t.quota.{title,traffic,storage,left,resets,unlimited,warn,upgrade}`，Task 7/8 使用

- [ ] **Step 1: 加类型声明**

`web/src/lib/i18n/types.ts`，在 `me: {` 组（:214）之前插入：

```ts
  // 当月用量表（个人中心）与接近上限时的提醒条（传输界面）。cap === 0 表示无限。
  quota: {
    title: string;
    traffic: string;
    storage: string;
    left: (left: string) => string; // 剩余量，left 已是格式化好的体积字符串
    resets: (date: string) => string; // date 已按当前语言本地化
    unlimited: string;
    warn: (pct: number) => string; // 用量达 80% 时的提醒
    upgrade: string; // 提醒条上的按钮文案
  };
```

- [ ] **Step 2: 九个语言文件各加一组**

每个文件在 `me: {` 之前插入对应块。

`zh.ts`：
```ts
  quota: {
    title: "本月用量",
    traffic: "流量",
    storage: "存储",
    left: (left) => `剩余 ${left}`,
    resets: (date) => `${date} 重置`,
    unlimited: "无限制",
    warn: (pct) => `本月配额已用 ${pct}%`,
    upgrade: "升级套餐",
  },
```

`en.ts`：
```ts
  quota: {
    title: "This month's usage",
    traffic: "Traffic",
    storage: "Storage",
    left: (left) => `${left} left`,
    resets: (date) => `Resets ${date}`,
    unlimited: "Unlimited",
    warn: (pct) => `You've used ${pct}% of this month's quota`,
    upgrade: "Upgrade",
  },
```

`ja.ts`：
```ts
  quota: {
    title: "今月の使用量",
    traffic: "通信量",
    storage: "ストレージ",
    left: (left) => `残り ${left}`,
    resets: (date) => `${date} にリセット`,
    unlimited: "無制限",
    warn: (pct) => `今月の割り当ての ${pct}% を使用しました`,
    upgrade: "アップグレード",
  },
```

`ko.ts`：
```ts
  quota: {
    title: "이번 달 사용량",
    traffic: "트래픽",
    storage: "저장 공간",
    left: (left) => `${left} 남음`,
    resets: (date) => `${date}에 초기화`,
    unlimited: "무제한",
    warn: (pct) => `이번 달 할당량의 ${pct}%를 사용했습니다`,
    upgrade: "업그레이드",
  },
```

`de.ts`：
```ts
  quota: {
    title: "Nutzung diesen Monat",
    traffic: "Datenvolumen",
    storage: "Speicher",
    left: (left) => `${left} übrig`,
    resets: (date) => `Zurücksetzung am ${date}`,
    unlimited: "Unbegrenzt",
    warn: (pct) => `Sie haben ${pct} % Ihres Monatskontingents verbraucht`,
    upgrade: "Upgrade",
  },
```

`fr.ts`：
```ts
  quota: {
    title: "Utilisation ce mois-ci",
    traffic: "Trafic",
    storage: "Stockage",
    left: (left) => `${left} restant`,
    resets: (date) => `Réinitialisation le ${date}`,
    unlimited: "Illimité",
    warn: (pct) => `Vous avez utilisé ${pct} % de votre quota mensuel`,
    upgrade: "Passer à l'offre supérieure",
  },
```

`ar.ts`：
```ts
  quota: {
    title: "الاستخدام هذا الشهر",
    traffic: "حركة البيانات",
    storage: "التخزين",
    left: (left) => `متبقٍ ${left}`,
    resets: (date) => `تُعاد التهيئة في ${date}`,
    unlimited: "غير محدود",
    warn: (pct) => `لقد استخدمت ${pct}% من حصتك الشهرية`,
    upgrade: "ترقية الباقة",
  },
```

`es.ts`：
```ts
  quota: {
    title: "Uso de este mes",
    traffic: "Tráfico",
    storage: "Almacenamiento",
    left: (left) => `${left} restante`,
    resets: (date) => `Se restablece el ${date}`,
    unlimited: "Ilimitado",
    warn: (pct) => `Has usado el ${pct} % de tu cuota mensual`,
    upgrade: "Mejorar plan",
  },
```

`pt.ts`：
```ts
  quota: {
    title: "Uso deste mês",
    traffic: "Tráfego",
    storage: "Armazenamento",
    left: (left) => `${left} restante`,
    resets: (date) => `Redefine em ${date}`,
    unlimited: "Ilimitado",
    warn: (pct) => `Você usou ${pct}% da sua cota mensal`,
    upgrade: "Fazer upgrade",
  },
```

- [ ] **Step 3: 类型检查**

Run: `cd web && npm run check`
Expected: 0 errors —— 少写任何一个语言文件都会在这里报错，这就是九语言的安全网

- [ ] **Step 4: 跑前端测试**

Run: `cd web && npx vitest run`
Expected: PASS —— `i18n.test.ts` 若断言了跨语言 key 对齐，此步会验证

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/i18n/
git commit -m "feat(web): 新增 quota 消息组（9 语言）"
```

---

### Task 7: 个人中心用量进度条

**Files:**
- Create: `web/src/lib/QuotaMeters.svelte`
- Modify: `web/src/lib/MePage.svelte`

**Interfaces:**
- Consumes: `GET /api/me/usage`（Task 5）、`t.quota.*`（Task 6）
- Produces: `<QuotaMeters />`，无 props，自取数

- [ ] **Step 1: 建组件**

新建 `web/src/lib/QuotaMeters.svelte`：

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { formatSize } from "./format";

  const t = $derived<Messages>(messages[lang()]);

  interface Bucket { used: number; cap: number }
  interface Usage { period: string; resetsAt: number; traffic: Bucket; storage: Bucket }

  let usage = $state<Usage | null>(null);

  onMount(() => {
    fetch("/api/me/usage", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => { usage = u; })
      .catch(() => { /* 用量表是附加信息，取不到就整块不渲染 */ });
  });

  // cap === 0 表示无限档，此时不画进度条——画一条永远填不满的槽只会误导。
  const pct = (b: Bucket) => (b.cap > 0 ? Math.min(100, Math.round((b.used / b.cap) * 100)) : 0);
  const resetDate = $derived(
    usage ? new Date(usage.resetsAt * 1000).toLocaleDateString(lang()) : "",
  );
</script>

{#if usage}
  <section class="quota">
    <h3>{t.quota.title}</h3>
    {#each [{ key: "traffic", label: t.quota.traffic, b: usage.traffic }, { key: "storage", label: t.quota.storage, b: usage.storage }] as row (row.key)}
      <div class="row">
        <div class="head">
          <span class="lbl">{row.label}</span>
          {#if row.b.cap > 0}
            <span class="val">{formatSize(row.b.used)} / {formatSize(row.b.cap)}</span>
          {:else}
            <span class="val">{formatSize(row.b.used)} · {t.quota.unlimited}</span>
          {/if}
        </div>
        {#if row.b.cap > 0}
          <div
            class="bar"
            role="progressbar"
            aria-label={row.label}
            aria-valuenow={pct(row.b)}
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div class="fill" style:width="{pct(row.b)}%"></div>
          </div>
          <span class="sub">{t.quota.left(formatSize(Math.max(0, row.b.cap - row.b.used)))}</span>
        {/if}
      </div>
    {/each}
    <p class="resets">{t.quota.resets(resetDate)}</p>
  </section>
{/if}

<style>
  .quota { margin-top: var(--space-5); }
  .row { margin-top: var(--space-3); }
  .head { display: flex; justify-content: space-between; gap: var(--space-3); }
  .lbl { color: var(--muted); }
  /* 进度条沿用 App.svelte:1646 / StoredUpload.svelte:225 的既有样式 */
  .bar { height: 8px; border-radius: 999px; background: var(--code-bg); overflow: hidden; margin-top: var(--space-2); }
  .fill { height: 100%; background: var(--accent); }
  .sub, .resets { color: var(--muted); font-size: 0.875rem; }
  .resets { margin-top: var(--space-3); }
</style>
```

若 `--space-*` / `--muted` / `--accent` / `--code-bg` 中有变量名与本仓实际不符，以 `App.svelte` 的 `.bar` / `.fill` 规则（:1646）为准照抄。

- [ ] **Step 2: 挂到 MePage**

`web/src/lib/MePage.svelte`，import 区（:16 `reveal` 那行之后）加：

```ts
  import QuotaMeters from "./QuotaMeters.svelte";
```

在 `<p class="privacy">{t.me.privacyNote}</p>`（:251）之后插入：

```svelte
    <QuotaMeters />
```

放在 privacy note 之后、`<section class="files">` 之前：终身累计统计仍在上方，但当月配额紧随其后，读者不会把两者混为一谈。

- [ ] **Step 3: 类型检查 + 测试**

Run: `cd web && npm run check && npx vitest run`
Expected: 0 errors，测试 PASS

- [ ] **Step 4: 人工验证**

Run: `cd server && go build -o relayium-server . && cd ../web && npm run build && cd ../server && ./relayium-server -addr :8080 -static ../web/dist`

打开 `http://localhost:8080`，注册并登录，上传一个文件，进入 `/me`。
Expected: "本月用量"区块出现两条进度条；流量条随上传增长；重置日期显示为下月 1 日。

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/QuotaMeters.svelte web/src/lib/MePage.svelte
git commit -m "feat(web): 个人中心展示当月流量/存储用量进度条"
```

---

### Task 8: 传输界面 80% 提醒条

**Files:**
- Create: `web/src/lib/QuotaNotice.svelte`
- Modify: `web/src/App.svelte:1300`

**Interfaces:**
- Consumes: `GET /api/me/usage`（Task 5）、`t.quota.warn` / `t.quota.upgrade`（Task 6）
- Produces: `<QuotaNotice />`，无 props

- [ ] **Step 1: 建组件**

新建 `web/src/lib/QuotaNotice.svelte`：

```svelte
<script lang="ts">
  import { session } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";
  import { navigate } from "./router.svelte";

  const t = $derived<Messages>(messages[lang()]);

  const WARN_AT = 0.8; // 提醒阈值：留出足够余量让用户在被 429 打断前完成升级

  let pct = $state(0);
  let loadedFor = $state<string | null>(null);

  // 跟着会话走：登出后清零，换账号后重取。未登录用户没有配额可言。
  $effect(() => {
    const uid = session().user?.id ?? null;
    if (!uid) { pct = 0; loadedFor = null; return; }
    if (uid === loadedFor) return;
    loadedFor = uid;
    fetch("/api/me/usage", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => {
        // cap === 0 是无限档，永远不提醒。
        const cap = u?.traffic?.cap ?? 0;
        pct = cap > 0 ? Math.min(100, Math.round((u.traffic.used / cap) * 100)) : 0;
      })
      .catch(() => { pct = 0; });
  });
</script>

{#if pct >= WARN_AT * 100}
  <p class="quota-warn" role="status">
    <span>{t.quota.warn(pct)}</span>
    <button class="btn" onclick={() => navigate("pricing")}>{t.quota.upgrade}</button>
  </p>
{/if}

<style>
  .quota-warn {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--space-3); margin-top: var(--space-3);
  }
</style>
```

`navigate("pricing")` 的路由名以 `web/src/lib/router.svelte.ts` 中定价页的实际路由标识为准（`App.svelte:1433` 附近有 pricing 路由的注册）。

- [ ] **Step 2: 挂到传输界面**

`web/src/App.svelte`，import 区加：

```ts
  import QuotaNotice from "./lib/QuotaNotice.svelte";
```

在 `transferSurface` snippet 里，`<h2>`（:1301）之后、`{#if outbox().length ...}` 之前插入：

```svelte
    <QuotaNotice />
```

这个位置与既有的 `share-pending` 提示、`confirm-send` 对话框同槽，是这个界面放临时横幅的既定位置，且 LAN 与跨网络两条路由共用同一个 snippet，一处插入两边都覆盖。

- [ ] **Step 3: 类型检查 + 测试**

Run: `cd web && npm run check && npx vitest run`
Expected: 0 errors，测试 PASS

- [ ] **Step 4: 人工验证**

用 admin 后台把测试账号的档位流量临时改小（`/admin/plans`），使已用量超过 80%，刷新首页。
Expected: 传输界面顶部出现提醒条与升级按钮；点击跳转定价页。未登录时不出现。

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/QuotaNotice.svelte web/src/App.svelte
git commit -m "feat(web): 用量达 80% 时在传输界面提示升级"
```

---

## 收尾验证

- [ ] `cd server && go test ./...` → ok
- [ ] `cd web && npx vitest run && npm run check` → PASS / 0 errors
- [ ] 端到端人工检查：免费账号连续上传直到 429，确认在 80% 时出现提醒、429 的报错文案与个人中心显示的剩余量一致
- [ ] 确认 Pre-flight 的年付 price id 结论已落实（保留或另开任务撤掉年付）
