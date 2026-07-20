# 管理员后台步进认证 + 审计日志 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `/admin` 的 6 个高危写操作加上"先看 diff 再验第二因子"的确认流程，并把全部写操作与登录事件记入永久审计表。

**Architecture:** 高危路由包一层 `requireStepUp` 中间件：拦截 POST → 表单存入会话绑定的 `pendingActions` → 渲染带 diff 的确认页 → 验证第二因子（passkey > TOTP > 密码）→ 取出表单执行原 handler → 写审计。diff 计算独立成模块，低危操作不走确认页但共用它写审计。

**Tech Stack:** Go 1.x、SQLite（`internal/account/sqlite.go`）、`github.com/pquerna/otp/totp`、`github.com/go-webauthn/webauthn`、`html/template`（`admin_templates.go`）

Spec：`docs/superpowers/specs/2026-07-20-admin-stepup-2fa-and-audit-log-design.md`

## Global Constraints

- 所有代码在 `server/` 模块内，命令均从 `server/` 目录执行。
- 注释与文档用中文或英文均可，**与所修改文件的既有风格保持一致**（`admin.go` 中英混排，`passkey_login.go` 以英文长注释为主）。
- commit message 一律英文（项目约定）。
- 提交前必须 `gofmt -l internal/ cmd/` 无输出。已知既有不干净文件：`internal/selfupdate/selfupdate_test.go`、`internal/signal/guessbreaker_test.go` —— **不要顺手格式化它们**，不属于本次范围。
- **绝不写入审计表的三类值**：fleet token 明文、passkey 的 `cred_json` blob、管理员密码。
- `changes` JSON 一律存**存储层原始值**（bytes / secs），不存表单的 MB/GB/天。
- 高危操作共 6 个：`settings.update`、`plan.upsert`、`user.plan`、`node.delete`、`token.mint`、`passkey.delete`。
- 低危操作共 3 个：`node.limits`、`node.label`、`token.revoke` —— 记日志但不拦截。
- 步进宽限期 60 秒；pending action TTL 5 分钟。

---

## 阶段一：审计日志（Task 1–4，完成后即可独立上线）

### Task 1: 审计表与 store 方法

**Files:**
- Modify: `server/internal/account/sqlite.go`（schema 常量末尾 ~line 226；`migrations` 列表 ~line 338 之后）
- Modify: `server/internal/account/store.go`（`AuditEntry` 结构 + Store 接口）
- Test: `server/internal/account/audit_store_test.go`（新建）

**Interfaces:**
- Produces: `AuditEntry` 结构体；`Store.InsertAudit(ctx, AuditEntry) error`；`Store.ListAudit(ctx, limit, offset int, action string) ([]AuditEntry, error)`

- [ ] **Step 1: 写失败的测试**

创建 `server/internal/account/audit_store_test.go`：

```go
package account

import (
	"context"
	"testing"
)

func TestAuditRoundTrip(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	e := AuditEntry{
		At: 1700000000, Actor: "admin", IP: "203.0.113.7", Auth: "passkey",
		Action: "settings.update", Target: "-",
		Changes: `[{"field":"daily_quota","old":209715200,"new":419430400}]`,
		StepUp:  "totp",
	}
	if err := store.InsertAudit(ctx, e); err != nil {
		t.Fatalf("InsertAudit: %v", err)
	}
	got, err := store.ListAudit(ctx, 10, 0, "")
	if err != nil {
		t.Fatalf("ListAudit: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 entry, got %d", len(got))
	}
	if got[0].Action != "settings.update" || got[0].StepUp != "totp" || got[0].Changes != e.Changes {
		t.Fatalf("round-trip mismatch: %+v", got[0])
	}
	if got[0].ID == 0 {
		t.Fatal("want a non-zero autoincrement id")
	}
}

// 倒序是审计页的默认视图：最近的操作必须排在最前。
func TestAuditListIsNewestFirst(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	for _, at := range []int64{100, 300, 200} {
		if err := store.InsertAudit(ctx, AuditEntry{
			At: at, Actor: "admin", IP: "-", Auth: "password",
			Action: "node.label", Target: "node:x", Changes: "[]", StepUp: "",
		}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.ListAudit(ctx, 10, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].At != 300 || got[2].At != 100 {
		t.Fatalf("want 300,200,100 order, got %v", []int64{got[0].At, got[1].At, got[2].At})
	}
}

func TestAuditFilterByAction(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	for _, a := range []string{"login.ok", "node.delete", "login.ok"} {
		if err := store.InsertAudit(ctx, AuditEntry{
			At: 1, Actor: "admin", IP: "-", Auth: "password",
			Action: a, Target: "-", Changes: "[]", StepUp: "",
		}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.ListAudit(ctx, 10, 0, "login.ok")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 login.ok entries, got %d", len(got))
	}
}

// 分页：offset 必须跳过最近的若干条，而不是从头返回。
func TestAuditPaging(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	for i := int64(1); i <= 5; i++ {
		if err := store.InsertAudit(ctx, AuditEntry{
			At: i, Actor: "admin", IP: "-", Auth: "password",
			Action: "node.label", Target: "-", Changes: "[]", StepUp: "",
		}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := store.ListAudit(ctx, 2, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].At != 3 || got[1].At != 2 {
		t.Fatalf("want at=3,2 on page 2, got %+v", got)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/account/ -run TestAudit`
Expected: FAIL，`undefined: AuditEntry`

- [ ] **Step 3: 加 schema**

在 `sqlite.go` 的 schema 常量里，`admin_credentials` 表定义之后、结尾的反引号之前插入：

```sql
CREATE TABLE IF NOT EXISTS admin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         INTEGER NOT NULL,
  actor      TEXT NOT NULL,
  ip         TEXT NOT NULL,
  auth       TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT NOT NULL,
  changes    TEXT NOT NULL,
  step_up    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC);
```

同时在 `migrations` 列表（`sqlite.go:338` 的 `billing_cycle` 那条之后）追加一条，让存量库也建表：

```go
		// 管理员操作审计（2026-07）。新库由 schema 常量建出，老库靠这条补。
		// CREATE TABLE IF NOT EXISTS 是幂等的，两条路径不会打架。
		`CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
  ip TEXT NOT NULL, auth TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
  changes TEXT NOT NULL, step_up TEXT NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC)`,
```

- [ ] **Step 4: 加 AuditEntry 与 Store 接口**

在 `store.go` 中 `Setting` 结构附近加：

```go
// AuditEntry 是一条管理员操作记录。永久保留，不参与 GC。
//
// Auth 与 StepUp 是两个不同的维度：Auth 是**建立当前会话**时用的登录方式，
// StepUp 是**这一次操作**实际验的第二因子。用 passkey 登录、用 TOTP 步进是
// 完全正常的组合，合并成一列就再也还原不出当时发生了什么。
type AuditEntry struct {
	ID     int64
	At     int64
	Actor  string
	IP     string
	Auth   string // "password" | "passkey"
	Action string
	Target string
	// Changes 是 []ChangeField 的 JSON。存**存储层原始值**（bytes/secs），
	// 不存表单里的 MB/GB/天 —— 单位混用会让日志和库里的实际值对不上。
	Changes string
	// StepUp: "" = 该操作无需步进；"grace" = 落在 60 秒宽限期内跳过了因子校验。
	// grace 必须单独标记而不是记成验过了，否则日志会在最要紧的地方说谎。
	StepUp string
}
```

在 Store 接口中加：

```go
	// InsertAudit 追加一条管理员操作记录。审计写入失败绝不能让业务操作回滚：
	// 调用方记录错误后继续（见 writeAudit）。
	InsertAudit(ctx context.Context, e AuditEntry) error
	// ListAudit 按时间倒序返回审计记录。action 非空时按动作过滤。
	ListAudit(ctx context.Context, limit, offset int, action string) ([]AuditEntry, error)
```

