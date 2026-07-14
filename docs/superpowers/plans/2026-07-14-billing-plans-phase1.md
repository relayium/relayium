# Billing Plans Phase-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-configurable Free/Plus/Pro/Max plans and enforce each plan's storage, monthly-traffic, and retention limits at upload, download, and relay — so a file's owner running out of quota makes their shares stop working ("超限即失效"). No payment integration.

**Architecture:** A new `plans` table (seeded with 4 tiers, admin-editable) plus `users.plan_id` define per-user limits. A small set of Service helpers (`plan_enforce.go`) resolve a user's plan and answer "is this user over storage / traffic?" and "what retention cap applies?", reading the existing `usage_monthly` (upload+download) and `usage_events` (relay) tables. Every enforcement point (single-shot upload, resumable upload, download, ICE/TURN issuance) calls these helpers. An admin section manages plans and assigns users.

**Tech Stack:** Go (stdlib `net/http`, `database/sql` + SQLite), `html/template` for admin pages. Existing patterns: `settings.go` (settingOr/SeedSettings), `store.go` interface + `sqlite.go` impl, `admin.go`/`admin_templates.go`.

## Global Constraints

- Money is stored in **US cents** as `int64`; bytes and seconds as `int64`. No floats.
- All new SQL is **parameterized**; migrations use the idempotent `ALTER TABLE … ADD COLUMN` pattern guarded by `strings.Contains(err.Error(), "duplicate column name")` (see `sqlite.go` migration block).
- Plan IDs are the stable keys `free`, `plus`, `pro`, `max`.
- Default tier values (factory defaults, all admin-editable afterward):

  | id | name | storage | traffic/mo | retention | monthly ¢ | yearly ¢ |
  |----|------|---------|-----------|-----------|-----------|----------|
  | free | Free | 100 MB | 2 GB | 3 days | 0 | 0 |
  | plus | Plus | 5 GB | 300 GB | 30 days | 390 | 2900 |
  | pro | Pro | 50 GB | 1 TB | 90 days | 890 | 7900 |
  | max | Max | 250 GB | 5 TB | 180 days | 1990 | 19900 |

  (MB=1<<20, GB=1<<30, TB=1<<40, day=86400.)
- **P2P/LAN direct transfer is never limited** — only TURN relay + staged upload/download count. Enforcement only touches the staged/relay paths.
- Enforcement reads **current-month** usage, so it resets automatically each month.
- Over-limit responses: upload storage → **413**, global disk → **507**, traffic (upload/download) → **429**, relay → withhold TURN (STUN still returned, `relayDenied:"quota"`). Retention over-limit → silent clamp.
- Run tests from `server/`: `go test ./internal/account/ -run <Name>`.

---

### Task 1: `plans` table, `Plan` model, store CRUD, and seeding

**Files:**
- Modify: `server/internal/account/sqlite.go` (schema `CREATE TABLE`, migration is not needed — new table; add CRUD methods)
- Modify: `server/internal/account/store.go` (`Plan` struct + interface methods)
- Modify: `server/internal/account/settings.go` (add `SeedPlans` alongside `SeedSettings`)
- Modify: `server/main.go:299` area (call `SeedPlans` after `SeedSettings`)
- Test: `server/internal/account/plans_test.go` (create)

**Interfaces:**
- Produces:
  - `type Plan struct { ID, Name string; StorageBytes, TrafficBytes, RetentionSecs, PriceMonthly, PriceYearly, SortOrder int64; Active bool; UpdatedAt int64 }`
  - `ListPlans(ctx context.Context) ([]Plan, error)` — all plans, ordered by `sort_order, id`.
  - `GetPlan(ctx context.Context, id string) (Plan, bool, error)`
  - `UpsertPlan(ctx context.Context, p Plan) error` — insert or replace by `id`.
  - `CountActivePlans(ctx context.Context) (int, error)`
  - `(*Service) SeedPlans(ctx context.Context) error` — insert the 4 default rows for any id not already present (existing rows untouched, mirroring `SeedSettings`).

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/plans_test.go`:

```go
package account

import (
	"context"
	"testing"
)

