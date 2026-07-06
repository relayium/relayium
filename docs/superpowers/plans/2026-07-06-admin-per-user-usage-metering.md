# Admin Per-User Usage Metering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-user, per-month upload/download/relay traffic and current storage occupancy in the `/admin` dashboard, backed by a new monthly rollup ledger.

**Architecture:** Add a `usage_monthly` rollup table written incrementally on each upload/download (relay is derived per-month from the existing `usage_events`, because coturn reports cumulative bytes with MAX-per-alloc dedup and can't be summed into a rollup). The admin per-user list and metric cards become scoped to a selectable month; storage is a live snapshot from `stored_files`.

**Tech Stack:** Go, `modernc.org/sqlite` (pure-Go SQLite), `html/template`. Tests are standard `go test` in `server/internal/account`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-06-admin-per-user-usage-metering-design.md`.
- Period bucket = `YYYYMM` in **UTC**: `time.Unix(at,0).UTC().Format("200601")`.
- Metering writes are **best-effort** (`_ =`): a metering failure must never fail the user's upload/download, matching existing `AddUploadStat`/`AddDownloadStat`.
- Relay per-month is **derived from `usage_events`** (never written to `usage_monthly`).
- Storage per user = `SUM(stored_files.size) WHERE expires_at > now` — live snapshot, period-independent.
- **No historical backfill**: past months read 0.
- Downloads count against the file **owner** only; no downloader identity is read or stored (preserve zero-knowledge).
- All Go from repo root uses module path `github.com/relayium/relayium`. Run tests with `cd server && go test ./internal/account/...`.
- Follow existing file conventions: schema lives in the `schema` const in `sqlite.go` (uses `CREATE TABLE IF NOT EXISTS`, so no ALTER needed for the new table); Chinese comments/labels match surrounding code.

---

### Task 1: Monthly ledger core — table, `periodOf`, `RecordMeter`, `MonthlyUsage`

**Files:**
- Modify: `server/internal/account/sqlite.go` (schema const; add `periodOf`, `RecordMeter`, `MonthlyUsage`; add `fmt` import)
- Modify: `server/internal/account/store.go` (add `UsageKind` type + consts; add two interface methods)
- Test: `server/internal/account/usage_monthly_test.go` (create)

**Interfaces:**
- Produces:
  - `type UsageKind int` with `const ( MeterUpload UsageKind = iota; MeterDownload )`
  - `periodOf(at int64) string` → `"YYYYMM"` UTC (package-private, in sqlite.go)
  - `(s *SQLiteStore) RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error`
  - `(s *SQLiteStore) MonthlyUsage(ctx context.Context, userID, period string) (upload, download int64, err error)`

- [ ] **Step 1: Add the table to the schema const**

In `server/internal/account/sqlite.go`, inside the `schema` string constant, immediately after the `user_stats` table block (just before the closing `` ` ``), add:

```sql
CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id        TEXT    NOT NULL REFERENCES users(id),
  period         TEXT    NOT NULL,
  upload_bytes   INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (user_id, period)
);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_period ON usage_monthly(period);
```

- [ ] **Step 2: Add `UsageKind` type and metering interface methods to store.go**

In `server/internal/account/store.go`, add near the other domain types (e.g. just above `type UserStats struct`):

```go
// UsageKind selects which per-month meter a RecordMeter call increments.
type UsageKind int

const (
	MeterUpload UsageKind = iota
	MeterDownload
)
```

In the `Store` interface, after the `AddUploadStat`/`AddDownloadStat`/`GetUserStats` group, add a new block:

```go
	// usage_monthly (per-month billing ledger: upload/download bytes; relay is
	// derived from usage_events, not stored here)
	RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error
	MonthlyUsage(ctx context.Context, userID, period string) (upload, download int64, err error)
```

- [ ] **Step 3: Write the failing test**

Create `server/internal/account/usage_monthly_test.go`:

```go
package account

import (
	"context"
	"testing"
)

func TestRecordMeterAccumulatesWithinPeriod(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "m@example.com", "M")

	// Two uploads + one download in the same month (Jan 2026).
	jan := int64(1_767_312_000) // 2026-01-02 00:00:00 UTC
	if err := s.RecordMeter(ctx, u.ID, MeterUpload, 100, jan); err != nil {
		t.Fatalf("record upload: %v", err)
	}
	if err := s.RecordMeter(ctx, u.ID, MeterUpload, 50, jan+3600); err != nil {
		t.Fatalf("record upload 2: %v", err)
	}
	if err := s.RecordMeter(ctx, u.ID, MeterDownload, 30, jan+7200); err != nil {
		t.Fatalf("record download: %v", err)
	}

	up, down, err := s.MonthlyUsage(ctx, u.ID, "202601")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if up != 150 || down != 30 {
		t.Fatalf("want up=150 down=30, got up=%d down=%d", up, down)
	}
}

func TestRecordMeterSeparatesPeriodsAndMissingIsZero(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "m@example.com", "M")

	jan := int64(1_767_312_000) // 2026-01
	feb := int64(1_769_990_400) // 2026-02-02 00:00:00 UTC
	_ = s.RecordMeter(ctx, u.ID, MeterUpload, 100, jan)
	_ = s.RecordMeter(ctx, u.ID, MeterUpload, 7, feb)

	if up, _, _ := s.MonthlyUsage(ctx, u.ID, "202601"); up != 100 {
		t.Fatalf("jan upload want 100, got %d", up)
	}
	if up, _, _ := s.MonthlyUsage(ctx, u.ID, "202602"); up != 7 {
		t.Fatalf("feb upload want 7, got %d", up)
	}
	// A period with no rows reads as zero, not an error.
	up, down, err := s.MonthlyUsage(ctx, u.ID, "202512")
	if err != nil || up != 0 || down != 0 {
		t.Fatalf("empty period want 0,0,nil; got %d,%d,%v", up, down, err)
	}
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestRecordMeter -v`
Expected: FAIL — compile error, `RecordMeter`/`MonthlyUsage`/`MeterUpload` undefined.

- [ ] **Step 5: Implement `periodOf`, `RecordMeter`, `MonthlyUsage`**

In `server/internal/account/sqlite.go`, add `"fmt"` to the import block. Then add these functions (place near the other stored-file/stats methods):

```go
// periodOf maps a unix timestamp to its billing month bucket 'YYYYMM' (UTC).
func periodOf(at int64) string { return time.Unix(at, 0).UTC().Format("200601") }

// RecordMeter adds a one-shot upload/download event to the user's current-month
// bucket, creating the row on first use. Relay is NOT metered here (derived from
// usage_events). Callers treat this as best-effort.
func (s *SQLiteStore) RecordMeter(ctx context.Context, userID string, kind UsageKind, bytes, at int64) error {
	var col string
	switch kind {
	case MeterUpload:
		col = "upload_bytes"
	case MeterDownload:
		col = "download_bytes"
	default:
		return fmt.Errorf("account: unknown usage kind %d", kind)
	}
	// col comes from a fixed switch above (never user input), so interpolating it
	// into the statement is safe; bytes/user/period stay parameterized.
	q := `INSERT INTO usage_monthly (user_id, period, ` + col + `, updated_at)
	      VALUES (?, ?, ?, ?)
	      ON CONFLICT(user_id, period) DO UPDATE SET
	        ` + col + ` = ` + col + ` + excluded.` + col + `,
	        updated_at = excluded.updated_at`
	_, err := s.db.ExecContext(ctx, q, userID, periodOf(at), bytes, at)
	return err
}

// MonthlyUsage returns the user's upload/download bytes for a 'YYYYMM' period
// (0,0 when there is no row).
func (s *SQLiteStore) MonthlyUsage(ctx context.Context, userID, period string) (upload, download int64, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT COALESCE(upload_bytes,0), COALESCE(download_bytes,0)
		 FROM usage_monthly WHERE user_id = ? AND period = ?`, userID, period).
		Scan(&upload, &download)
	if err == sql.ErrNoRows {
		return 0, 0, nil
	}
	return upload, download, err
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run TestRecordMeter -v`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/sqlite.go server/internal/account/store.go server/internal/account/usage_monthly_test.go
git commit -m "feat(account): usage_monthly ledger + RecordMeter/MonthlyUsage"
```

---

### Task 2: Wire `RecordMeter` into the upload and download handlers

**Files:**
- Modify: `server/internal/account/files.go:138` (after `AddUploadStat`) and `files.go:197` (after `AddDownloadStat`)
- Test: `server/internal/account/files_metering_test.go` (create)

**Interfaces:**
- Consumes: `RecordMeter`, `MonthlyUsage`, `MeterUpload`, `MeterDownload` (Task 1); test harness `newFileServer`, `loginCookie`, `uploadBody`, `postUpload` (existing in `files_test.go`).