- [ ] **Step 5: 实现 SQLite 方法**

在 `sqlite.go` 末尾追加：

```go
func (s *SQLiteStore) InsertAudit(ctx context.Context, e AuditEntry) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO admin_audit (at, actor, ip, auth, action, target, changes, step_up)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		e.At, e.Actor, e.IP, e.Auth, e.Action, e.Target, e.Changes, e.StepUp)
	return err
}

func (s *SQLiteStore) ListAudit(ctx context.Context, limit, offset int, action string) ([]AuditEntry, error) {
	q := `SELECT id, at, actor, ip, auth, action, target, changes, step_up
	        FROM admin_audit`
	args := []any{}
	if action != "" {
		q += ` WHERE action = ?`
		args = append(args, action)
	}
	// id 作为次级排序键：同一秒内写入的多条记录（一次表单提交可能连着写）
	// 否则顺序不确定，分页会重复或漏行。
	q += ` ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AuditEntry
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.At, &e.Actor, &e.IP, &e.Auth,
			&e.Action, &e.Target, &e.Changes, &e.StepUp); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `go test ./internal/account/ -run TestAudit -v`
Expected: 4 个测试全部 PASS

- [ ] **Step 7: 提交**

```bash
gofmt -l internal/ && go test ./internal/account/
git add server/internal/account/sqlite.go server/internal/account/store.go server/internal/account/audit_store_test.go
git commit -m "feat(admin): add a permanent admin_audit table"
```

---

### Task 2: diff 计算模块

**Files:**
- Create: `server/internal/account/audit_diff.go`
- Test: `server/internal/account/audit_diff_test.go`

**Interfaces:**
- Consumes: Task 1 的 `AuditEntry`
- Produces: `ChangeField{Field string; Old, New any}`；`diffFields(before, after map[string]any) []ChangeField`；`encodeChanges([]ChangeField) string`

- [ ] **Step 1: 写失败的测试**

```go
package account

import (
	"encoding/json"
	"testing"
)

// 只记录真正变了的字段。表单每次提交全部 10 个设置项，若不过滤，
// 改一个值会产生 10 行"变更"，日志立刻失去可读性。
func TestDiffFieldsSkipsUnchanged(t *testing.T) {
	before := map[string]any{"a": int64(1), "b": int64(2)}
	after := map[string]any{"a": int64(1), "b": int64(99)}
	got := diffFields(before, after)
	if len(got) != 1 {
		t.Fatalf("want 1 changed field, got %d: %+v", len(got), got)
	}
	if got[0].Field != "b" || got[0].Old != int64(2) || got[0].New != int64(99) {
		t.Fatalf("unexpected change: %+v", got[0])
	}
}

// 字段顺序必须稳定，否则同样的改动在日志里每次长得不一样，没法比对。
func TestDiffFieldsIsSorted(t *testing.T) {
	before := map[string]any{"z": int64(1), "a": int64(1), "m": int64(1)}
	after := map[string]any{"z": int64(2), "a": int64(2), "m": int64(2)}
	got := diffFields(before, after)
	if len(got) != 3 || got[0].Field != "a" || got[1].Field != "m" || got[2].Field != "z" {
		t.Fatalf("want a,m,z order, got %+v", got)
	}
}

// 新增字段（before 里没有）记为 old=nil，用于节点删除这种没有前值的场景反向使用。
func TestDiffFieldsHandlesMissingBefore(t *testing.T) {
	got := diffFields(map[string]any{}, map[string]any{"x": int64(5)})
	if len(got) != 1 || got[0].Old != nil || got[0].New != int64(5) {
		t.Fatalf("want old=nil new=5, got %+v", got)
	}
}

func TestEncodeChangesIsValidJSON(t *testing.T) {
	s := encodeChanges([]ChangeField{{Field: "a", Old: int64(1), New: int64(2)}})
	var back []ChangeField
	if err := json.Unmarshal([]byte(s), &back); err != nil {
		t.Fatalf("encodeChanges produced invalid JSON %q: %v", s, err)
	}
	if len(back) != 1 || back[0].Field != "a" {
		t.Fatalf("round-trip mismatch: %+v", back)
	}
}

// 空变更必须编码成 "[]" 而不是 "null" —— 列是 NOT NULL，且 "null" 在
// 审计页上会渲染成字面量 null。
func TestEncodeChangesEmptyIsEmptyArray(t *testing.T) {
	if got := encodeChanges(nil); got != "[]" {
		t.Fatalf("want [], got %q", got)
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/account/ -run 'TestDiffFields|TestEncodeChanges'`
Expected: FAIL，`undefined: diffFields`

- [ ] **Step 3: 实现**

创建 `server/internal/account/audit_diff.go`：

```go
package account

import (
	"encoding/json"
	"sort"
)

// ChangeField 是一个字段的前后值。Old/New 用 any 是因为审计要覆盖 int64
// （配额、价格）和 string（标签、price id）两类；具体动作各自决定放什么。
type ChangeField struct {
	Field string `json:"field"`
	Old   any    `json:"old"`
	New   any    `json:"new"`
}

// diffFields 返回 after 相对 before 真正发生变化的字段，按字段名排序。
//
// 只保留变化项是刻意的：设置表单每次提交全部 10 个字段，全记会让"改了一个值"
// 淹没在 9 条无变化的记录里。排序则保证同样的改动在日志中呈现一致，便于比对。
func diffFields(before, after map[string]any) []ChangeField {
	keys := make([]string, 0, len(after))
	for k := range after {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var out []ChangeField
	for _, k := range keys {
		old, had := before[k]
		if had && old == after[k] {
			continue
		}
		if !had {
			old = nil
		}
		out = append(out, ChangeField{Field: k, Old: old, New: after[k]})
	}
	return out
}

// encodeChanges 序列化为审计表的 changes 列。永远返回合法 JSON 数组：
// 空切片必须是 "[]" 而不是 "null"，列是 NOT NULL，且审计页会把 null 原样渲染。
func encodeChanges(fields []ChangeField) string {
	if len(fields) == 0 {
		return "[]"
	}
	b, err := json.Marshal(fields)
	if err != nil {
		// 只可能在放入不可序列化值时发生，属于编程错误；返回合法空数组，
		// 绝不让审计写入因此失败而拖垮业务操作。
		return "[]"
	}
	return string(b)
}
```

- [ ] **Step 4: 运行确认通过**

Run: `go test ./internal/account/ -run 'TestDiffFields|TestEncodeChanges' -v`
Expected: 5 个 PASS

- [ ] **Step 5: 提交**

```bash
gofmt -l internal/ && go test ./internal/account/
git add server/internal/account/audit_diff.go server/internal/account/audit_diff_test.go
git commit -m "feat(admin): compute audit field diffs at the storage layer"
```

---

### Task 3: 审计写入助手 + 接上登录事件与 3 个低危端点

**Files:**
- Create: `server/internal/account/audit.go`
- Modify: `server/internal/account/admin.go`（`handleAdminLogin` ~315、`handleAdminLogout` ~345、`handleAdminNodeLimits` ~745、`handleAdminNodeLabel` ~770、`handleAdminRevokeToken` ~801）
- Modify: `server/internal/account/passkey_login.go`（`handleAdminPasskeyLoginFinish` ~236）
- Test: `server/internal/account/audit_test.go`

**Interfaces:**
- Consumes: Task 1 `Store.InsertAudit`；Task 2 `encodeChanges`、`ChangeField`
- Produces: `(*Service).writeAudit(r *http.Request, action, target string, fields []ChangeField, stepUp string)`

- [ ] **Step 1: 写失败的测试**