func TestSeedPlansCreatesFourDefaultsIdempotently(t *testing.T) {
	st := newTestStore(t)
	svc := &Service{store: st, cfg: Config{}, now: func() int64 { return 1000 }}

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestSeedPlansCreatesFourDefaultsIdempotently -v`
Expected: FAIL — `st.ListPlans undefined` / `svc.SeedPlans undefined`.

- [ ] **Step 3: Add the schema, model, CRUD, and seeding**

In `sqlite.go`, add to the `CREATE TABLE` block (near `cli_device_auth`):

```sql
CREATE TABLE IF NOT EXISTS plans (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  storage_bytes  INTEGER NOT NULL,
  traffic_bytes  INTEGER NOT NULL,
  retention_secs INTEGER NOT NULL,
  price_monthly  INTEGER NOT NULL DEFAULT 0,
  price_yearly   INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);
```

In `sqlite.go`, add methods:

```go
const planCols = `id, name, storage_bytes, traffic_bytes, retention_secs, price_monthly, price_yearly, sort_order, active, updated_at`

func scanPlan(sc rowScanner) (Plan, error) {
	var p Plan
	var active int64
	err := sc.Scan(&p.ID, &p.Name, &p.StorageBytes, &p.TrafficBytes, &p.RetentionSecs,
		&p.PriceMonthly, &p.PriceYearly, &p.SortOrder, &active, &p.UpdatedAt)
	p.Active = active != 0
	return p, err
}

func (s *SQLiteStore) ListPlans(ctx context.Context) ([]Plan, error) {
	rows, err := s.reader().QueryContext(ctx,
		`SELECT `+planCols+` FROM plans ORDER BY sort_order, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Plan
	for rows.Next() {
		p, err := scanPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) GetPlan(ctx context.Context, id string) (Plan, bool, error) {
	p, err := scanPlan(s.reader().QueryRowContext(ctx, `SELECT `+planCols+` FROM plans WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return Plan{}, false, nil
	}
	if err != nil {
		return Plan{}, false, err
	}
	return p, true, nil
}

func (s *SQLiteStore) UpsertPlan(ctx context.Context, p Plan) error {
	active := int64(0)
	if p.Active {
		active = 1
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO plans (`+planCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name=excluded.name, storage_bytes=excluded.storage_bytes,
		   traffic_bytes=excluded.traffic_bytes, retention_secs=excluded.retention_secs,
		   price_monthly=excluded.price_monthly, price_yearly=excluded.price_yearly,
		   sort_order=excluded.sort_order, active=excluded.active, updated_at=excluded.updated_at`,
		p.ID, p.Name, p.StorageBytes, p.TrafficBytes, p.RetentionSecs,
		p.PriceMonthly, p.PriceYearly, p.SortOrder, active, p.UpdatedAt)
	return err
}

func (s *SQLiteStore) CountActivePlans(ctx context.Context) (int, error) {
	var n int
	err := s.reader().QueryRowContext(ctx, `SELECT COUNT(*) FROM plans WHERE active = 1`).Scan(&n)
	return n, err
}
```

> NOTE: if `s.reader()` does not exist in this codebase version, use `s.db` for the read queries — check `sqlite.go` for the admin read-pool helper (added in the WAL/read-pool change) and match it.

In `store.go`, add the struct + interface methods (place the struct near `User`, the methods inside `type Store interface`):

```go
// Plan is an admin-configurable billing tier: per-account storage + monthly
// traffic caps and a staged-file retention ceiling. Prices are US cents.
type Plan struct {
	ID            string
	Name          string
	StorageBytes  int64
	TrafficBytes  int64
	RetentionSecs int64
	PriceMonthly  int64
	PriceYearly   int64
	SortOrder     int64
	Active        bool
	UpdatedAt     int64
}
```

```go
	// plans (billing phase-1)
	ListPlans(ctx context.Context) ([]Plan, error)
	GetPlan(ctx context.Context, id string) (Plan, bool, error)
	UpsertPlan(ctx context.Context, p Plan) error
	CountActivePlans(ctx context.Context) (int, error)
```

In `settings.go`, add `SeedPlans` (defaults table copied from Global Constraints):

```go
// defaultPlans is the factory tier table; SeedPlans writes any id not already
// present, leaving admin edits untouched (same semantics as SeedSettings).
func defaultPlans() []Plan {
	const mb, gb, tb, day = int64(1) << 20, int64(1) << 30, int64(1) << 40, int64(86400)
	return []Plan{
		{ID: "free", Name: "Free", StorageBytes: 100 * mb, TrafficBytes: 2 * gb, RetentionSecs: 3 * day, PriceMonthly: 0, PriceYearly: 0, SortOrder: 0, Active: true},
		{ID: "plus", Name: "Plus", StorageBytes: 5 * gb, TrafficBytes: 300 * gb, RetentionSecs: 30 * day, PriceMonthly: 390, PriceYearly: 2900, SortOrder: 1, Active: true},
		{ID: "pro", Name: "Pro", StorageBytes: 50 * gb, TrafficBytes: 1 * tb, RetentionSecs: 90 * day, PriceMonthly: 890, PriceYearly: 7900, SortOrder: 2, Active: true},
		{ID: "max", Name: "Max", StorageBytes: 250 * gb, TrafficBytes: 5 * tb, RetentionSecs: 180 * day, PriceMonthly: 1990, PriceYearly: 19900, SortOrder: 3, Active: true},
	}
}

// SeedPlans inserts the factory tiers for any plan id not already present.
func (s *Service) SeedPlans(ctx context.Context) error {
	now := s.now().Unix()
	for _, p := range defaultPlans() {
		if _, ok, err := s.store.GetPlan(ctx, p.ID); err != nil {
			return err
		} else if ok {
			continue
		}
		p.UpdatedAt = now
		if err := s.store.UpsertPlan(ctx, p); err != nil {
			return err
		}
	}
	return nil
}
```

In `main.go`, right after the existing `acct.SeedSettings(...)` call (~line 299):

```go
			if err := acct.SeedPlans(context.Background()); err != nil {
				log.Fatalf("seed plans: %v", err)
			}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run TestSeedPlansCreatesFourDefaultsIdempotently -v`
Expected: PASS. Also `go build ./...` must succeed.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/sqlite.go server/internal/account/store.go server/internal/account/settings.go server/internal/account/plans_test.go server/main.go
git commit -m "feat(billing): plans table, Plan model, CRUD, and factory seeding"
```

---

### Task 2: `users.plan_id` column and assignment

**Files:**
- Modify: `server/internal/account/sqlite.go` (migration ALTER + `SetUserPlan`; include `plan_id` in the user SELECTs/scan)
- Modify: `server/internal/account/store.go` (`User.PlanID` field + `SetUserPlan` method)
- Test: `server/internal/account/plans_test.go` (add)

**Interfaces:**
- Consumes: `Plan`, `GetPlan` (Task 1).
- Produces:
  - `User.PlanID string` (populated by `GetUserByID`/`GetUserByEmail`; defaults to `"free"`).
  - `SetUserPlan(ctx context.Context, userID, planID string) error`

- [ ] **Step 1: Write the failing test**

Add to `plans_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestUserPlanDefaultsFreeAndCanBeSet -v`
Expected: FAIL — `got.PlanID` is `""` (field/column absent) and `SetUserPlan undefined`.

- [ ] **Step 3: Add the column, field, scan, and setter**

In `sqlite.go`, add to the idempotent ALTER slice (next to the account-lifecycle ALTERs):

```go
		`ALTER TABLE users ADD COLUMN plan_id TEXT NOT NULL DEFAULT 'free'`,
```

Add `plan_id` to every `users` SELECT that builds a `User` (search for `SELECT id, email, display_name, created_at, email_verified` — there are three: by-email, by-canonical-email, by-id). Append `, plan_id` to each column list and `&u.PlanID` to each `Scan`. Example for `GetUserByID` (line ~557):

```go
	err := s.db.QueryRowContext(ctx,
		`SELECT id, email, display_name, created_at, email_verified, only_own_nodes, deleted_at, purge_after, plan_id FROM users WHERE id = ?`, id,
	).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.EmailVerified, &u.OnlyOwnNodes, &u.DeletedAt, &u.PurgeAfter, &u.PlanID)
```

(Apply the same `, plan_id` + `&u.PlanID` addition to the other two user-loading queries; the by-email/by-canonical ones select a subset — add `plan_id` to their lists and scan targets too.)

Add the setter:

```go
func (s *SQLiteStore) SetUserPlan(ctx context.Context, userID, planID string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE users SET plan_id = ? WHERE id = ?`, planID, userID)
	return err
}
```

In `store.go`, add to `User`:

```go
	// PlanID is the user's billing tier (plans.id); defaults to "free".
	PlanID string
```

and to the interface:

```go
	SetUserPlan(ctx context.Context, userID, planID string) error