- [ ] **Step 1: Write the failing test**

Create `server/internal/account/files_metering_test.go`:

```go
package account

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestUploadAndDownloadRecordMonthlyMeter(t *testing.T) {
	ts, svc, store, mail := newFileServer(t)
	ctx := context.Background()
	period := periodOf(svc.now().Unix())

	cookie := loginCookie(t, ts, mail, "owner@example.com")

	// Upload a 200-byte ciphertext blob (well under the 1024 test MaxFileSize).
	blob := bytes.Repeat([]byte("x"), 200)
	resp := postUpload(t, ts, cookie, "?burnAfterRead=0&ttl=3600", uploadBody([]byte("manifest"), blob))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("upload status = %d", resp.StatusCode)
	}
	var up struct {
		ID  string `json:"id"`
		Key string `json:"key"`
	}
	// Response carries id + expiresAt; decode id for the download.
	var raw map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&raw)
	resp.Body.Close()
	up.ID, _ = raw["id"].(string)
	if up.ID == "" {
		t.Fatal("no file id in upload response")
	}

	// Find the user to read their meter.
	owner, _ := store.UpsertUserByEmail(ctx, "owner@example.com", "owner")
	if u, _, _ := store.MonthlyUsage(ctx, owner.ID, period); u != 200 {
		t.Fatalf("after upload: monthly upload = %d, want 200", u)
	}

	// Download the blob (public endpoint, no auth) to completion.
	dl, err := ts.Client().Get(ts.URL + "/api/files/" + up.ID + "/blob")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	_, _ = io.Copy(io.Discard, dl.Body)
	dl.Body.Close()
	if dl.StatusCode != http.StatusOK {
		t.Fatalf("download status = %d", dl.StatusCode)
	}

	if _, d, _ := store.MonthlyUsage(ctx, owner.ID, period); d != 200 {
		t.Fatalf("after download: monthly download = %d, want 200", d)
	}
	_ = time.Now
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestUploadAndDownloadRecordMonthlyMeter -v`
Expected: FAIL — after-upload assertion `monthly upload = 0, want 200` (meter not wired yet).

- [ ] **Step 3: Wire the upload meter**

In `server/internal/account/files.go`, find (around line 138):

```go
	// Lifetime stats are best-effort: a stats write failure must not fail the
	// upload the user already completed.
	_ = s.store.AddUploadStat(r.Context(), u.ID, size)
```

Add immediately after it:

```go
	_ = s.store.RecordMeter(r.Context(), u.ID, MeterUpload, size, now)
```

(`now` is the `s.now().Unix()` value already computed earlier in `handleUploadFile`.)

- [ ] **Step 4: Wire the download meter**

In `server/internal/account/files.go`, find (around line 197):

```go
	_ = s.store.AddDownloadStat(r.Context(), sf.UserID, sf.Size)
```

Add immediately after it:

```go
	_ = s.store.RecordMeter(r.Context(), sf.UserID, MeterDownload, sf.Size, s.now().Unix())
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestUploadAndDownloadRecordMonthlyMeter -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/files.go server/internal/account/files_metering_test.go
git commit -m "feat(account): meter upload/download bytes into usage_monthly"
```

---

### Task 3: Per-month admin user list — `monthRange` + `AdminListUsers` columns

**Files:**
- Modify: `server/internal/account/store.go` (`AdminUserRow`, `AdminUserQuery`)
- Modify: `server/internal/account/sqlite.go` (add `monthRange`; rewrite `AdminListUsers` query + scan + sort whitelist)
- Test: `server/internal/account/admin_metering_test.go` (create)

**Interfaces:**
- Consumes: `usage_monthly` rows (Task 1/2), `usage_events`, `stored_files`.
- Produces:
  - `monthRange(period string) (start, end int64)` — `[start, end)` unix for a `YYYYMM` month (UTC); `(0,0)` on parse error.
  - `AdminUserRow` gains `UploadBytes, DownloadBytes, StorageBytes int64`; `RelayedBytes` now holds the **selected period's** relay bytes.
  - `AdminUserQuery` gains `Period string` and `Now int64`.

- [ ] **Step 1: Extend the row and query structs**

In `server/internal/account/store.go`, update `AdminUserRow`:

```go
type AdminUserRow struct {
	ID            string
	Email         string
	DisplayName   string
	CreatedAt     int64
	Methods       []string // identities 表里的 provider 去重升序
	DeviceCount   int
	RelayedBytes  int64 // 选定月的中继流量（来自 usage_events）
	UploadBytes   int64 // 选定月上传（usage_monthly）
	DownloadBytes int64 // 选定月下载（usage_monthly）
	StorageBytes  int64 // 当前存储占用（未过期文件 size 之和，与月份无关）
}
```

Update `AdminUserQuery` — add `Period` and `Now`, and extend the `SortBy` doc:

```go
type AdminUserQuery struct {
	Search  string // 空 = 不过滤;非空按 email/display_name 模糊匹配
	SortBy  string // "created"|"email"|"relayed"|"upload"|"download"|"storage";非法回退 "created"
	SortDir string // "asc"|"desc";非法回退 "desc"
	Period  string // 'YYYYMM'，决定上传/下载/中继列的口径
	Now     int64  // 用于存储占用的"未过期"判定
	Limit   int
	Offset  int
}
```

- [ ] **Step 2: Write the failing test**

Create `server/internal/account/admin_metering_test.go`:

```go
package account

import (
	"context"
	"testing"
)

func TestAdminListUsersPeriodColumns(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "a@example.com", "A")

	jan := int64(1_767_312_000) // 2026-01-02 UTC
	feb := int64(1_769_990_400) // 2026-02-02 UTC
	// Jan: 100 up, 40 down; Feb: 7 up (must not leak into Jan).
	_ = s.RecordMeter(ctx, u.ID, MeterUpload, 100, jan)
	_ = s.RecordMeter(ctx, u.ID, MeterDownload, 40, jan)
	_ = s.RecordMeter(ctx, u.ID, MeterUpload, 7, feb)
	// Relay: 500 bytes recorded in Jan.
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "al1", Token: "t", UserID: u.ID, RelayedBytes: 500, RecordedAt: jan + 10})
	// Storage: one live file (size 900) + one expired (size 111, excluded).
	now := feb + 100
	_ = s.CreateStoredFile(ctx, StoredFile{ID: "f1", UserID: u.ID, BlobKey: "b1", EncManifest: []byte("m"), Size: 900, CreatedAt: now, ExpiresAt: now + 1000})
	_ = s.CreateStoredFile(ctx, StoredFile{ID: "f2", UserID: u.ID, BlobKey: "b2", EncManifest: []byte("m"), Size: 111, CreatedAt: jan, ExpiresAt: now - 1})

	rows, total, err := s.AdminListUsers(ctx, AdminUserQuery{
		Period: "202601", Now: now, Limit: 50, Offset: 0,
	})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if total != 1 || len(rows) != 1 {
		t.Fatalf("want 1 user, got total=%d rows=%d", total, len(rows))
	}
	r := rows[0]
	if r.UploadBytes != 100 || r.DownloadBytes != 40 {
		t.Fatalf("jan up/down want 100/40, got %d/%d", r.UploadBytes, r.DownloadBytes)
	}
	if r.RelayedBytes != 500 {
		t.Fatalf("jan relay want 500, got %d", r.RelayedBytes)
	}
	if r.StorageBytes != 900 {
		t.Fatalf("storage want 900 (expired excluded), got %d", r.StorageBytes)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestAdminListUsersPeriodColumns -v`
Expected: FAIL — compile error (`AdminUserRow` has no `UploadBytes` scan yet / query returns old shape).

- [ ] **Step 4: Add `monthRange` and rewrite `AdminListUsers`**

In `server/internal/account/sqlite.go`, add near `periodOf`:

```go
// monthRange returns [start, end) unix seconds for a 'YYYYMM' period (UTC).
// Returns (0,0) if period is malformed.
func monthRange(period string) (start, end int64) {
	t, err := time.Parse("200601", period)
	if err != nil {
		return 0, 0
	}
	return t.Unix(), t.AddDate(0, 1, 0).Unix()
}
```

In `AdminListUsers`, replace the `orderCol` switch to accept the new sort keys:

```go
	orderCol := "u.created_at"
	switch q.SortBy {
	case "email":
		orderCol = "u.email"
	case "relayed":
		orderCol = "relayed_bytes"
	case "upload":
		orderCol = "upload_bytes"
	case "download":
		orderCol = "download_bytes"
	case "storage":
		orderCol = "storage_bytes"
	}
```