```go
package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// 审计写入失败绝不能让业务操作失败。管理员改了个标签，审计表写不进去时
// 标签仍然要改成功 —— 反过来会让一个日志故障演变成后台完全不可用。
func TestWriteAuditNeverBreaksTheRequest(t *testing.T) {
	_, svc, _, _ := newBillingServer(t)
	svc.cfg.AdminUser = "admin"
	req := httptest.NewRequest(http.MethodPost, "/admin/nodes/x/label", nil)
	// store 正常，只验证调用不 panic、不返回错误通道
	svc.writeAudit(req, "node.label", "node:x",
		[]ChangeField{{Field: "label", Old: "a", New: "b"}}, "")
}

func TestLoginSuccessIsAudited(t *testing.T) {
	ts, svc, store, _ := newAdminServer(t)
	form := strings.NewReader("username=admin&password=secret123")
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/admin/login", form)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	entries, err := store.ListAudit(context.Background(), 10, 0, "login.ok")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 login.ok audit entry, got %d", len(entries))
	}
	if entries[0].Auth != "password" {
		t.Fatalf("want auth=password, got %q", entries[0].Auth)
	}
	_ = svc
}

// 登录失败必须留痕 —— 这是现在完全缺失的线索：有人在撞密码时无从得知。
func TestLoginFailureIsAudited(t *testing.T) {
	ts, _, store, _ := newAdminServer(t)
	form := strings.NewReader("username=admin&password=wrong")
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/admin/login", form)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	entries, err := store.ListAudit(context.Background(), 10, 0, "login.fail")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("want 1 login.fail audit entry, got %d", len(entries))
	}
}

// 红线：审计表里绝不能出现管理员密码，哪怕是失败尝试里输错的那个。
func TestLoginFailureAuditNeverContainsThePassword(t *testing.T) {
	ts, _, store, _ := newAdminServer(t)
	const attempted = "hunter2-should-never-be-logged"
	form := strings.NewReader("username=admin&password=" + attempted)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/admin/login", form)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, _ := ts.Client().Do(req)
	if resp != nil {
		resp.Body.Close()
	}
	entries, _ := store.ListAudit(context.Background(), 10, 0, "")
	for _, e := range entries {
		blob := e.Changes + e.Target + e.Actor + e.IP
		if strings.Contains(blob, attempted) {
			t.Fatalf("the attempted password leaked into the audit row: %+v", e)
		}
	}
}
```

`newAdminServer` 是本任务要新增的测试助手（放在 `audit_test.go` 顶部）：

```go
// newAdminServer 起一个启用了 /admin 的服务，密码固定为 secret123。
// 现有的 newBillingServer 不配置管理员，所以 /admin 全部 404。
func newAdminServer(t *testing.T) (*httptest.Server, *Service, *SQLiteStore, *capturingMailer) {
	t.Helper()
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		AdminUser: "admin", AdminPassword: "secret123",
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, svc, store, mail
}
```

（需要 `import "time"` 和 `"net/http/httptest"`。）

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/account/ -run 'TestWriteAudit|TestLogin.*Audited|TestLoginFailureAuditNever'`
Expected: FAIL，`undefined: newAdminServer` / `svc.writeAudit undefined`

- [ ] **Step 3: 实现 writeAudit**

创建 `server/internal/account/audit.go`：

```go
package account

import (
	"log"
	"net/http"
)

// 审计动作名。集中定义而不是散在各 handler 里写字面量，
// 是为了让审计页的过滤下拉框和写入端不可能拼错到对不上。
const (
	AuditLoginOK       = "login.ok"
	AuditLoginFail     = "login.fail"
	AuditLogout        = "logout"
	AuditSettings      = "settings.update"
	AuditPlanUpsert    = "plan.upsert"
	AuditUserPlan      = "user.plan"
	AuditNodeDelete    = "node.delete"
	AuditNodeLimits    = "node.limits"
	AuditNodeLabel     = "node.label"
	AuditTokenMint     = "token.mint"
	AuditTokenRevoke   = "token.revoke"
	AuditPasskeyDelete = "passkey.delete"
)

// 步进因子取值。"" = 该操作无需步进；grace = 落在宽限期内跳过了校验。
const (
	StepUpNone     = ""
	StepUpPasskey  = "passkey"
	StepUpTOTP     = "totp"
	StepUpPassword = "password"
	StepUpGrace    = "grace"
)

// writeAudit 追加一条审计记录。
//
// **它绝不返回错误，也绝不让调用方失败。** 业务操作此时已经成功提交，把审计
// 写入失败上报成 500 会让管理员以为操作没生效而重试一次，反而造成二次变更。
// 写不进去就记到进程日志里，这是我们能做的最好补救。
func (s *Service) writeAudit(r *http.Request, action, target string, fields []ChangeField, stepUp string) {
	e := AuditEntry{
		At:      s.now().Unix(),
		Actor:   s.adminUsername(),
		IP:      s.clientIP(r),
		Auth:    s.adminAuthMethod(r),
		Action:  action,
		Target:  target,
		Changes: encodeChanges(fields),
		StepUp:  stepUp,
	}
	if err := s.store.InsertAudit(r.Context(), e); err != nil {
		log.Printf("admin audit write failed (action=%s target=%s): %v", action, target, err)
	}
}
```

- [ ] **Step 4: 加两个小助手**

在 `admin.go` 的 `isAdminReq` 附近加：

```go
// adminUsername 返回配置的管理员用户名，空则用默认值。管理员不是 users 表里
// 的行，而是配置身份，所以审计里的 actor 恒等于它 —— 真正有区分度的是 IP。
func (s *Service) adminUsername() string {
	if u := strings.TrimSpace(s.cfg.AdminUser); u != "" {
		return u
	}
	return defaultAdminUser
}

// adminAuthMethod 报告当前会话是怎么建立的（password / passkey）。
// Task 4 把会话结构换成 struct 后这里读的是真实值；在那之前先返回 ""。
func (s *Service) adminAuthMethod(r *http.Request) string {
	c, err := r.Cookie(adminCookie)
	if err != nil {
		return ""
	}
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	if sess, ok := s.adminSessions[c.Value]; ok {
		return sess.auth
	}
	return ""
}
```

> 注意：`adminAuthMethod` 依赖 Task 4 的会话结构体。**本任务先做 Task 4 的 Step 3–4（会话结构改造），再回来完成本步骤**——两者耦合，拆开会导致中间态编译不过。执行时把 Task 4 的会话改造并入本任务提交。
>
> `defaultAdminUser` 若不存在则新增常量 `const defaultAdminUser = "admin"`，并把 `admin.go:227-232` 里现有的字面量 `"admin"` 替换为它。

- [ ] **Step 5: 接上登录/登出事件**

`handleAdminLogin` 中，验证成功分支（`admin.go:336` 附近，`newAdminSession` 调用之后）加：

```go
	s.writeAudit(r, AuditLoginOK, "-", nil, StepUpNone)
```

验证失败分支（返回 401/重渲染登录页之前）加：

```go
	// 只记"有人试过且失败了"。绝不记录尝试的用户名或密码：
	// 用户名常被误输成密码，把它记下来等于把密码写进日志。
	s.writeAudit(r, AuditLoginFail, "-", nil, StepUpNone)
```

`handleAdminLogout` 删除会话之后加：

```go
	s.writeAudit(r, AuditLogout, "-", nil, StepUpNone)
```

`passkey_login.go` 的 `handleAdminPasskeyLoginFinish` 中 `newAdminSession` 之后加：

```go
	s.writeAudit(r, AuditLoginOK, "-", nil, StepUpNone)
```

- [ ] **Step 6: 接上 3 个低危端点**

`handleAdminNodeLimits`（`admin.go:745`）——在 `SetNodeLimits` 成功之后、重定向之前：

```go
	s.writeAudit(r, AuditNodeLimits, "node:"+id, []ChangeField{
		{Field: "traffic_limit_bytes", Old: before.TrafficLimitBytes, New: trafficBytes},
		{Field: "disk_limit_bytes", Old: before.DiskLimitBytes, New: diskBytes},
	}, StepUpNone)