```

> NOTE: the by-email and by-canonical SELECTs may not scan `only_own_nodes`/`deleted_at`; only append `plan_id` to the columns each already selects and add the matching `&u.PlanID`. Build after editing to catch any scan/column count mismatch.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run TestUserPlanDefaultsFreeAndCanBeSet -v` → PASS.
Also run the whole package to catch scan-arity regressions: `go test ./internal/account/ 2>&1 | tail -5` → `ok`.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/sqlite.go server/internal/account/store.go server/internal/account/plans_test.go
git commit -m "feat(billing): users.plan_id column, default free, SetUserPlan"
```

---

### Task 3: `storage_disk_cap` setting; retire `relay_monthly_free_bytes`

**Files:**
- Modify: `server/internal/account/settings.go` (add `SettingStorageDiskCap` + `Settings.StorageDiskCap`; remove `SettingRelayMonthlyFree`/`RelayMonthlyFree` from `Settings`/`resolveSettings`/`SeedSettings`)
- Modify: `server/internal/account/service.go` (`Config`: add `StorageDiskCap`; the `RelayMonthlyFree` Config field stays for now — it's still the fallback default the ICE code reads until Task 9 swaps it, then it is removed there)
- Test: `server/internal/account/settings_test.go` (add; or `plans_test.go`)

**Interfaces:**
- Produces: `Settings.StorageDiskCap int64` and `SettingStorageDiskCap = "storage_disk_cap"`.

> DECISION: keep the `relay_monthly_free_bytes` **setting key and Config field** intact through Task 8 so nothing breaks mid-plan; Task 9 removes the ICE code that reads it and this task's follow-up (in Task 9) deletes the key. In THIS task only ADD `storage_disk_cap`; do not delete the relay setting yet.

- [ ] **Step 1: Write the failing test**

Add to `plans_test.go`:

```go
func TestStorageDiskCapSettingResolves(t *testing.T) {
	st := newTestStore(t)
	svc := &Service{store: st, cfg: Config{StorageDiskCap: 12345}, now: func() int64 { return 1 }}
	if got := svc.resolveSettings(context.Background()).StorageDiskCap; got != 12345 {
		t.Fatalf("StorageDiskCap = %d, want 12345 (Config default)", got)
	}
	_ = st.SetSetting(context.Background(), SettingStorageDiskCap, 999, 1)
	if got := svc.resolveSettings(context.Background()).StorageDiskCap; got != 999 {
		t.Fatalf("StorageDiskCap = %d, want 999 (admin override)", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestStorageDiskCapSettingResolves -v`
Expected: FAIL — `SettingStorageDiskCap` / `StorageDiskCap` undefined.

- [ ] **Step 3: Add the setting**

`settings.go` — add the key constant:

```go
	// SettingStorageDiskCap is the global logical storage ceiling: the sum of
	// live staged-file sizes may not exceed it (oversubscription backstop,
	// distinct from the physical blob-volume cap). Bytes.
	SettingStorageDiskCap = "storage_disk_cap"
```

Add to `Settings`:

```go
	// StorageDiskCap bounds SUM(live stored_files.size) globally.
	StorageDiskCap int64
```

Add to `resolveSettings`:

```go
		StorageDiskCap: s.settingOr(ctx, SettingStorageDiskCap, s.cfg.StorageDiskCap),
```

Add to `SeedSettings` defaults slice:

```go
		{SettingStorageDiskCap, s.cfg.StorageDiskCap},
```

`service.go` `Config` — add:

```go
	// StorageDiskCap seeds SettingStorageDiskCap (global logical storage ceiling).
	StorageDiskCap int64
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run TestStorageDiskCapSettingResolves -v` → PASS. `go build ./...` → ok.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/settings.go server/internal/account/service.go server/internal/account/plans_test.go
git commit -m "feat(billing): add storage_disk_cap global logical storage setting"
```

---

### Task 4: usage read queries — monthly traffic, per-user + global storage

**Files:**
- Modify: `server/internal/account/sqlite.go` (add three read queries)
- Modify: `server/internal/account/store.go` (interface)
- Test: `server/internal/account/plans_test.go` (add)

**Interfaces:**
- Consumes: existing `RecordMeter`, `RecordUpload`/`ReserveUpload`, `RecordUsage`, `periodOf`, `monthRange`, `UserRelayedSince`.
- Produces:
  - `UserMonthlyUpDown(ctx context.Context, userID, period string) (int64, error)` — `usage_monthly.upload_bytes + download_bytes` for that period (0 if no row).
  - `CurrentStorage(ctx context.Context, userID string, now int64) (int64, error)` — `SUM(size) WHERE user_id=? AND expires_at>now`.
  - `GlobalStorageUsed(ctx context.Context, now int64) (int64, error)` — `SUM(size) WHERE expires_at>now`.

- [ ] **Step 1: Write the failing test**

Add to `plans_test.go`:

```go
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

	_ = st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "b1", EncManifest: []byte("x"), Size: 4096, ExpiresAt: 1 << 40, CreatedAt: 1})
	_ = st.CreateStoredFile(ctx, StoredFile{ID: newID(), UserID: u.ID, BlobKey: "b2", EncManifest: []byte("x"), Size: 1000, ExpiresAt: 5, CreatedAt: 1}) // already expired at now=10

	cs, err := st.CurrentStorage(ctx, u.ID, 10)
	if err != nil || cs != 4096 {
		t.Fatalf("CurrentStorage = %d,%v want 4096 (expired file excluded)", cs, err)
	}
	gs, err := st.GlobalStorageUsed(ctx, 10)
	if err != nil || gs != 4096 {
		t.Fatalf("GlobalStorageUsed = %d,%v want 4096", gs, err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestUsageReadQueries -v`
Expected: FAIL — the three methods are undefined.

- [ ] **Step 3: Add the queries**

`sqlite.go`:

```go
// UserMonthlyUpDown returns a user's upload+download bytes for one period
// ("YYYYMM") from the usage_monthly rollup (0 when no row exists).
func (s *SQLiteStore) UserMonthlyUpDown(ctx context.Context, userID, period string) (int64, error) {
	var up, down sql.NullInt64
	err := s.reader().QueryRowContext(ctx,
		`SELECT upload_bytes, download_bytes FROM usage_monthly WHERE user_id = ? AND period = ?`,
		userID, period).Scan(&up, &down)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return up.Int64 + down.Int64, nil
}

// CurrentStorage sums a user's live staged-file bytes (expires_at > now).
func (s *SQLiteStore) CurrentStorage(ctx context.Context, userID string, now int64) (int64, error) {
	var total sql.NullInt64
	err := s.reader().QueryRowContext(ctx,
		`SELECT COALESCE(SUM(size),0) FROM stored_files WHERE user_id = ? AND expires_at > ?`,
		userID, now).Scan(&total)
	return total.Int64, err
}

// GlobalStorageUsed sums all live staged-file bytes (oversubscription backstop).
func (s *SQLiteStore) GlobalStorageUsed(ctx context.Context, now int64) (int64, error) {
	var total sql.NullInt64
	err := s.reader().QueryRowContext(ctx,
		`SELECT COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > ?`, now).Scan(&total)
	return total.Int64, err
}
```

`store.go` interface:

```go
	UserMonthlyUpDown(ctx context.Context, userID, period string) (int64, error)
	CurrentStorage(ctx context.Context, userID string, now int64) (int64, error)
	GlobalStorageUsed(ctx context.Context, now int64) (int64, error)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run TestUsageReadQueries -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/sqlite.go server/internal/account/store.go server/internal/account/plans_test.go
git commit -m "feat(billing): usage read queries — monthly traffic, per-user + global storage"
```

---

### Task 5: plan-enforcement helpers on Service

**Files:**
- Create: `server/internal/account/plan_enforce.go`
- Test: `server/internal/account/plan_enforce_test.go`

**Interfaces:**
- Consumes: `GetUserByID`, `GetPlan`, `UserMonthlyUpDown`, `UserRelayedSince`, `CurrentStorage`, `GlobalStorageUsed`, `periodOf`, `monthRange`, `defaultPlans` (Task 1), `resolveSettings` (Task 3).
- Produces (all methods on `*Service`):
  - `planForUser(ctx, userID string) Plan` — user's plan; falls back to the factory `free` plan on any lookup miss/inactive-missing row.
  - `currentMonthTraffic(ctx, userID string) (int64, error)` — `UserMonthlyUpDown(period) + UserRelayedSince(monthStart)`.
  - `overTraffic(ctx, userID string, add int64) (bool, error)` — `traffic+add > plan.TrafficBytes` (plan.TrafficBytes<=0 ⇒ never over).
  - `overStorage(ctx, userID string, add int64) (bool, error)` — `CurrentStorage+add > plan.StorageBytes` (<=0 ⇒ never over).
  - `overGlobalStorage(ctx, add int64) (bool, error)` — `GlobalStorageUsed+add > StorageDiskCap` (cap<=0 ⇒ disabled).
  - `planRetentionCap(ctx, userID string) int64` — user's `plan.RetentionSecs` (0 ⇒ no plan cap).

- [ ] **Step 1: Write the failing test**

Create `plan_enforce_test.go`:

```go
package account

import (
	"context"
	"testing"
)

func newPlanService(t *testing.T) (*Service, *SQLiteStore) {
	t.Helper()
	st := newTestStore(t)
	svc := &Service{store: st, cfg: Config{}, now: func() int64 { return 100 }}
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run 'TestOverTrafficAndStorage|TestPlanForUserFallsBackToFree' -v`
Expected: FAIL — helpers undefined.

- [ ] **Step 3: Implement the helpers**

Create `plan_enforce.go`:

```go
package account

import "context"

// freePlanFallback is the in-memory Free tier used when a user's plan_id can't
// be resolved (missing row, DB blip). Matches defaultPlans()[0] so enforcement
// never crashes and never silently grants unlimited quota.
func freePlanFallback() Plan { return defaultPlans()[0] }

// planForUser resolves a user's billing tier, falling back to Free on any miss.
func (s *Service) planForUser(ctx context.Context, userID string) Plan {
	u, err := s.store.GetUserByID(ctx, userID)
	if err != nil {
		return freePlanFallback()
	}
	p, ok, err := s.store.GetPlan(ctx, u.PlanID)
	if err != nil || !ok {
		return freePlanFallback()
	}
	return p
}

// currentMonthTraffic sums a user's staged upload+download (usage_monthly) plus
// billable relay (usage_events) for the current month.
func (s *Service) currentMonthTraffic(ctx context.Context, userID string) (int64, error) {
	now := s.now().Unix()
	period := periodOf(now)
	upDown, err := s.store.UserMonthlyUpDown(ctx, userID, period)
	if err != nil {
		return 0, err
	}
	monthStart, _ := monthRange(period)
	relay, err := s.store.UserRelayedSince(ctx, userID, monthStart)
	if err != nil {
		return 0, err
	}
	return upDown + relay, nil
}

// overTraffic reports whether userID's month-to-date traffic plus add exceeds
// their plan's traffic cap. A non-positive cap means "unlimited".
func (s *Service) overTraffic(ctx context.Context, userID string, add int64) (bool, error) {
	cap := s.planForUser(ctx, userID).TrafficBytes
	if cap <= 0 {
		return false, nil
	}
	used, err := s.currentMonthTraffic(ctx, userID)
	if err != nil {
		return false, err
	}
	return used+add > cap, nil
}

// overStorage reports whether userID's current live storage plus add exceeds
// their plan's storage cap. A non-positive cap means "unlimited".
func (s *Service) overStorage(ctx context.Context, userID string, add int64) (bool, error) {
	cap := s.planForUser(ctx, userID).StorageBytes
	if cap <= 0 {
		return false, nil
	}
	used, err := s.store.CurrentStorage(ctx, userID, s.now().Unix())
	if err != nil {
		return false, err
	}
	return used+add > cap, nil
}

// overGlobalStorage reports whether total live storage plus add exceeds the
// global logical cap (SettingStorageDiskCap). cap<=0 disables the check.
func (s *Service) overGlobalStorage(ctx context.Context, add int64) (bool, error) {
	cap := s.resolveSettings(ctx).StorageDiskCap
	if cap <= 0 {
		return false, nil
	}
	used, err := s.store.GlobalStorageUsed(ctx, s.now().Unix())
	if err != nil {
		return false, err
	}
	return used+add > cap, nil
}

// planRetentionCap returns the user's plan retention ceiling in seconds (0 = no
// plan cap; the global clampTTL still applies).
func (s *Service) planRetentionCap(ctx context.Context, userID string) int64 {
	return s.planForUser(ctx, userID).RetentionSecs
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run 'TestOverTrafficAndStorage|TestPlanForUserFallsBackToFree' -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/plan_enforce.go server/internal/account/plan_enforce_test.go
git commit -m "feat(billing): per-plan traffic/storage/retention enforcement helpers"
```

---

### Task 6: enforce plan limits on single-shot upload

**Files:**
- Modify: `server/internal/account/files.go` (`handleUploadFile`: add global-disk + storage + traffic gates; clamp TTL to plan)
- Test: `server/internal/account/files_plan_test.go` (create)

**Interfaces:**
- Consumes: `overGlobalStorage`, `overStorage`, `overTraffic`, `planRetentionCap` (Task 5), existing `placeUpload`, `resolveRetention`, `s.now()`.

> The gates go AFTER `placeUpload` (so own-node/billable is known) and near the existing daily-quota pre-check. Own-node uploads (`billable==false`) skip storage/traffic/global-disk gates — they use the user's own disk, exactly like the daily-quota pre-check already skips them. TTL clamp applies to all.

- [ ] **Step 1: Write the failing test**

Create `files_plan_test.go`:

```go
package account

import (
	"bytes"
	"context"
	"net/http"
	"testing"
)

// setUserPlanWith overrides a plan's caps for the test user, then assigns it.
func setUserPlanWith(t *testing.T, st *SQLiteStore, userID string, storage, traffic, retention int64) {
	t.Helper()
	ctx := context.Background()
	_ = st.UpsertPlan(ctx, Plan{ID: "free", Name: "Free", StorageBytes: storage, TrafficBytes: traffic, RetentionSecs: retention, Active: true, UpdatedAt: 1})
	_ = st.SetUserPlan(ctx, userID, "free")
}

func TestUploadRefusedOverStorage(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "st@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "st@example.com", "")
	setUserPlanWith(t, store, u.ID, 10 /*storage bytes*/, 1<<30, 3*86400)

	// Body larger than the 10-byte storage cap.
	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 50)))
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("over-storage upload = %d, want 413", resp.StatusCode)
	}
}

func TestUploadRefusedOverTraffic(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "tr@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "tr@example.com", "")
	setUserPlanWith(t, store, u.ID, 1<<30, 10 /*traffic bytes*/, 3*86400)

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 50)))
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("over-traffic upload = %d, want 429", resp.StatusCode)
	}
}
```

> NOTE: confirm the `newFileServer` return arity and `postUpload`/`uploadBody` helpers by reading `files_test.go` (Task uses the same helpers already present there). Adjust the destructuring to match.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run 'TestUploadRefusedOverStorage|TestUploadRefusedOverTraffic' -v`
Expected: FAIL — uploads currently return 200.

- [ ] **Step 3: Add the gates**

In `handleUploadFile` (`files.go`), after `placeUpload` resolves `nodeID, bs, billable` and after the existing central physical-disk soft-cap block, before writing the blob. Insert plan gates (use the declared ciphertext size `declared` the daily-quota pre-check already computes; compute it if not in scope):

```go
	// Per-plan gates (billable central-stored uploads only; own-node uploads use
	// the user's own disk and are never metered against a plan).
	if billable {
		declared := r.ContentLength - 4 - int64(mlen) // ciphertext bytes (minus framing)
		if declared < 0 {
			declared = 0
		}
		// Global logical storage ceiling (oversubscription backstop) first.
		if over, err := s.overGlobalStorage(r.Context(), declared); err == nil && over {
			http.Error(w, "server storage is full", http.StatusInsufficientStorage)
			return
		}
		if over, err := s.overStorage(r.Context(), u.ID, declared); err == nil && over {
			http.Error(w, "storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
			return
		}
		if over, err := s.overTraffic(r.Context(), u.ID, declared); err == nil && over {
			http.Error(w, "monthly traffic limit reached — upgrade to continue", http.StatusTooManyRequests)
			return
		}
	}
```

Then clamp TTL to the plan after `resolveRetention` produces `ttl`:

```go
	if cap := s.planRetentionCap(r.Context(), u.ID); cap > 0 && ttl > cap {
		ttl = cap
	}
```

> These gates are pre-checks on the client-declared size (fail-fast, trusted only to reject — same trust model as the existing daily-quota pre-check). The physical `cappedReader`/`ReserveUpload` remain the authoritative byte-count guards.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run 'TestUploadRefusedOverStorage|TestUploadRefusedOverTraffic' -v` → PASS.
Regression: `go test ./internal/account/ -run 'Upload|Files|Download' 2>&1 | tail -5` → ok.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/files.go server/internal/account/files_plan_test.go
git commit -m "feat(billing): enforce plan storage/traffic/retention on single-shot upload"
```

---

### Task 7: enforce plan limits on resumable upload

**Files:**
- Modify: `server/internal/account/uploads_resumable.go` (`handleUploadInit` pre-check gates + TTL clamp; `handleUploadFinalize` authoritative storage+traffic gate)
- Test: `server/internal/account/uploads_resumable_test.go` (add)

**Interfaces:**
- Consumes: `overGlobalStorage`, `overStorage`, `overTraffic`, `planRetentionCap` (Task 5). `handleUploadInit` already resolves `billable`, `declared` (from `?size=`), `ttl`.

- [ ] **Step 1: Write the failing test**

Add to `uploads_resumable_test.go`:

```go
func TestResumableUploadInitRefusedOverTraffic(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "rtr@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "rtr@example.com", "")
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1 << 30, TrafficBytes: 10, RetentionSecs: 3 * 86400, Active: true, UpdatedAt: 1})
	_ = store.SetUserPlan(context.Background(), u.ID, "free")

	// initUploadStatus posts ?size=100 (see helper); 100 > 10-byte traffic cap.
	if code := initUploadStatus(t, ts, cookie, []byte("M")); code != http.StatusTooManyRequests {
		t.Fatalf("over-traffic init = %d, want 429", code)
	}
}
```

> `newFileServer` in this test file returns `(ts, svc, store, mail)` — match the existing calls in `uploads_resumable_test.go`. `initUploadStatus` already posts `?size=100` (added earlier); if its size differs, adjust the plan cap so `size > cap`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestResumableUploadInitRefusedOverTraffic -v`
Expected: FAIL — init returns 200.

- [ ] **Step 3: Add init gates + finalize gate**

In `handleUploadInit`, after the existing central physical-disk cap block and after `declared` is parsed (the `?size=` value), add — mirroring Task 6:

```go
	if billable {
		if over, err := s.overGlobalStorage(r.Context(), declared); err == nil && over {
			http.Error(w, "server storage is full", http.StatusInsufficientStorage)
			return
		}
		if over, err := s.overStorage(r.Context(), u.ID, declared); err == nil && over {
			http.Error(w, "storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
			return
		}
		if over, err := s.overTraffic(r.Context(), u.ID, declared); err == nil && over {
			http.Error(w, "monthly traffic limit reached — upgrade to continue", http.StatusTooManyRequests)
			return
		}
	}
```

Clamp `ttl` to the plan before building the session:

```go
	if cap := s.planRetentionCap(r.Context(), u.ID); cap > 0 && ttl > cap {
		ttl = cap
	}
```

In `handleUploadFinalize`, add the AUTHORITATIVE gate on the real byte count (`size := sess.received`) — right after `sess.done = true` and before `ReserveUpload`, only for `sess.billable`:

```go
	if sess.billable {
		if over, err := s.overStorage(r.Context(), u.ID, size); err == nil && over {
			s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
			s.resumable.del(id)
			http.Error(w, "storage limit reached — free up space or upgrade", http.StatusRequestEntityTooLarge)
			return
		}
		if over, err := s.overTraffic(r.Context(), u.ID, size); err == nil && over {
			s.dropBlob(sess.bs, sess.blobKey, sess.nodeID)
			s.resumable.del(id)
			http.Error(w, "monthly traffic limit reached — upgrade to continue", http.StatusTooManyRequests)
			return
		}
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run 'Resumable' -race -v 2>&1 | tail -15` → PASS (all resumable tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/uploads_resumable.go server/internal/account/uploads_resumable_test.go
git commit -m "feat(billing): enforce plan limits on resumable upload (init pre-check + finalize)"
```

---

### Task 8: enforce plan traffic on download

**Files:**
- Modify: `server/internal/account/files.go` (`handleFileBlob`: refuse before streaming when the OWNER is over traffic)
- Test: `server/internal/account/files_plan_test.go` (add)

**Interfaces:**
- Consumes: `overTraffic` (Task 5). Gate on the file's `sf.UserID` (owner), not the anonymous downloader.

> Place the gate right after `liveFile` resolves `sf` and before `GetRange`/streaming, for BOTH `start==0` and Range resumes (a resumed download of an over-quota owner is also refused). Use `add = sf.Size - start` (bytes this request would serve) so a resume is judged on what it will egress; simpler and safe: use `sf.Size`. Use `sf.Size` for a single clear rule.

- [ ] **Step 1: Write the failing test**

Add to `files_plan_test.go`:

```go
func TestDownloadRefusedWhenOwnerOverTraffic(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "ow@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "ow@example.com", "")
	// Generous storage so the upload itself succeeds; tiny traffic so the
	// download trips the cap. Upload first (counts some traffic), then shrink.
	setUserPlanWith(t, store, u.ID, 1<<30, 1<<30, 3*86400)

	resp := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), []byte("PAYLOAD")))
	var up struct{ ID string `json:"id"` }
	decodeJSON(t, resp, &up)

	// Now set the owner's traffic cap below their month-to-date usage.
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1 << 30, TrafficBytes: 1, RetentionSecs: 3 * 86400, Active: true, UpdatedAt: 2})

	br, _ := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	br.Body.Close()
	if br.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("download for over-quota owner = %d, want 429", br.StatusCode)
	}
}
```

> `decodeJSON` and `postUpload`/`uploadBody` are existing helpers in `files_test.go`.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestDownloadRefusedWhenOwnerOverTraffic -v`
Expected: FAIL — download returns 200.