Replace the list query + args + scan. The subqueries appear before the `WHERE` clause, so their placeholders bind first, then `whereArgs`, then LIMIT/OFFSET:

```go
	mStart, mEnd := monthRange(q.Period)
	listArgs := append([]any{mStart, mEnd, q.Period, q.Period, q.Now}, whereArgs...)
	listArgs = append(listArgs, q.Limit, q.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.email, u.display_name, u.created_at,
		       (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id),
		       (SELECT COALESCE(SUM(e.relayed_bytes),0) FROM usage_events e
		          WHERE e.user_id = u.id AND e.recorded_at >= ? AND e.recorded_at < ?) AS relayed_bytes,
		       (SELECT COALESCE(um.upload_bytes,0) FROM usage_monthly um
		          WHERE um.user_id = u.id AND um.period = ?) AS upload_bytes,
		       (SELECT COALESCE(um.download_bytes,0) FROM usage_monthly um
		          WHERE um.user_id = u.id AND um.period = ?) AS download_bytes,
		       (SELECT COALESCE(SUM(sf.size),0) FROM stored_files sf
		          WHERE sf.user_id = u.id AND sf.expires_at > ?) AS storage_bytes
		FROM users u`+where+`
		ORDER BY `+orderCol+` `+dir+`, u.id ASC
		LIMIT ? OFFSET ?`, listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
```

Update the scan loop to read the three new columns:

```go
		var row AdminUserRow
		if err := rows.Scan(&row.ID, &row.Email, &row.DisplayName, &row.CreatedAt,
			&row.DeviceCount, &row.RelayedBytes,
			&row.UploadBytes, &row.DownloadBytes, &row.StorageBytes); err != nil {
			return nil, 0, err
		}
```

(The `total` COUNT query and the provider-fan-out second pass are unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestAdminListUsersPeriodColumns -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/admin_metering_test.go
git commit -m "feat(account): per-month upload/download/relay + storage in AdminListUsers"
```

---

### Task 4: Per-period `AdminMetrics` cards

**Files:**
- Modify: `server/internal/account/store.go` (`AdminMetrics` struct fields)
- Modify: `server/internal/account/sqlite.go` (`AdminMetrics` signature + query)
- Test: append to `server/internal/account/admin_metering_test.go`

**Interfaces:**
- Produces: `AdminMetrics` fields become `TotalUsers, ActiveStoredFiles, ActiveStoredBytes, UploadBytes, DownloadBytes, RelayBytes int64`; signature `AdminMetrics(ctx context.Context, period string, now int64) (AdminMetrics, error)`.

- [ ] **Step 1: Update the `AdminMetrics` struct**

In `server/internal/account/store.go`, replace the `AdminMetrics` struct:

```go
// AdminMetrics 是后台首页的快照指标。存储/用户/文件为当前快照;上传/下载/中继为选定月合计。
type AdminMetrics struct {
	TotalUsers        int64
	ActiveStoredFiles int64 // 未过期暂存文件数(expires_at > now)
	ActiveStoredBytes int64 // 上述文件 size 之和(近似当前磁盘占用)
	UploadBytes       int64 // 选定月上传合计
	DownloadBytes     int64 // 选定月下载合计
	RelayBytes        int64 // 选定月中继合计
}
```

Also update the interface line in `Store`:

```go
	AdminMetrics(ctx context.Context, period string, now int64) (AdminMetrics, error)
```

- [ ] **Step 2: Write the failing test**

Append to `server/internal/account/admin_metering_test.go`:

```go
func TestAdminMetricsPerPeriod(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u1, _ := s.UpsertUserByEmail(ctx, "a@example.com", "A")
	u2, _ := s.UpsertUserByEmail(ctx, "b@example.com", "B")

	jan := int64(1_767_312_000) // 2026-01
	_ = s.RecordMeter(ctx, u1.ID, MeterUpload, 100, jan)
	_ = s.RecordMeter(ctx, u2.ID, MeterUpload, 20, jan)
	_ = s.RecordMeter(ctx, u1.ID, MeterDownload, 5, jan)
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "al", Token: "t", UserID: u1.ID, RelayedBytes: 300, RecordedAt: jan + 5})

	now := jan + 1000
	_ = s.CreateStoredFile(ctx, StoredFile{ID: "f1", UserID: u1.ID, BlobKey: "b", EncManifest: []byte("m"), Size: 900, CreatedAt: now, ExpiresAt: now + 1000})

	m, err := s.AdminMetrics(ctx, "202601", now)
	if err != nil {
		t.Fatalf("metrics: %v", err)
	}
	if m.TotalUsers != 2 {
		t.Fatalf("users want 2, got %d", m.TotalUsers)
	}
	if m.UploadBytes != 120 || m.DownloadBytes != 5 || m.RelayBytes != 300 {
		t.Fatalf("period totals want 120/5/300, got %d/%d/%d", m.UploadBytes, m.DownloadBytes, m.RelayBytes)
	}
	if m.ActiveStoredFiles != 1 || m.ActiveStoredBytes != 900 {
		t.Fatalf("storage want 1/900, got %d/%d", m.ActiveStoredFiles, m.ActiveStoredBytes)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestAdminMetricsPerPeriod -v`
Expected: FAIL — signature mismatch / new fields absent.

- [ ] **Step 4: Rewrite the `AdminMetrics` implementation**

In `server/internal/account/sqlite.go`, replace the whole `AdminMetrics` function:

```go
func (s *SQLiteStore) AdminMetrics(ctx context.Context, period string, now int64) (AdminMetrics, error) {
	start, end := monthRange(period)
	var m AdminMetrics
	err := s.db.QueryRowContext(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM users),
		  (SELECT COUNT(*) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(upload_bytes),0) FROM usage_monthly WHERE period = ?),
		  (SELECT COALESCE(SUM(download_bytes),0) FROM usage_monthly WHERE period = ?),
		  (SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE recorded_at >= ? AND recorded_at < ?)`,
		now, now, period, period, start, end,
	).Scan(&m.TotalUsers, &m.ActiveStoredFiles, &m.ActiveStoredBytes,
		&m.UploadBytes, &m.DownloadBytes, &m.RelayBytes)
	if err != nil {
		return AdminMetrics{}, err
	}
	return m, nil
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestAdminMetricsPerPeriod -v`
Expected: PASS. (The admin home handler in `admin.go` still calls the old 2-arg signature — it will fail to compile in the full build; that is fixed in Task 5. Run the targeted test only here.)

- [ ] **Step 6: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/admin_metering_test.go
git commit -m "feat(account): AdminMetrics per-period upload/download/relay totals"
```

---

### Task 5: Admin UI — month selector, columns, cards, sort wiring

**Files:**
- Modify: `server/internal/account/admin.go` (home handler: period parsing, month list, sort whitelist, pass period/now; `adminListHref` gains a `period` param)
- Modify: `server/internal/account/admin_templates.go` (`adminHomeData` fields; cards; month selector; table columns + sort headers; a `humanPeriod` display helper)
- Test: `server/internal/account/admin_metering_ui_test.go` (create)

**Interfaces:**
- Consumes: `AdminListUsers` (Period, Now), `AdminMetrics(ctx, period, now)`, `periodOf`.

- [ ] **Step 1: Update `adminListHref` to carry `period`**

In `server/internal/account/admin.go`, change the signature and body of `adminListHref`:

```go
// adminListHref builds a /admin list link, keeping only non-default params, URL-encoded.
func adminListHref(search, sort, dir, period string, page int) string {
	v := url.Values{}
	if search != "" {
		v.Set("q", search)
	}
	if sort != "" {
		v.Set("sort", sort)
	}
	if dir != "" {
		v.Set("dir", dir)
	}
	if period != "" {
		v.Set("period", period)
	}
	if page > 1 {
		v.Set("page", strconv.Itoa(page))
	}
	if len(v) == 0 {
		return "/admin"
	}
	return "/admin?" + v.Encode()
}
```

- [ ] **Step 2: Parse period + build the month list in the home handler**

In `server/internal/account/admin.go`, inside the home handler (the function containing `metrics, err := s.store.AdminMetrics(...)`), do three edits.

(a) Widen the sort whitelist. Replace:

```go
	sortBy := q.Get("sort")
	if sortBy != "email" && sortBy != "relayed" {
		sortBy = "created"
	}
```

with:

```go
	sortBy := q.Get("sort")
	switch sortBy {
	case "email", "relayed", "upload", "download", "storage":
	default:
		sortBy = "created"
	}
```

(b) After `now := s.now().Unix()`, derive the selected period and the last-12-month option list, and validate the requested period against that list:

```go
	now := s.now().Unix()
	months := recentMonths(now, 12)
	period := q.Get("period")
	if !contains(months, period) {
		period = months[0] // default = current month
	}
```