```

需要在写入前先读一次前值（若 handler 尚未读取）：

```go
	before, _, err := s.store.GetNode(r.Context(), id)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
```

`handleAdminNodeLabel`（`admin.go:770`）同理：

```go
	s.writeAudit(r, AuditNodeLabel, "node:"+id,
		[]ChangeField{{Field: "label", Old: before.Label, New: label}}, StepUpNone)
```

`handleAdminRevokeToken`（`admin.go:801`）：

```go
	// 只记 token id，绝不记明文 —— 明文只在铸造时内联显示一次，库里存的是哈希。
	s.writeAudit(r, AuditTokenRevoke, "token:"+id,
		[]ChangeField{{Field: "revoked_at", Old: int64(0), New: s.now().Unix()}}, StepUpNone)
```

> 若 `GetNode` 方法名与实际不符，先 `grep -n "func (s \*SQLiteStore) GetNode" internal/account/sqlite.go` 确认签名后再用。

- [ ] **Step 7: 运行测试**

Run: `go test ./internal/account/ -v -run 'TestWriteAudit|TestLogin'`
Expected: 全部 PASS

- [ ] **Step 8: 全量测试 + 提交**

```bash
gofmt -l internal/ && go build ./... && go test ./...
git add server/internal/account/
git commit -m "feat(admin): audit login events and low-risk writes"
```

---

### Task 4: 管理员会话结构改造

> **执行提示：** 本任务与 Task 3 Step 4 相互依赖，建议合并到 Task 3 一起做、一起提交。此处单列是为了把改动点讲清楚。

**Files:**
- Modify: `server/internal/account/service.go:148`（字段类型）、`:209`（初始化）
- Modify: `server/internal/account/admin.go:269-297`（`newAdminSession`、`validAdmin`）、`:347-349`（logout 删除）
- Modify: `server/internal/account/passkey_login.go:236`（passkey 登录铸造点）
- Test: `server/internal/account/admin_session_test.go`

**Interfaces:**
- Produces: `adminSession{expires int64; auth string; lastStepUpAt int64}`；`newAdminSession(auth string) string`；`(*Service).markStepUp(tok string)`；`(*Service).stepUpFresh(tok string) bool`

- [ ] **Step 1: 写失败的测试**

```go
package account

import "testing"

func TestAdminSessionRecordsAuthMethod(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok := svc.newAdminSession("passkey")
	svc.adminMu.Lock()
	sess := svc.adminSessions[tok]
	svc.adminMu.Unlock()
	if sess.auth != "passkey" {
		t.Fatalf("want auth=passkey, got %q", sess.auth)
	}
}

// 宽限期：刚验过 → 新鲜；从未验过 → 不新鲜。
func TestStepUpFreshness(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok := svc.newAdminSession("password")
	if svc.stepUpFresh(tok) {
		t.Fatal("a brand-new session must NOT be step-up fresh")
	}
	svc.markStepUp(tok)
	if !svc.stepUpFresh(tok) {
		t.Fatal("want fresh right after markStepUp")
	}
}

// 宽限期必须真的会过期，否则一次验证就永久免验，等于没有步进。
func TestStepUpGraceExpires(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok := svc.newAdminSession("password")
	svc.markStepUp(tok)
	svc.adminMu.Lock()
	sess := svc.adminSessions[tok]
	sess.lastStepUpAt = svc.now().Unix() - int64(stepUpGraceSecs) - 1
	svc.adminSessions[tok] = sess
	svc.adminMu.Unlock()
	if svc.stepUpFresh(tok) {
		t.Fatal("a step-up older than the grace window must not count as fresh")
	}
}