- [ ] **Step 3: Add the gate**

In `handleFileBlob`, immediately after `sf, ok := s.liveFile(...)` succeeds and before `blobFor`/`GetRange`:

```go
	// Per-plan traffic gate, charged to the file's OWNER (downloader identity is
	// never read — zero-knowledge). Over quota → the owner's shares pause until
	// the month rolls over or they upgrade. Fail-open on a read error.
	if over, err := s.overTraffic(r.Context(), sf.UserID, sf.Size); err == nil && over {
		http.Error(w, "this file's account has reached its monthly traffic limit", http.StatusTooManyRequests)
		return
	}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run 'TestDownloadRefusedWhenOwnerOverTraffic|BlobRange|DownloadCount' -v 2>&1 | tail -10` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/files.go server/internal/account/files_plan_test.go
git commit -m "feat(billing): refuse download when the file owner is over monthly traffic"
```

---

### Task 9: enforce plan traffic on relay (ICE) and retire the global relay-free setting

**Files:**
- Modify: `server/internal/account/turn.go` (`handleICE`: replace `RelayMonthlyFree` check with `overTraffic(owner, 0)`)
- Modify: `server/internal/account/settings.go` (remove `SettingRelayMonthlyFree`, `Settings.RelayMonthlyFree`, its `resolveSettings` + `SeedSettings` entries)
- Modify: `server/internal/account/service.go` (remove `Config.RelayMonthlyFree`)
- Modify: `server/internal/account/admin.go` + `admin_templates.go` (remove the `relay_monthly_free_mb` form field + its parse/update)
- Test: `server/internal/account/turn_test.go` (add/adjust)

**Interfaces:**
- Consumes: `overTraffic` (Task 5).

> The ICE relay check becomes: if the code owner is already over their plan traffic (`add=0`), withhold TURN and set `relayDenied="quota"`. Free plan's 2 GB traffic default preserves today's behavior.

- [ ] **Step 1: Write the failing test**

Add to `turn_test.go` (match the existing ICE test harness there for constructing a Service + a valid pair code owner):

```go
func TestICEWithholdsTURNWhenOwnerOverPlanTraffic(t *testing.T) {
	// Build the ICE service with a valid pair code → owner, a TURN secret, and a
	// verified owner whose plan traffic is exhausted. Assert the response has no
	// turn: entry but keeps stun:, and relayDenied == "quota".
	// (Fill in using the existing turn_test.go setup — see TestHandleICE*.)
}
```

> Read the existing `turn_test.go` to reuse its Service construction (pairCodeOwner injection, `EmailVerified` stub, TURN config). Seed a plan with `TrafficBytes: 1`, record ≥1 byte of relay/upload for the owner in the current month via `RecordMeter`/`RecordUsage`, then assert `withheld`.

- [ ] **Step 2: Run test to verify it fails / build breaks**

Run: `go test ./internal/account/ -run TestICEWithholdsTURNWhenOwnerOverPlanTraffic -v` → FAIL (TURN still issued), or build failure once the setting is removed — fix references.

- [ ] **Step 3: Swap the check and remove the setting**

In `turn.go`, replace the `RelayMonthlyFree` block:

```go
	// Per-plan traffic gate: withhold TURN when the code's owner is already over
	// their plan's monthly traffic (relay + staged upload/download combined).
	// P2P direct still works; only relay is withheld. Fail-open on a read error.
	if validCode {
		if over, err := s.overTraffic(r.Context(), owner, 0); err != nil {
			log.Printf("relay quota read failed for owner %s: %v (fail-open, issuing relay)", owner, err)
		} else if over {
			validCode = false
			relayDenied = "quota"
		}
	}