(c) Change the metrics + list calls to pass the period (and `Now` for storage). Replace the `AdminMetrics(r.Context(), now)` call with `AdminMetrics(r.Context(), period, now)`, and add `Period: period, Now: now` to BOTH `AdminListUsers(...)` query literals (the initial one and the clamp-refetch one):

```go
	metrics, err := s.store.AdminMetrics(r.Context(), period, now)
```

```go
	rows, total, err := s.store.AdminListUsers(r.Context(), AdminUserQuery{
		Search: search, SortBy: sortBy, SortDir: dir,
		Period: period, Now: now,
		Limit: adminUsersPerPage, Offset: (page - 1) * adminUsersPerPage,
	})
```

(and the identical struct inside the `if page > totalPages` refetch block.)

(d) Update every `adminListHref(...)` call to pass `period`. The `sortHref` loop and prev/next builders. Replace the sort-link section:

```go
	sortHref := map[string]string{}
	for _, col := range []string{"created", "email", "relayed", "upload", "download", "storage"} {
		nd := "desc"
		if sortBy == col && dir == "desc" {
			nd = "asc"
		}
		sortHref[col] = adminListHref(search, col, nd, period, 1)
	}
	prev, next := "", ""
	if page > 1 {
		prev = adminListHref(search, sortBy, dir, period, page-1)
	}
	if page < totalPages {
		next = adminListHref(search, sortBy, dir, period, page+1)
	}
```

(e) Add `Period` and `Months` to the `adminHomeData` literal:

```go
		Search: search, Sort: sortBy, Dir: dir, Period: period, Months: months,
```

- [ ] **Step 3: Add the `recentMonths`/`contains` helpers**

In `server/internal/account/admin.go`, add (near `adminListHref`):

```go
// recentMonths returns the last n billing periods ('YYYYMM', UTC), newest first,
// where index 0 is the month containing `now`.
func recentMonths(now int64, n int) []string {
	first := time.Unix(now, 0).UTC()
	first = time.Date(first.Year(), first.Month(), 1, 0, 0, 0, 0, time.UTC)
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, first.AddDate(0, -i, 0).Format("200601"))
	}
	return out
}

func contains(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
}
```

Ensure `admin.go` imports `"time"` (add it to the import block if absent).

- [ ] **Step 4: Update `adminHomeData` + template data plumbing**

In `server/internal/account/admin_templates.go`, add two fields to `adminHomeData`:

```go
	Period     string            // 选定月 'YYYYMM'
	Months     []string          // 最近 12 个月（下拉，最新在前）
```

Add a period-formatting func to the `adminUsersTmpl` FuncMap (next to `ts`/`bytes`):

```go
	"period": func(p string) string {
		if t, err := time.Parse("200601", p); err == nil {
			return t.Format("2006-01")
		}
		return p
	},
```

- [ ] **Step 5: Replace the metric cards**

In `server/internal/account/admin_templates.go`, replace the three rolling-window cards (the `RelayedBytes24h`, `RelayedBytes7d`, `UploadedBytes24h` lines) with three period cards:

```html
<div class="card"><div class="n">{{bytes .Metrics.UploadBytes}}</div><div class="l">上传 · {{period .Period}}</div></div>
<div class="card"><div class="n">{{bytes .Metrics.DownloadBytes}}</div><div class="l">下载 · {{period .Period}}</div></div>
<div class="card"><div class="n">{{bytes .Metrics.RelayBytes}}</div><div class="l">中继 · {{period .Period}}</div></div>
```

(Keep the `TotalUsers`, `ActiveStoredFiles`, `ActiveStoredBytes` cards as-is.)

- [ ] **Step 6: Add the month selector**

In `server/internal/account/admin_templates.go`, add a month `<form>` just above the `注册用户` header block. It submits GET to `/admin`, preserving search/sort/dir as hidden fields:

```html
<div class="top"><h2>用量月份</h2>
<form method="get" action="/admin" class="search">
<input type="hidden" name="q" value="{{.Search}}"><input type="hidden" name="sort" value="{{.Sort}}"><input type="hidden" name="dir" value="{{.Dir}}">
<select name="period" onchange="this.form.submit()">
{{$sel := .Period}}{{range .Months}}<option value="{{.}}"{{if eq . $sel}} selected{{end}}>{{period .}}</option>{{end}}
</select>
<noscript><button type="submit">切换</button></noscript>
</form></div>
```