// 会话过期仍必须照常生效（原有行为不能被结构改造破坏）。
func TestAdminSessionStillExpires(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok := svc.newAdminSession("password")
	svc.adminMu.Lock()
	sess := svc.adminSessions[tok]
	sess.expires = svc.now().Unix() - 1
	svc.adminSessions[tok] = sess
	svc.adminMu.Unlock()
	if svc.validAdmin(tok) {
		t.Fatal("an expired session must not validate")
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/account/ -run 'TestAdminSession|TestStepUp'`
Expected: FAIL，`sess.auth undefined (type int64 has no field auth)`

- [ ] **Step 3: 改会话结构**

`service.go:148` 把
```go
	adminSessions     map[string]int64 // token -> 过期 unix 秒
```
改为
```go
	// adminSessions: token -> 会话状态。原先只存过期时间，加入步进认证后还需要
	// 知道会话是怎么建立的（审计的 auth 列）以及上次步进是什么时候（宽限期）。
	adminSessions map[string]adminSession
```

`service.go:209` 的初始化 `adminSessions: map[string]int64{}` 改为 `adminSessions: map[string]adminSession{}`。

在 `admin.go` 顶部常量区加：

```go
// stepUpGraceSecs 是一次成功步进之后，同一会话内高危操作免再验第二因子的窗口。
//
// 存在的理由是 TOTP：totp.go 的单调计数器让同一个 30 秒窗口的验证码只能用一次，
// 没有宽限期的话连续两次高危操作必须干等下一个码。**确认页不受影响，照常展示**，
// 所以防误点击的能力一点没打折 —— 免掉的只是重复掉码。
const stepUpGraceSecs = 60
```

在 `admin.go` 的 `newAdminSession` 之前加类型：

```go
type adminSession struct {
	expires      int64  // unix 秒
	auth         string // "password" | "passkey"，建立会话时用的方式
	lastStepUpAt int64  // 上次步进成功的 unix 秒；0 = 从未步进
}
```

- [ ] **Step 4: 改三个方法 + 两个铸造点**

```go
func (s *Service) newAdminSession(auth string) string {
	tok := randToken()
	s.adminMu.Lock()
	s.adminSessions[tok] = adminSession{
		expires: s.now().Add(adminSessionTTL).Unix(), auth: auth,
	}
	s.adminMu.Unlock()
	return tok
}

func (s *Service) validAdmin(tok string) bool {
	if tok == "" {
		return false
	}
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	sess, ok := s.adminSessions[tok]
	if !ok {
		return false
	}
	if s.now().Unix() >= sess.expires {
		delete(s.adminSessions, tok)
		return false
	}
	return true
}

// markStepUp 记下这次步进成功的时刻，开启宽限期。
func (s *Service) markStepUp(tok string) {
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	if sess, ok := s.adminSessions[tok]; ok {
		sess.lastStepUpAt = s.now().Unix()
		s.adminSessions[tok] = sess
	}
}

// stepUpFresh 报告该会话是否仍在宽限期内。
func (s *Service) stepUpFresh(tok string) bool {
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	sess, ok := s.adminSessions[tok]
	if !ok || sess.lastStepUpAt == 0 {
		return false
	}
	return s.now().Unix()-sess.lastStepUpAt < stepUpGraceSecs
}
```

两个铸造点传入认证方式：
- `admin.go:336`（密码登录）：`tok := s.newAdminSession("password")`
- `passkey_login.go:236`：`tok := s.newAdminSession("passkey")`

- [ ] **Step 5: 运行测试确认通过**

Run: `go test ./internal/account/ -run 'TestAdminSession|TestStepUp' -v`
Expected: 4 个 PASS

- [ ] **Step 6: 提交**

```bash
gofmt -l internal/ && go build ./... && go test ./...
git add server/internal/account/
git commit -m "feat(admin): track auth method and step-up freshness on the session"
```

---

## 阶段二：步进认证（Task 5–8）

### Task 5: pendingActions 存储（安全关键）

**Files:**
- Create: `server/internal/account/stepup_pending.go`
- Modify: `server/internal/account/service.go`（新增两个字段）
- Test: `server/internal/account/stepup_pending_test.go`

**Interfaces:**
- Produces: `pendingAction{action string; sessionTok string; form url.Values; expires time.Time}`；`(*Service).putPending(sessionTok, action string, form url.Values) (string, bool)`；`(*Service).takePending(tok, sessionTok string) (pendingAction, bool)`

- [ ] **Step 1: 写失败的测试**

**本文件的第一个测试是整个功能最重要的一条**：

```go
package account

import (
	"net/url"
	"testing"
	"time"
)

// **最关键的一条测试。** pending token 若不绑定发起它的会话，任何拿到 token 的人
// 都能在自己的会话里兑现它 —— 步进认证被整个绕过。
func TestTakePendingRejectsADifferentSession(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok, ok := svc.putPending("session-A", "settings.update", url.Values{"a": {"1"}})
	if !ok {
		t.Fatal("putPending failed")
	}
	if _, ok := svc.takePending(tok, "session-B"); ok {
		t.Fatal("SECURITY: a pending action was redeemed from a different session")
	}
}

func TestTakePendingAcceptsTheOriginatingSession(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok, _ := svc.putPending("session-A", "settings.update", url.Values{"a": {"1"}})
	got, ok := svc.takePending(tok, "session-A")
	if !ok {
		t.Fatal("the originating session must be able to redeem")
	}
	if got.action != "settings.update" || got.form.Get("a") != "1" {
		t.Fatalf("form did not survive: %+v", got)
	}
}

// 一次性消费：重放同一个 token 必须失败，否则一次验证能执行任意多次操作。
func TestTakePendingIsOneShot(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok, _ := svc.putPending("s", "settings.update", url.Values{})
	if _, ok := svc.takePending(tok, "s"); !ok {
		t.Fatal("first redeem should succeed")
	}
	if _, ok := svc.takePending(tok, "s"); ok {
		t.Fatal("SECURITY: a pending action was redeemed twice")
	}
}

// 会话不匹配的尝试也必须烧掉 token —— 否则攻击者可以反复试探而不消耗它。
func TestWrongSessionBurnsThePendingToken(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok, _ := svc.putPending("s", "settings.update", url.Values{})
	_, _ = svc.takePending(tok, "attacker")
	if _, ok := svc.takePending(tok, "s"); ok {
		t.Fatal("a wrong-session attempt must burn the token, like takeCeremony does")
	}
}

func TestTakePendingRejectsExpired(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	tok, _ := svc.putPending("s", "settings.update", url.Values{})
	svc.pendingMu.Lock()
	p := svc.pendingActions[tok]
	p.expires = svc.now().Add(-time.Second)
	svc.pendingActions[tok] = p
	svc.pendingMu.Unlock()
	if _, ok := svc.takePending(tok, "s"); ok {
		t.Fatal("an expired pending action must not be redeemable")
	}
}

// 容量上限：拒绝而非驱逐。驱逐会让攻击者用洪泛把管理员正在进行的操作挤掉。
func TestPutPendingRejectsAtCap(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	for i := 0; i < pendingActionCap; i++ {
		if _, ok := svc.putPending("s", "settings.update", url.Values{}); !ok {
			t.Fatalf("unexpected rejection at i=%d", i)
		}
	}
	if _, ok := svc.putPending("s", "settings.update", url.Values{}); ok {
		t.Fatal("want rejection once the cap is reached")
	}
}
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/account/ -run TestTakePending`
Expected: FAIL，`svc.putPending undefined`

- [ ] **Step 3: 加 Service 字段**

`service.go` 在 `passkeyCeremonies` 附近加：

```go
	// pendingActions: 步进 token -> 待执行的高危操作。与 passkeyCeremonies 同构
	// （进程内、一次性、短 TTL、有上限），但多绑一个会话 token —— 见 takePending。
	pendingActions map[string]pendingAction
	pendingMu      sync.Mutex
```

初始化处（`service.go:209` 附近）加：`pendingActions: map[string]pendingAction{},`

- [ ] **Step 4: 实现**

创建 `server/internal/account/stepup_pending.go`：

```go
package account

import (
	"net/url"
	"time"
)

const (
	pendingActionTTL = 5 * time.Minute
	// pendingActionCap 限制在途的待确认操作数量。铸造需要已认证的管理员会话，
	// 所以这里不像 passkeyCeremonyCap 那样面对未认证洪泛，但仍然要有上限：
	// 管理员反复打开确认页却不提交，同样会让 map 无界增长。
	pendingActionCap = 256
)

// pendingAction 是一个已通过 CSRF 与认证、但尚未执行的高危操作。
type pendingAction struct {
	action string
	// sessionTok 是发起这个操作的管理员会话 cookie 值。
	//
	// **这是本功能的核心安全约束。** 不绑定会话的话，任何拿到 pending token 的人
	// 都能在自己的会话里兑现它，步进认证形同虚设 —— 与 passkey_login.go 里
	// ceremonyKind 注释描述的是同一类攻击：把一个上下文里铸出的凭据拿到另一个
	// 上下文去花掉。
	sessionTok string
	form       url.Values
	expires    time.Time
}

// putPending 暂存一个待确认操作，返回其 token。容量已满时返回 false，
// 调用方必须据此拒绝请求而不是继续往下走。
func (s *Service) putPending(sessionTok, action string, form url.Values) (string, bool) {
	tok := randToken()
	s.pendingMu.Lock()
	defer s.pendingMu.Unlock()
	now := s.now()
	for k, p := range s.pendingActions {
		if now.After(p.expires) {
			delete(s.pendingActions, k)
		}
	}
	if len(s.pendingActions) >= pendingActionCap {
		// 拒绝而非驱逐：驱逐会让洪泛把管理员正在确认的操作挤掉。
		return "", false
	}
	s.pendingActions[tok] = pendingAction{
		action: action, sessionTok: sessionTok, form: form,
		expires: now.Add(pendingActionTTL),
	}
	return tok, true
}

// takePending 一次性取出待执行操作，且只在 sessionTok 与铸造时一致才成功。
//
// 无条件删除（与 takeCeremony 同样的处理）：会话不匹配的尝试也要烧掉 token，
// 否则攻击者可以拿着它反复试探而不消耗掉这次机会。
func (s *Service) takePending(tok, sessionTok string) (pendingAction, bool) {
	if tok == "" || sessionTok == "" {
		return pendingAction{}, false
	}
	s.pendingMu.Lock()
	p, ok := s.pendingActions[tok]
	delete(s.pendingActions, tok)
	s.pendingMu.Unlock()
	if !ok || s.now().After(p.expires) {
		return pendingAction{}, false
	}
	// 常量时间比较不是必需的：token 是本地 map 的键，攻击者无法通过时序
	// 逐字节猜出它 —— 猜错一次就被上面的 delete 烧掉了。
	if p.sessionTok != sessionTok {
		return pendingAction{}, false
	}
	return p, true
}
```

- [ ] **Step 5: 运行确认通过**

Run: `go test ./internal/account/ -run 'TestTakePending|TestPutPending|TestWrongSession' -v`
Expected: 6 个 PASS

- [ ] **Step 6: 提交**

```bash
gofmt -l internal/ && go build ./... && go test ./...
git add server/internal/account/stepup_pending.go server/internal/account/stepup_pending_test.go server/internal/account/service.go
git commit -m "feat(admin): add session-bound pending-action storage for step-up"
```

---

### Task 6: beforeImage 注册表（settings 与 plans）

**Files:**
- Create: `server/internal/account/stepup_before.go`
- Test: `server/internal/account/stepup_before_test.go`

**Interfaces:**
- Consumes: Task 2 `ChangeField`、`diffFields`
- Produces: `(*Service).beforeImageFor(ctx context.Context, action string, form url.Values) (before, after map[string]any, target string, err error)`

- [ ] **Step 1: 写失败的测试**

```go
package account

import (
	"context"
	"net/url"
	"testing"
)

// 设置表单每次提交全部 10 项，只改一项时 diff 必须只有一行。
func TestBeforeImageSettingsDiffsOnlyChanged(t *testing.T) {
	_, svc, store, _ := newAdminServer(t)
	ctx := context.Background()
	if err := svc.SeedSettings(ctx); err != nil {
		t.Fatal(err)
	}
	cur, err := svc.resolveSettings(ctx)
	if err != nil {
		t.Fatal(err)
	}
	form := settingsFormFrom(cur)
	form.Set("daily_quota_mb", "400") // 只动这一项
	before, after, target, err := svc.beforeImageFor(ctx, AuditSettings, form)
	if err != nil {
		t.Fatal(err)
	}
	if target != "-" {
		t.Fatalf("settings target should be '-', got %q", target)
	}
	changes := diffFields(before, after)
	if len(changes) != 1 || changes[0].Field != SettingDailyQuota {
		t.Fatalf("want exactly the daily-quota change, got %+v", changes)
	}
	// 存储层原始值：400 MB = 419430400 字节，不是 400。
	if changes[0].New != int64(419430400) {
		t.Fatalf("want the byte value 419430400, got %v", changes[0].New)
	}
	_ = store
}

func TestBeforeImagePlanCapturesPriorRow(t *testing.T) {
	_, svc, store, _ := newAdminServer(t)
	ctx := context.Background()
	mustPlan(t, store, Plan{ID: "plus", Name: "Plus", Active: true,
		StorageBytes: 5 << 30, TrafficBytes: 300 << 30, RetentionSecs: 30 * 86400,
		PriceMonthly: 390, PriceYearly: 2900})
	form := url.Values{
		"id": {"plus"}, "name": {"Plus"}, "storage_mb": {"1024"},
		"traffic_gb": {"20"}, "retention_days": {"3"},
		"price_monthly": {"199"}, "price_yearly": {"1999"},
		"sort_order": {"1"}, "active": {"on"}, "daily_quota_mb": {"7168"},
	}
	before, after, target, err := svc.beforeImageFor(ctx, AuditPlanUpsert, form)
	if err != nil {
		t.Fatal(err)
	}
	if target != "plan:plus" {
		t.Fatalf("want target plan:plus, got %q", target)
	}
	if before["storage_bytes"] != int64(5<<30) {
		t.Fatalf("before image missing the prior storage: %v", before["storage_bytes"])
	}
	if after["storage_bytes"] != int64(1<<30) {
		t.Fatalf("after image should be 1 GiB in bytes, got %v", after["storage_bytes"])
	}
}

// 新建套餐（库里没有该 id）时 before 为空 map，不能是 nil —— diffFields 会
// 把所有字段记为 old=nil，这正是"新建"应有的语义。
func TestBeforeImagePlanNewIsEmptyNotNil(t *testing.T) {
	_, svc, _, _ := newAdminServer(t)
	form := url.Values{
		"id": {"brand-new"}, "name": {"New"}, "storage_mb": {"100"},
		"traffic_gb": {"1"}, "retention_days": {"1"}, "price_monthly": {"0"},
		"price_yearly": {"0"}, "sort_order": {"9"}, "daily_quota_mb": {"0"},
	}
	before, _, _, err := svc.beforeImageFor(context.Background(), AuditPlanUpsert, form)
	if err != nil {
		t.Fatal(err)
	}
	if before == nil {
		t.Fatal("before must be an empty map, never nil")
	}
	if len(before) != 0 {
		t.Fatalf("a brand-new plan has no before image, got %+v", before)
	}
}
```

测试助手 `settingsFormFrom`（放本测试文件顶部）——按 `handleAdminSettings` 实际读取的表单字段名构造，执行前用
`grep -n 'r.FormValue' internal/account/admin.go | sed -n '/handleAdminSettings/,+30p'` 核对字段名：

```go
// settingsFormFrom 把当前设置渲染回表单字段（MB/GB/小时），模拟管理员打开
// 设置页时浏览器里已填好的那些值。
func settingsFormFrom(s Settings) url.Values {
	return url.Values{
		"max_file_mb":          {itoa64(s.MaxFileSize >> 20)},
		"daily_quota_mb":       {itoa64(s.DailyQuota >> 20)},
		"default_ttl_hours":    {itoa64(s.DefaultTTL / 3600)},
		"max_ttl_hours":        {itoa64(s.MaxTTL / 3600)},
		"default_retention":    {itoa64(s.DefaultRetention)},
		"default_max_dl":       {itoa64(s.DefaultMaxDownloads)},
		"max_max_dl":           {itoa64(s.MaxMaxDownloads)},
		"storage_disk_cap_mb":  {itoa64(s.StorageDiskCap >> 20)},
		"node_traffic_gb":      {itoa64(s.NodeTrafficDefault >> 30)},
	}
}

func itoa64(v int64) string { return strconv.FormatInt(v, 10) }
```

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/account/ -run TestBeforeImage`
Expected: FAIL，`svc.beforeImageFor undefined`

- [ ] **Step 3: 实现**

创建 `server/internal/account/stepup_before.go`。**实现时必须复用 `handleAdminSettings` / `handleAdminUpsertPlan` 里已有的解析逻辑**，不要重写一份——两份解析迟早漂移，确认页显示的就不再是将要写入的值。做法是把两个 handler 里"表单 → 存储层数值"的那段抽成函数，handler 与 beforeImageFor 共同调用：

```go
package account

import (
	"context"
	"net/url"
)

// beforeImageFor 返回某个高危动作的前后镜像，供确认页展示 diff、供审计记录变更。
//
// 两个镜像都用**存储层原始值**（bytes / secs）。表单提交的是 MB/GB/天，
// 若在这里混用单位，确认页说"改成 1"而库里写的是 1073741824，对不上。
func (s *Service) beforeImageFor(ctx context.Context, action string, form url.Values) (before, after map[string]any, target string, err error) {
	switch action {
	case AuditSettings:
		cur, err := s.resolveSettings(ctx)
		if err != nil {
			return nil, nil, "", err
		}
		return settingsImage(cur), parseSettingsForm(form), "-", nil

	case AuditPlanUpsert:
		id := form.Get("id")
		before = map[string]any{}
		if p, ok, err := s.store.GetPlan(ctx, id); err != nil {
			return nil, nil, "", err
		} else if ok {
			before = planImage(p)
		}
		p, err := parsePlanForm(form)
		if err != nil {
			return nil, nil, "", err
		}
		return before, planImage(p), "plan:" + id, nil

	// 其余高危动作没有"字段级 diff"可言：用户改档只有一个目标值，节点删除
	// 没有新值，铸 token 是纯新增。它们各自在 handler 里构造 ChangeField。
	default:
		return map[string]any{}, map[string]any{}, "-", nil
	}
}

// settingsImage / planImage 把结构体摊平成字段名 -> 存储层值。
// 字段名直接用数据库列名/设置键名，这样审计日志里的 field 能直接对到库里。
func planImage(p Plan) map[string]any {
	return map[string]any{
		"name":                    p.Name,
		"storage_bytes":           p.StorageBytes,
		"traffic_bytes":           p.TrafficBytes,
		"retention_secs":          p.RetentionSecs,
		"price_monthly":           p.PriceMonthly,
		"price_yearly":            p.PriceYearly,
		"sort_order":              p.SortOrder,
		"active":                  p.Active,
		"daily_quota_bytes":       p.DailyQuotaBytes,
		"stripe_price_monthly_id": p.StripePriceMonthlyID,
		"stripe_price_yearly_id":  p.StripePriceYearlyID,
	}
}

func settingsImage(s Settings) map[string]any {
	return map[string]any{
		SettingMaxFileSize:            s.MaxFileSize,
		SettingDailyQuota:             s.DailyQuota,
		SettingDefaultTTL:             s.DefaultTTL,
		SettingMaxTTL:                 s.MaxTTL,
		SettingDefaultRetention:       s.DefaultRetention,
		SettingDefaultMaxDownloads:    s.DefaultMaxDownloads,
		SettingMaxMaxDownloads:        s.MaxMaxDownloads,
		SettingStorageDiskCap:         s.StorageDiskCap,
		SettingDisableCentralFallback: s.DisableCentralFallback,
		SettingNodeTrafficDefault:     s.NodeTrafficDefault,
	}
}
```

`parseSettingsForm(url.Values) map[string]any` 与 `parsePlanForm(url.Values) (Plan, error)`：从 `handleAdminSettings`（`admin.go:521-597`）和 `handleAdminUpsertPlan`（`admin.go:599-678`）中原样抽出解析与边界检查代码，两个 handler 改为调用它们。**抽取后 handler 的行为必须完全不变**，靠现有的 admin 测试保证。

- [ ] **Step 4: 运行确认通过**

Run: `go test ./internal/account/ -run TestBeforeImage -v`
Expected: 3 个 PASS

- [ ] **Step 5: 回归确认抽取没改变 handler 行为**

Run: `go test ./internal/account/ -run 'TestAdmin'`
Expected: 全部 PASS（既有的设置/套餐 handler 测试）

- [ ] **Step 6: 提交**

```bash
gofmt -l internal/ && go build ./... && go test ./...
git add server/internal/account/
git commit -m "feat(admin): extract form parsing so diffs use the values actually written"
```

---

### Task 7: requireStepUp 中间件 + 确认页

**Files:**
- Create: `server/internal/account/stepup.go`
- Modify: `server/internal/account/admin_templates.go`（新增确认页模板）
- Modify: `server/internal/account/admin.go`（`RegisterAdmin` 路由表 + 新增 `POST /admin/confirm`）
- Test: `server/internal/account/stepup_test.go`

**Interfaces:**
- Consumes: Task 5 `putPending`/`takePending`；Task 6 `beforeImageFor`；Task 4 `stepUpFresh`/`markStepUp`；Task 3 `writeAudit`
- Produces: `(*Service).requireStepUp(action string, next http.HandlerFunc) http.HandlerFunc`；`(*Service).handleAdminConfirm(w, r)`

- [ ] **Step 1: 写失败的测试**

```go
package account

import (
	"net/http"
	"strings"
	"testing"
)

// 高危 POST 不能直接生效：必须先回一个确认页。
func TestHighRiskWriteRendersConfirmInsteadOfApplying(t *testing.T) {
	ts, svc, store, _ := newAdminServer(t)
	cookie := adminLoginCookie(t, ts)
	ctx := t.Context()
	if err := svc.SeedSettings(ctx); err != nil {
		t.Fatal(err)
	}
	before, _ := svc.resolveSettings(ctx)

	form := settingsFormFrom(before)
	form.Set("daily_quota_mb", "999")
	resp := postAdminForm(t, ts, cookie, "/admin/settings", form)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("want 200 confirm page, got %d", resp.StatusCode)
	}
	body := readAll(t, resp)
	if !strings.Contains(body, "confirm_token") {
		t.Fatal("the confirm page must carry a pending-action token")
	}

	after, _ := svc.resolveSettings(ctx)
	if after.DailyQuota != before.DailyQuota {
		t.Fatal("SECURITY: the setting was applied without confirmation")
	}
	_ = store
}

// 确认页必须展示 diff —— 这才是防误点击的机制本身。
func TestConfirmPageShowsTheDiff(t *testing.T) {
	ts, svc, _, _ := newAdminServer(t)
	cookie := adminLoginCookie(t, ts)
	_ = svc.SeedSettings(t.Context())
	cur, _ := svc.resolveSettings(t.Context())
	form := settingsFormFrom(cur)
	form.Set("daily_quota_mb", "999")
	resp := postAdminForm(t, ts, cookie, "/admin/settings", form)
	defer resp.Body.Close()
	body := readAll(t, resp)
	if !strings.Contains(body, SettingDailyQuota) {
		t.Fatalf("confirm page must name the changed field; body=%s", body)
	}
}

// 低危操作不走确认页，直接生效。
func TestLowRiskWriteAppliesDirectly(t *testing.T) {
	ts, _, store, _ := newAdminServer(t)
	cookie := adminLoginCookie(t, ts)
	id := seedNode(t, store, "n1", "old-label")
	form := url.Values{"label": {"new-label"}}
	resp := postAdminForm(t, ts, cookie, "/admin/nodes/"+id+"/label", form)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("want a redirect (applied), got %d", resp.StatusCode)
	}
	n, _, _ := store.GetNode(t.Context(), id)
	if n.Label != "new-label" {
		t.Fatalf("low-risk write should apply without confirmation, label=%q", n.Label)
	}
}

// 宽限期内仍然要看到确认页 —— 免的只是掉码，不是免确认。
func TestGracePeriodStillShowsConfirmPage(t *testing.T) {
	ts, svc, _, _ := newAdminServer(t)
	cookie := adminLoginCookie(t, ts)
	svc.markStepUp(cookie.Value)
	_ = svc.SeedSettings(t.Context())
	cur, _ := svc.resolveSettings(t.Context())
	form := settingsFormFrom(cur)
	form.Set("daily_quota_mb", "888")
	resp := postAdminForm(t, ts, cookie, "/admin/settings", form)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the grace window must NOT skip the confirm page, got %d", resp.StatusCode)
	}
}
```

助手（放测试文件顶部）：`adminLoginCookie` 登录并返回 admin cookie；`postAdminForm` 带 cookie 与 `Origin: http://example.test` 发表单 POST（**必须带 Origin，否则被 csrfGuard 视作表单提交放行但语义不清**）；`readAll` 读 body；`seedNode` 插一行节点。按现有测试风格实现。

- [ ] **Step 2: 运行确认失败**

Run: `go test ./internal/account/ -run 'TestHighRiskWrite|TestConfirmPage|TestLowRiskWrite|TestGracePeriod'`
Expected: FAIL

- [ ] **Step 3: 实现中间件**

创建 `server/internal/account/stepup.go`：

```go
package account

import (
	"net/http"
)

// requireStepUp 把一个高危写操作改造成"先确认再执行"。
//
// 它拦下原始 POST，把表单存进会话绑定的 pendingActions，然后渲染一个列出
// 前后差异的确认页。真正的执行发生在 handleAdminConfirm 里。
//
// 设计要点：**确认页永远展示**，即使会话在步进宽限期内。宽限期免掉的只是
// 重新输一次第二因子，不是免掉"看一眼要改什么"—— 而后者才是防误点击的机制。
func (s *Service) requireStepUp(action string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.isAdminReq(r) {
			http.Redirect(w, r, "/admin", http.StatusFound)
			return
		}
		// 已确认过的请求由 handleAdminConfirm 转发进来，直接放行执行。
		if r.Context().Value(stepUpDoneKey) != nil {
			next(w, r)
			return
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		c, _ := r.Cookie(adminCookie)
		tok, ok := s.putPending(c.Value, action, r.PostForm)
		if !ok {
			http.Error(w, "too many pending confirmations", http.StatusTooManyRequests)
			return
		}
		before, after, target, err := s.beforeImageFor(r.Context(), action, r.PostForm)
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
		s.renderConfirmPage(w, r, confirmPageData{
			Token:   tok,
			Action:  action,
			Target:  target,
			Changes: diffFields(before, after),
			// 宽限期内不再要第二因子，但页面仍然要出现。
			NeedFactor: !s.stepUpFresh(c.Value),
			Factor:     s.availableStepUpFactor(),
		})
	}
}

// availableStepUpFactor 按可用性挑选第二因子：
// passkey（无 30 秒限制，体验最好）> TOTP > 重输密码。
//
// 最后一档的安全增益接近于零（同一个密码刚用来建的会话），但作为防误点击的
// 摩擦仍然有效，而且不会把只配了密码的自建者锁在功能之外。确认页会提示去配 2FA。
func (s *Service) availableStepUpFactor() string {
	if n, err := s.adminPasskeyCount(context.Background()); err == nil && n > 0 {
		return StepUpPasskey
	}
	if s.AdminTOTPEnabled() {
		return StepUpTOTP
	}
	return StepUpPassword
}
```

`handleAdminConfirm` 校验因子 → `takePending` → 把表单塞回 `r.PostForm` → 打上 `stepUpDoneKey` → 调用对应 handler → `markStepUp` → `writeAudit`。动作名到 handler 的映射用一张显式 map，**不要用反射**。

- [ ] **Step 4: 改路由表**

`RegisterAdmin` 中 6 个高危路由包上中间件：

```go
	mux.Handle("POST /admin/settings",
		s.csrfGuard(s.requireStepUp(AuditSettings, s.handleAdminSettings)))
	mux.Handle("POST /admin/plans",
		s.csrfGuard(s.requireStepUp(AuditPlanUpsert, s.handleAdminUpsertPlan)))
	mux.Handle("POST /admin/users/plan",
		s.csrfGuard(s.requireStepUp(AuditUserPlan, s.handleAdminSetUserPlan)))
	mux.Handle("POST /admin/nodes/token",
		s.csrfGuard(s.requireStepUp(AuditTokenMint, s.handleAdminMintToken)))
	mux.Handle("POST /admin/nodes/{id}/delete",
		s.csrfGuard(s.requireStepUp(AuditNodeDelete, s.handleAdminDeleteNode)))
	mux.Handle("POST /admin/passkey/delete",
		s.csrfGuard(s.requireStepUp(AuditPasskeyDelete, s.handleAdminPasskeyDelete)))
	mux.Handle("POST /admin/confirm", s.csrfGuard(http.HandlerFunc(s.handleAdminConfirm)))
```

- [ ] **Step 5: 推翻 passkey 删除的免步进注释**

`passkey_register.go:136-138` 现有注释论证"删除 passkey 不需要步进"。改写为：

```go
// handleAdminPasskeyDelete removes one registered credential.
//
// This used to be deliberately exempt from step-up, on the grounds that
// deleting your own credential can only lock you out and never harms anyone
// else. That reasoning was overridden: credential removal is now treated as a
// high-risk action like the rest, because a stolen session that can silently
// strip the operator's passkeys turns a recoverable compromise into a lockout.
// The gating lives in RegisterAdmin (requireStepUp), not here.
```

- [ ] **Step 6: 运行测试**

Run: `go test ./internal/account/ -run 'TestHighRisk|TestConfirm|TestLowRisk|TestGrace' -v`
Expected: 全部 PASS

- [ ] **Step 7: 提交**

```bash
gofmt -l internal/ && go build ./... && go test ./...
git add server/internal/account/
git commit -m "feat(admin): gate high-risk writes behind a diff confirmation page"
```

---

### Task 8: 因子校验（TOTP / 密码 / passkey）+ 高危操作审计

**Files:**
- Modify: `server/internal/account/stepup.go`
- Modify: `server/internal/account/passkey_login.go`（新增 `ceremonyStepUp`）
- Test: `server/internal/account/stepup_factor_test.go`

**Interfaces:**
- Consumes: Task 7 `handleAdminConfirm`；`matchAdminTOTPStep`/`commitAdminTOTPStep`（`totp.go`）；`verifyAdminCreds`（`admin.go:304`）
- Produces: `ceremonyStepUp ceremonyKind = "stepup"`

- [ ] **Step 1: 写失败的测试**

```go
// 错误的 TOTP 必须拒绝，且操作不得生效。
func TestConfirmRejectsWrongTOTP(t *testing.T) { /* ... 见下 */ }

// TOTP 重放：同一个码在步进里用第二次必须失败（现有单调计数器语义不能被破坏）。
func TestStepUpTOTPCannotBeReplayed(t *testing.T) { /* ... */ }

// 宽限期内不需要因子即可确认。
func TestConfirmWithinGraceNeedsNoFactor(t *testing.T) { /* ... */ }

// 宽限期内确认的记录，step_up 必须记成 "grace" 而不是伪装成验过。
func TestGraceConfirmIsAuditedAsGrace(t *testing.T) { /* ... */ }

// kind 混用：login 的 ceremony 不能用于 step-up finish。
func TestLoginCeremonyCannotSatisfyStepUp(t *testing.T) { /* ... */ }

// 红线（正向断言）：铸造 fleet token 后审计表里不得出现明文。
func TestMintedTokenPlaintextNeverEntersAudit(t *testing.T) {
	// 走完整的确认流程铸一个 token，从响应 body 里抓出明文，
	// 然后遍历 admin_audit 的所有列断言不含它。
}
```

每个测试都要写出完整代码（此处因篇幅列出意图与断言要点，实现时必须展开为可运行代码，不得留占位）。

- [ ] **Step 2: 运行确认失败** → **Step 3: 实现因子校验** → **Step 4: 加 ceremonyStepUp** → **Step 5: 高危 handler 写审计** → **Step 6: 测试** → **Step 7: 提交**

审计写入点在 `handleAdminConfirm` 中，业务 handler 返回之后：

```go
	s.markStepUp(c.Value)
	s.writeAudit(r, p.action, target, changes, factorUsed)
```

`factorUsed` 在宽限期路径下必须是 `StepUpGrace`，不能是实际因子名。

---

### Task 9: 审计查看页

**Files:**
- Modify: `server/internal/account/admin.go`（新增 `GET /admin/audit`）
- Modify: `server/internal/account/admin_templates.go`（列表模板）
- Test: `server/internal/account/audit_page_test.go`

- [ ] **Step 1–7:** 按前述 TDD 节奏。要点：
  - 倒序列表，每页 100 条，`?page=` 分页，`?action=` 过滤
  - 字节/秒在展示层转成可读单位（复用 `formatBytes` 之类的既有助手；没有就新增并单测）
  - `changes` 为空数组时显示"—"，不显示 `[]`
  - 测试断言：未登录访问 `/admin/audit` 必须重定向到 `/admin`，不得泄露任何记录

---

## Self-Review 记录

- **Spec 覆盖**：6 个高危端点（Task 7 路由表）、3 个低危端点（Task 3 Step 6）、登录事件（Task 3 Step 5）、审计表与永久保留（Task 1）、diff 存储层原始值（Task 2 + Task 6）、会话绑定（Task 5）、60 秒宽限（Task 4 + Task 7）、降级链（Task 7 `availableStepUpFactor`）、推翻既有注释（Task 7 Step 5）、三条红线（Global Constraints + Task 8 正向断言）、查看页（Task 9）——全部有对应任务。
- **类型一致性**：`AuditEntry.StepUp` 与常量 `StepUpNone/Passkey/TOTP/Password/Grace` 一致；`ChangeField` 在 Task 2 定义、Task 3/6/7 使用；`newAdminSession(auth string)` 在 Task 4 改签名，两个调用点同任务内更新。
- **已知耦合**：Task 3 Step 4 依赖 Task 4 的会话结构体，计划中已标注需合并执行。
- **Task 8 的测试是意图描述而非完整代码**，执行时必须先展开为可运行测试再进入实现——这是本计划唯一的展开点，不要跳过。