```

Remove `SettingRelayMonthlyFree` + `RelayMonthlyFree` from `settings.go` (`Settings`, `resolveSettings`, `SeedSettings`), `Config.RelayMonthlyFree` from `service.go`, and the `relay_monthly_free_mb` field from `admin_templates.go` + its `atoi("relay_monthly_free_mb")`/`ok5`/`{SettingRelayMonthlyFree, ...}` lines in `admin.go` (renumber the `okN` checks accordingly).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run 'ICE|TURN|Relay' -v 2>&1 | tail -15` → PASS. `go build ./...` → ok. Grep to confirm removal: `grep -rn RelayMonthlyFree internal/ | grep -v _test` → no results.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/turn.go server/internal/account/settings.go server/internal/account/service.go server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/turn_test.go
git commit -m "feat(billing): relay ICE enforces per-plan traffic; retire relay_monthly_free setting"
```

---

### Task 10: admin plans-management section + global disk cap

**Files:**
- Modify: `server/internal/account/admin.go` (GET renders plans; POST `/admin/plans` upserts one plan; POST for `storage_disk_cap`)
- Modify: `server/internal/account/admin_templates.go` (plans table/edit forms + disk-cap input)
- Modify: `server/internal/account/handlers.go` (register `POST /admin/plans`)
- Test: `server/internal/account/admin_plans_test.go` (create)

**Interfaces:**
- Consumes: `ListPlans`, `UpsertPlan`, `GetPlan`, `CountActivePlans`, `SetSetting`, `resolveSettings` (Tasks 1, 3).

> Validation: all byte/sec/price fields non-negative ints; refuse an edit that would set the last active plan to inactive (`CountActivePlans` would drop to 0). Reuse the admin auth wrapper the existing `/admin/settings` POST uses.

- [ ] **Step 1: Write the failing test**

Create `admin_plans_test.go`:

```go
package account

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestAdminUpsertPlanUpdatesValues(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	admin := loginAdminCookie(t, ts, store, mail, "admin@example.com") // see admin_test.go helper
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})

	form := url.Values{
		"id": {"free"}, "name": {"Free"},
		"storage_mb": {"200"}, "traffic_gb": {"5"}, "retention_days": {"7"},
		"price_monthly_cents": {"0"}, "price_yearly_cents": {"0"},
		"sort_order": {"0"}, "active": {"1"},
	}
	req, _ := http.NewRequest("POST", ts.URL+"/admin/plans", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.AddCookie(admin)
	resp, _ := ts.Client().Do(req)
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("upsert plan = %d, want 302", resp.StatusCode)
	}
	got, _, _ := store.GetPlan(context.Background(), "free")
	if got.StorageBytes != 200<<20 || got.TrafficBytes != 5<<30 || got.RetentionSecs != 7*86400 {
		t.Fatalf("plan not updated: %+v", got)
	}
}
```

> Read `admin_test.go` for the exact admin-cookie helper name/signature (e.g. how existing admin POST tests authenticate) and match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestAdminUpsertPlanUpdatesValues -v`
Expected: FAIL — route 404.