- [ ] **Step 7: Add the table columns + sort headers + cells**

In `server/internal/account/admin_templates.go`, in the users table header row, replace the single relay header:

```html
<th><a href="{{index .SortHref "relayed"}}">中继流量</a></th>
```

with four period-scoped headers:

```html
<th><a href="{{index .SortHref "upload"}}">上传</a></th>
<th><a href="{{index .SortHref "download"}}">下载</a></th>
<th><a href="{{index .SortHref "relayed"}}">中继</a></th>
<th><a href="{{index .SortHref "storage"}}">存储占用</a></th>
```

And in the row body, replace:

```html
<td>{{.DeviceCount}}</td><td>{{bytes .RelayedBytes}}</td>
```

with:

```html
<td>{{.DeviceCount}}</td>
<td>{{bytes .UploadBytes}}</td><td>{{bytes .DownloadBytes}}</td>
<td>{{bytes .RelayedBytes}}</td><td>{{bytes .StorageBytes}}</td>
```

- [ ] **Step 8: Write the failing test**

Create `server/internal/account/admin_metering_ui_test.go`:

```go
package account

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// adminSessionGet logs into the dashboard, GETs path, and returns the body HTML.
func adminSessionGet(t *testing.T, ts *httptest.Server, path string) string {
	t.Helper()
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	_, _ = client.PostForm(ts.URL+"/admin/login",
		map[string][]string{"username": {"admin"}, "password": {"s3cret"}})
	resp, err := client.Get(ts.URL + path)
	if err != nil {
		t.Fatalf("get %s: %v", path, err)
	}
	b, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get %s => %d", path, resp.StatusCode)
	}
	return string(b)
}

func TestAdminDashboardShowsPerUserColumns(t *testing.T) {
	// newAdminServer (admin_test.go) already seeds one user and sets admin creds.
	ts := newAdminServer(t, "admin", "s3cret")

	html := adminSessionGet(t, ts, "/admin")
	for _, want := range []string{"上传", "下载", "存储占用", "用量月份", `name="period"`} {
		if !strings.Contains(html, want) {
			t.Fatalf("dashboard missing %q", want)
		}
	}
}
```

Note: `newAdminServer` (in `admin_test.go`) returns `*httptest.Server` and already sets the admin password to whatever you pass — here `"s3cret"`. If `admin_test.go` already defines a login helper you can reuse, prefer it over `adminSessionGet`.

- [ ] **Step 9: Run test to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestAdminDashboardShowsPerUserColumns -v`
Expected: FAIL first as a **compile error** across the package until Steps 1–7 are in; once compiling, it passes. If it fails on a missing string, re-check the template edits.

- [ ] **Step 10: Build + run the whole package**

Run: `cd server && go build ./... && go test ./internal/account/ -v`
Expected: PASS — all metering tests plus the existing admin/files/sqlite suites. This confirms the Task 4 signature change is now consistent with the Task 5 caller.

- [ ] **Step 11: Commit**

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/admin_metering_ui_test.go
git commit -m "feat(admin): per-month usage columns, cards, and month selector"
```

---

## Self-Review Notes

- **Spec coverage:** `usage_monthly` table + index (Task 1) ✓; `RecordMeter` upload/download best-effort wiring at the two documented call sites (Task 2) ✓; relay derived from `usage_events` per month (Tasks 3/4, never written to the rollup) ✓; storage live snapshot excluding expired (Tasks 3/4) ✓; `AdminUserRow`/`AdminUserQuery` period fields + sort keys `upload/download/relayed/storage` (Task 3) ✓; `AdminMetrics(period, now)` with three snapshot + three period cards (Task 4) ✓; month selector defaulting to current month + `?period=` query param preserving search/sort (Task 5) ✓; no backfill (nothing populates past months) ✓; UTC month bucket via `periodOf`/`monthRange` ✓; download attributed to owner only ✓.
- **Signature consistency:** `RecordMeter(ctx, userID, kind, bytes, at)`, `MonthlyUsage(ctx, userID, period)`, `monthRange(period) (start,end)`, `AdminMetrics(ctx, period, now)`, `adminListHref(search, sort, dir, period, page)` are used identically across tasks.
- **Deferred to the billing plan (#2):** `CurrentMonthTraffic` reader, `plans` table, quota enforcement — out of scope here; this plan only records + displays.