- [ ] **Step 3: Add handler, route, template**

`handlers.go` — register next to the existing admin settings POST:

```go
	mux.HandleFunc("POST /admin/plans", s.adminOnly(s.handleAdminUpsertPlan))
```

(Use whatever admin-guard wrapper `POST /admin/settings` uses — match it exactly.)

`admin.go` — add the handler:

```go
func (s *Service) handleAdminUpsertPlan(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	id := strings.TrimSpace(r.FormValue("id"))
	name := strings.TrimSpace(r.FormValue("name"))
	nn := func(k string) (int64, bool) { // non-negative int
		n, err := strconv.ParseInt(strings.TrimSpace(r.FormValue(k)), 10, 64)
		return n, err == nil && n >= 0
	}
	storageMB, ok1 := nn("storage_mb")
	trafficGB, ok2 := nn("traffic_gb")
	retDays, ok3 := nn("retention_days")
	pm, ok4 := nn("price_monthly_cents")
	py, ok5 := nn("price_yearly_cents")
	sort, ok6 := nn("sort_order")
	active := r.FormValue("active") == "1"
	if id == "" || name == "" || !(ok1 && ok2 && ok3 && ok4 && ok5 && ok6) {
		http.Error(w, "invalid plan (non-negative integers; id/name required)", http.StatusBadRequest)
		return
	}
	// Never leave zero active plans.
	if !active {
		if n, err := s.store.CountActivePlans(r.Context()); err == nil {
			if cur, ok, _ := s.store.GetPlan(r.Context(), id); ok && cur.Active && n <= 1 {
				http.Error(w, "at least one plan must stay active", http.StatusBadRequest)
				return
			}
		}
	}
	p := Plan{
		ID: id, Name: name,
		StorageBytes: storageMB << 20, TrafficBytes: trafficGB << 30,
		RetentionSecs: retDays * 86400, PriceMonthly: pm, PriceYearly: py,
		SortOrder: sort, Active: active, UpdatedAt: s.now().Unix(),
	}
	if err := s.store.UpsertPlan(r.Context(), p); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}
```

Also fold `storage_disk_cap` into the existing `/admin/settings` POST (add `storageCapMB, ok := atoi("storage_disk_cap_mb")` and `{SettingStorageDiskCap, storageCapMB * 1024 * 1024}` to its updates slice), and add its input to the settings form.

`admin_templates.go` — render a "套餐 / Plans" section: a table of `ListPlans` with one edit form per row (hidden `id`, inputs pre-filled from the plan converted to MB/GB/days/cents, `active` checkbox), POSTing to `/admin/plans`. Add the `.Plans` field to the admin page view-model in `admin.go` where it renders (populate via `s.store.ListPlans`). Add a `storage_disk_cap_mb` input to the settings form.

> Read `admin.go` for how the admin page view-model is assembled and `admin_templates.go` for the existing settings-form markup; mirror that style. Convert stored bytes → display units in the view-model (add fields like `StorageMB`, `TrafficGB`, `RetentionDays` on a small view struct, or compute in the template with a helper).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run 'TestAdminUpsertPlan|Admin' -v 2>&1 | tail -10` → PASS. `go build ./...` → ok.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/handlers.go server/internal/account/admin_plans_test.go
git commit -m "feat(billing): admin plans-management section + global disk-cap setting"
```

---

### Task 11: admin user plan assignment

**Files:**
- Modify: `server/internal/account/admin.go` (user list shows `plan_id`; POST `/admin/users/plan` sets it — active plans only)
- Modify: `server/internal/account/admin_templates.go` (per-user plan dropdown)
- Modify: `server/internal/account/handlers.go` (register route)
- Test: `server/internal/account/admin_plans_test.go` (add)

**Interfaces:**
- Consumes: `SetUserPlan` (Task 2), `ListPlans`, `GetPlan` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `admin_plans_test.go`:

```go
func TestAdminAssignUserPlanActiveOnly(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	admin := loginAdminCookie(t, ts, store, mail, "admin2@example.com")
	ctx := context.Background()
	_ = store.UpsertPlan(ctx, Plan{ID: "pro", Name: "Pro", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: true, UpdatedAt: 1})
	_ = store.UpsertPlan(ctx, Plan{ID: "old", Name: "Old", StorageBytes: 1, TrafficBytes: 1, RetentionSecs: 1, Active: false, UpdatedAt: 1})
	target, _ := store.UpsertUserByEmail(ctx, "target@example.com", "")

	post := func(plan string) int {
		form := url.Values{"user_id": {target.ID}, "plan_id": {plan}}
		req, _ := http.NewRequest("POST", ts.URL+"/admin/users/plan", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.AddCookie(admin)
		resp, _ := ts.Client().Do(req)
		resp.Body.Close()
		return resp.StatusCode
	}

	if post("pro") != http.StatusFound {
		t.Fatal("assigning an active plan should 302")
	}
	if got, _ := store.GetUserByID(ctx, target.ID); got.PlanID != "pro" {
		t.Fatalf("plan = %q, want pro", got.PlanID)
	}
	if post("old") != http.StatusBadRequest {
		t.Fatal("assigning an inactive plan must 400")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/account/ -run TestAdminAssignUserPlanActiveOnly -v` → FAIL (route 404).

- [ ] **Step 3: Add handler, route, template control**

`handlers.go`:

```go
	mux.HandleFunc("POST /admin/users/plan", s.adminOnly(s.handleAdminSetUserPlan))
```

`admin.go`:

```go
func (s *Service) handleAdminSetUserPlan(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad form", http.StatusBadRequest)
		return
	}
	userID := strings.TrimSpace(r.FormValue("user_id"))
	planID := strings.TrimSpace(r.FormValue("plan_id"))
	if userID == "" || planID == "" {
		http.Error(w, "user_id and plan_id required", http.StatusBadRequest)
		return
	}
	p, ok, err := s.store.GetPlan(r.Context(), planID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if !ok || !p.Active {
		http.Error(w, "unknown or inactive plan", http.StatusBadRequest)
		return
	}
	if err := s.store.SetUserPlan(r.Context(), userID, planID); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}
```

`admin_templates.go` — in the user list row, add a small form: a `<select name="plan_id">` of active plans (current one pre-selected) + hidden `user_id` + submit, POSTing to `/admin/users/plan`. Ensure the admin user-list view-model includes each user's `PlanID` (it comes from `GetUserByID`/the list query — verify the admin user-list query selects `plan_id`; if it uses a dedicated `AdminListUsers`, add `plan_id` to that SELECT + scan too).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/account/ -run 'TestAdminAssignUserPlan|Admin' -v 2>&1 | tail -10` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/handlers.go server/internal/account/admin_plans_test.go
git commit -m "feat(billing): admin per-user plan assignment (active plans only)"
```

---

### Task 12: end-to-end Free-plan enforcement + full suite

**Files:**
- Test: `server/internal/account/billing_e2e_test.go` (create)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the end-to-end test**

Create `billing_e2e_test.go`:

```go
package account

import (
	"bytes"
	"context"
	"net/http"
	"testing"
)

// A Free user (small storage, small traffic, short retention) is blocked by
// each gate and has TTL clamped.
func TestFreePlanEndToEnd(t *testing.T) {
	ts, _, store, mail := newFileServer(t)
	cookie := loginCookie(t, ts, mail, "free@example.com")
	u, _ := store.UpsertUserByEmail(context.Background(), "free@example.com", "")
	// storage 100 bytes, traffic 500 bytes, retention 3 days.
	_ = store.UpsertPlan(context.Background(), Plan{ID: "free", Name: "Free", StorageBytes: 100, TrafficBytes: 500, RetentionSecs: 3 * 86400, Active: true, UpdatedAt: 1})
	_ = store.SetUserPlan(context.Background(), u.ID, "free")

	// Small upload succeeds and its TTL is clamped to <= 3 days even if asked for more.
	resp := postUpload(t, ts, cookie, "?ttl=9999999", uploadBody([]byte("m"), []byte("hi")))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("small upload = %d, want 200", resp.StatusCode)
	}
	var up struct {
		ID        string `json:"id"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	decodeJSON(t, resp, &up)
	// expiresAt must be within ~3 days of now.
	// (now() in the test server — assert the delta is <= 3*86400 + slack.)

	// Upload beyond the 100-byte storage cap → 413.
	big := postUpload(t, ts, cookie, "?ttl=0", uploadBody([]byte("m"), bytes.Repeat([]byte("A"), 300)))
	if big.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("over-storage upload = %d, want 413", big.StatusCode)
	}
}
```

> Refine the TTL assertion using the test server's clock (`newFileServer` fixes `now`); assert `up.ExpiresAt - now <= 3*86400`.

- [ ] **Step 2: Run it (should pass on the built stack)**

Run: `go test ./internal/account/ -run TestFreePlanEndToEnd -v` → PASS.

- [ ] **Step 3: Full package + race**

Run:
```bash
go test ./internal/account/ -race 2>&1 | tail -5
go build ./... && go vet ./...
```
Expected: `ok`, clean build/vet.

- [ ] **Step 4: Commit**

```bash
git add server/internal/account/billing_e2e_test.go
git commit -m "test(billing): end-to-end Free-plan storage/traffic/retention enforcement"
```

---

## Self-Review Notes

- **Spec coverage:** plans table (T1), user assignment (T2/T11), global disk gate (T3/T6/T7), CurrentMonthTraffic/CurrentStorage (T4/T5), upload storage+traffic (T6/T7), download traffic (T8), relay traffic (T9), retention convergence (T6/T7), admin plans mgmt (T10), admin user assignment (T11), P2P-unaffected (implicit — no code touches direct paths; T9 keeps STUN). All spec rows mapped.
- **Addendum coverage:** resumable upload (T7), download Range/resume gate (T8, gates before streaming for both start values), relay-free retirement (T9), CurrentMonthTraffic aggregate (T5), physical+logical disk caps both kept (T6/T7 call `overGlobalStorage` in addition to the existing physical `blobDiskMax` block).
- **Type consistency:** helper names `overStorage/overTraffic/overGlobalStorage/planRetentionCap/planForUser/currentMonthTraffic` used consistently T5→T9; store methods `ListPlans/GetPlan/UpsertPlan/CountActivePlans/SetUserPlan/UserMonthlyUpDown/CurrentStorage/GlobalStorageUsed` consistent T1→T11.
- **Verify-before-code hooks:** several tasks say "read the existing helper/harness and match" (admin cookie helper, `newFileServer` arity, `reader()` vs `db`, admin view-model). These are real integration points the implementer must confirm against current code, not placeholders in the logic.
