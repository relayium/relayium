# 管理员后台看板 + 列表可用性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `/admin` 首页加一排快照指标卡,并把用户列表升级为分页/搜索/排序,全程服务端渲染。

**Architecture:** 在 `Store` 上新增 `AdminMetrics` 聚合方法;把 `AdminListUsers` 从「拉全表」改为 `(query)→(rows,total)`(WHERE 搜索 + 白名单 ORDER BY + LIMIT/OFFSET);把内联模板从 admin.go 拆到 `admin_templates.go`;`handleAdminHome` 解析 `q/sort/dir/page` 并渲染卡片、可排序表头、分页器。只读,无写操作。

**Tech Stack:** Go 1.26,`net/http`,`html/template`,`modernc.org/sqlite`(占位符用 `?` 位置参数)。测试 `go test`。

## Global Constraints

- 只读:不加任何用户/文件写操作;保留现有暂存设置表单。
- 服务端渲染 Go 模板;不引入前端框架/图表库/新重依赖。
- 指标固定 5 项:总用户数、未过期暂存文件数+占用存储、中继流量近 24h、中继流量近 7d、上传量近 24h。
- 时间窗口用滚动秒:24h=86400、7d=604800;边界为 `>=`(如 `recorded_at >= now-86400`)。`now` 由调用方注入(`s.now().Unix()` / 测试固定值)。
- 未过期暂存文件口径:`expires_at > now`(近似当前磁盘占用,注明)。
- 排序列走**白名单**映射(`created`→`u.created_at`,`email`→`u.email`,`relayed`→聚合列 `relayed_bytes`),**绝不把用户输入拼进 SQL**;非法值回退默认 `created`/`desc`。
- 搜索 `LIKE` 必须转义 `%`/`_`/`\`,用 `ESCAPE '\'`。
- 稳定排序:主排序键后固定次级键 `u.id ASC`。
- 分页每页 50(常量 `adminUsersPerPage = 50`);`page` 钳制到 `[1, maxPage]`(`maxPage = max(1, ceil(total/50))`)。
- 字节展示复用现有 `humanBytes`;时间复用现有 `ts` 模板函数(UTC)。
- 遵循 `internal/account` 现有代码风格与表驱动测试;`SQLiteStore` 是 `Store` 唯一实现。

---

### Task 1: Store 层 `AdminMetrics` 聚合 + 索引

**Files:**
- Modify: `server/internal/account/store.go`(加 `AdminMetrics` 类型 + 接口方法)
- Modify: `server/internal/account/sqlite.go`(实现 + 两个索引)
- Test: `server/internal/account/sqlite_test.go`

**Interfaces:**
- Produces:
  - `type AdminMetrics struct { TotalUsers, ActiveStoredFiles, ActiveStoredBytes, RelayedBytes24h, RelayedBytes7d, UploadedBytes24h int64 }`
  - `AdminMetrics(ctx context.Context, now int64) (AdminMetrics, error)`（Store 接口方法 + SQLiteStore 实现）

- [ ] **Step 1: 加类型与接口方法**

在 `store.go` 的 `AdminUserRow` 定义附近加:
```go
// AdminMetrics 是后台首页的快照指标。字节为累计值,时间窗口以传入的 now(unix 秒)为基准。
type AdminMetrics struct {
	TotalUsers        int64
	ActiveStoredFiles int64 // 未过期暂存文件数(expires_at > now)
	ActiveStoredBytes int64 // 上述文件 size 之和(近似当前磁盘占用)
	RelayedBytes24h   int64
	RelayedBytes7d    int64
	UploadedBytes24h  int64
}
```
在 `Store` 接口里,`AdminListUsers` 那一行附近加:
```go
	AdminMetrics(ctx context.Context, now int64) (AdminMetrics, error)
```

- [ ] **Step 2: 写失败测试(追加到 `sqlite_test.go`)**

```go
func TestAdminMetrics(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := int64(1_700_000_000)

	u, err := s.UpsertUserByEmail(ctx, "a@example.com", "A")
	if err != nil {
		t.Fatal(err)
	}

	// stored_files: one active (expires in future), one expired.
	mustCreateStored(t, s, u.ID, "sf-active", 1000, now+3600)
	mustCreateStored(t, s, u.ID, "sf-expired", 9999, now-1)

	// usage_events: in-24h, in-7d-not-24h, older-than-7d.
	mustUsage(t, s, u.ID, "ue-24h", 100, now-10)
	mustUsage(t, s, u.ID, "ue-7d", 200, now-2*86400)
	mustUsage(t, s, u.ID, "ue-old", 400, now-8*86400)

	// upload_events: in-24h (incl. exact boundary) + older.
	mustUpload(t, s, u.ID, "up-24h", 50, now-86400) // boundary: >= now-86400 → included
	mustUpload(t, s, u.ID, "up-old", 70, now-86401) // excluded

	m, err := s.AdminMetrics(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	want := AdminMetrics{
		TotalUsers:        1,
		ActiveStoredFiles: 1,
		ActiveStoredBytes: 1000,
		RelayedBytes24h:   100,
		RelayedBytes7d:    300, // 100 + 200
		UploadedBytes24h:  50,
	}
	if m != want {
		t.Fatalf("metrics mismatch:\n got %+v\nwant %+v", m, want)
	}
}

// helpers
func mustCreateStored(t *testing.T, s *SQLiteStore, uid, id string, size, expires int64) {
	t.Helper()
	if err := s.CreateStoredFile(context.Background(), StoredFile{
		ID: id, UserID: uid, BlobKey: id, EncManifest: []byte("m"),
		Size: size, CreatedAt: expires - 100, ExpiresAt: expires,
	}); err != nil {
		t.Fatal(err)
	}
}
func mustUsage(t *testing.T, s *SQLiteStore, uid, alloc string, bytes, at int64) {
	t.Helper()
	if err := s.RecordUsage(context.Background(), UsageEvent{
		AllocID: alloc, Token: alloc, UserID: uid, RelayedBytes: bytes, RecordedAt: at,
	}); err != nil {
		t.Fatal(err)
	}
}
func mustUpload(t *testing.T, s *SQLiteStore, uid, id string, bytes, at int64) {
	t.Helper()
	if err := s.RecordUpload(context.Background(), UploadEvent{
		ID: id, UserID: uid, Bytes: bytes, UploadedAt: at,
	}); err != nil {
		t.Fatal(err)
	}
}
```
> 注:若 `sqlite_test.go` 尚未 import `context`,加上。若某个 helper 名称与文件中已有的冲突,改用带 `metrics` 前缀的名字。

- [ ] **Step 3: 运行测试,确认失败**

Run: `go test ./internal/account/ -run TestAdminMetrics -v`
Expected: 编译失败,`s.AdminMetrics` undefined。

- [ ] **Step 4: 实现 `AdminMetrics`(sqlite.go)**

在 `sqlite.go` 里(靠近 `AdminListUsers`)加:
```go
func (s *SQLiteStore) AdminMetrics(ctx context.Context, now int64) (AdminMetrics, error) {
	var m AdminMetrics
	err := s.db.QueryRowContext(ctx, `
		SELECT
		  (SELECT COUNT(*) FROM users),
		  (SELECT COUNT(*) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(size),0) FROM stored_files WHERE expires_at > ?),
		  (SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE recorded_at >= ?),
		  (SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE recorded_at >= ?),
		  (SELECT COALESCE(SUM(bytes),0) FROM upload_events WHERE uploaded_at >= ?)`,
		now, now, now-86400, now-604800, now-86400,
	).Scan(&m.TotalUsers, &m.ActiveStoredFiles, &m.ActiveStoredBytes,
		&m.RelayedBytes24h, &m.RelayedBytes7d, &m.UploadedBytes24h)
	if err != nil {
		return AdminMetrics{}, err
	}
	return m, nil
}
```
(位置参数 `?` 按出现顺序绑定:expires>now、expires>now、relayed≥now-24h、relayed≥now-7d、upload≥now-24h。)

- [ ] **Step 5: 加两个索引到 schema**

在 `sqlite.go` 的 schema 常量里,`idx_upload_events_user` 那行之后追加:
```sql
CREATE INDEX IF NOT EXISTS idx_usage_recorded ON usage_events(recorded_at);
CREATE INDEX IF NOT EXISTS idx_upload_uploaded ON upload_events(uploaded_at);
```

- [ ] **Step 6: 运行测试,确认通过**

Run: `go test ./internal/account/ -run TestAdminMetrics -v && go build ./...`
Expected: PASS,整包编译通过(此时 `AdminMetrics` 尚无调用方,属正常)。

- [ ] **Step 7: 提交**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go
git commit -m "feat(admin): Store.AdminMetrics snapshot aggregates + window indexes"
```

---

### Task 2: `AdminListUsers` 改为分页/搜索/排序

**Files:**
- Modify: `server/internal/account/store.go`(加 `AdminUserQuery`;改接口签名)
- Modify: `server/internal/account/sqlite.go`(重写 `AdminListUsers` + `escapeLike`)
- Modify: `server/internal/account/admin.go`(`handleAdminHome` 最小改动以保持编译)
- Test: `server/internal/account/sqlite_test.go`

**Interfaces:**
- Consumes: 无(Store 层独立)
- Produces:
  - `type AdminUserQuery struct { Search, SortBy, SortDir string; Limit, Offset int }`
  - `AdminListUsers(ctx context.Context, q AdminUserQuery) (rows []AdminUserRow, total int64, err error)`
  - `func escapeLike(s string) string`

- [ ] **Step 1: 加 `AdminUserQuery` 类型 + 改接口签名(store.go)**

```go
// AdminUserQuery 参数化后台用户列表查询。
type AdminUserQuery struct {
	Search  string // 空 = 不过滤;非空按 email/display_name 模糊匹配
	SortBy  string // "created" | "email" | "relayed";非法值回退 "created"
	SortDir string // "asc" | "desc";非法值回退 "desc"
	Limit   int
	Offset  int
}
```
把接口里的
```go
	AdminListUsers(ctx context.Context) ([]AdminUserRow, error)
```
改为
```go
	AdminListUsers(ctx context.Context, q AdminUserQuery) (rows []AdminUserRow, total int64, err error)
```

- [ ] **Step 2: 写失败测试(追加到 `sqlite_test.go`)**

```go
func TestAdminListUsersQuery(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// three users with distinct created_at, names, and relay totals.
	mkUser := func(email, name string, created int64) string {
		u, err := s.UpsertUserByEmail(ctx, email, name)
		if err != nil {
			t.Fatal(err)
		}
		// force created_at deterministically
		if _, err := s.db.ExecContext(ctx, `UPDATE users SET created_at=? WHERE id=?`, created, u.ID); err != nil {
			t.Fatal(err)
		}
		return u.ID
	}
	uA := mkUser("alice@example.com", "Alice", 100)
	mkUser("bob@example.com", "Bob 50%", 200) // literal % to test escaping
	mkUser("carol@example.com", "Carol", 300)
	mustUsage(t, s, uA, "u1", 999, 1_700_000_000) // Alice has the biggest relay total

	all := func(q AdminUserQuery) ([]AdminUserRow, int64) {
		rows, total, err := s.AdminListUsers(ctx, q)
		if err != nil {
			t.Fatal(err)
		}
		return rows, total
	}

	// default sort = created desc → Carol, Bob, Alice
	rows, total := all(AdminUserQuery{Limit: 10})
	if total != 3 || len(rows) != 3 || rows[0].Email != "carol@example.com" || rows[2].Email != "alice@example.com" {
		t.Fatalf("default sort/total wrong: total=%d rows=%v", total, emails(rows))
	}

	// search by name substring
	rows, total = all(AdminUserQuery{Search: "carol", Limit: 10})
	if total != 1 || len(rows) != 1 || rows[0].Email != "carol@example.com" {
		t.Fatalf("search miss: total=%d rows=%v", total, emails(rows))
	}

	// literal % must match only Bob, not act as wildcard
	rows, _ = all(AdminUserQuery{Search: "50%", Limit: 10})
	if len(rows) != 1 || rows[0].Email != "bob@example.com" {
		t.Fatalf("LIKE escape failed: rows=%v", emails(rows))
	}

	// sort by email asc
	rows, _ = all(AdminUserQuery{SortBy: "email", SortDir: "asc", Limit: 10})
	if rows[0].Email != "alice@example.com" || rows[2].Email != "carol@example.com" {
		t.Fatalf("email asc wrong: %v", emails(rows))
	}

	// sort by relayed desc → Alice first
	rows, _ = all(AdminUserQuery{SortBy: "relayed", SortDir: "desc", Limit: 10})
	if rows[0].Email != "alice@example.com" {
		t.Fatalf("relayed desc wrong: %v", emails(rows))
	}

	// pagination: limit 2 offset 2 → one row
	rows, total = all(AdminUserQuery{Limit: 2, Offset: 2})
	if total != 3 || len(rows) != 1 {
		t.Fatalf("paging wrong: total=%d len=%d", total, len(rows))
	}

	// invalid sort/dir fall back to created desc
	rows, _ = all(AdminUserQuery{SortBy: "; DROP", SortDir: "sideways", Limit: 10})
	if rows[0].Email != "carol@example.com" {
		t.Fatalf("fallback wrong: %v", emails(rows))
	}
}

func emails(rows []AdminUserRow) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.Email
	}
	return out
}
```

- [ ] **Step 3: 运行测试,确认失败**

Run: `go test ./internal/account/ -run TestAdminListUsersQuery -v`
Expected: 编译失败(旧签名 / undefined),或断言失败。

- [ ] **Step 4: 重写 `AdminListUsers` + 加 `escapeLike`(sqlite.go)**

把现有 `AdminListUsers` 整个替换为:
```go
// escapeLike 转义 LIKE 通配符,使搜索文本按字面匹配(配合 ESCAPE '\')。
func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

func (s *SQLiteStore) AdminListUsers(ctx context.Context, q AdminUserQuery) ([]AdminUserRow, int64, error) {
	where := ""
	var whereArgs []any
	if q.Search != "" {
		where = ` WHERE (u.email LIKE ? ESCAPE '\' OR u.display_name LIKE ? ESCAPE '\')`
		like := "%" + escapeLike(q.Search) + "%"
		whereArgs = append(whereArgs, like, like)
	}

	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users u`+where, whereArgs...).Scan(&total); err != nil {
		return nil, 0, err
	}

	orderCol := "u.created_at"
	switch q.SortBy {
	case "email":
		orderCol = "u.email"
	case "relayed":
		orderCol = "relayed_bytes"
	}
	dir := "DESC"
	if strings.EqualFold(q.SortDir, "asc") {
		dir = "ASC"
	}

	listArgs := append(append([]any{}, whereArgs...), q.Limit, q.Offset)
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.email, u.display_name, u.created_at,
		       (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id),
		       (SELECT COALESCE(SUM(relayed_bytes), 0) FROM usage_events e WHERE e.user_id = u.id) AS relayed_bytes
		FROM users u`+where+`
		ORDER BY `+orderCol+` `+dir+`, u.id ASC
		LIMIT ? OFFSET ?`, listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var out []AdminUserRow
	index := map[string]int{}
	for rows.Next() {
		var row AdminUserRow
		if err := rows.Scan(&row.ID, &row.Email, &row.DisplayName, &row.CreatedAt,
			&row.DeviceCount, &row.RelayedBytes); err != nil {
			return nil, 0, err
		}
		index[row.ID] = len(out)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	// 单独一遍把 provider 摊到本页用户,避免 N+1(非本页 user_id 不在 index 中,跳过)。
	irows, err := s.db.QueryContext(ctx, `SELECT user_id, provider FROM identities`)
	if err != nil {
		return nil, 0, err
	}
	defer irows.Close()
	seen := map[string]map[string]bool{}
	for irows.Next() {
		var uid, provider string
		if err := irows.Scan(&uid, &provider); err != nil {
			return nil, 0, err
		}
		i, ok := index[uid]
		if !ok {
			continue
		}
		if seen[uid] == nil {
			seen[uid] = map[string]bool{}
		}
		if !seen[uid][provider] {
			seen[uid][provider] = true
			out[i].Methods = append(out[i].Methods, provider)
		}
	}
	if err := irows.Err(); err != nil {
		return nil, 0, err
	}
	for i := range out {
		sort.Strings(out[i].Methods)
	}
	return out, total, nil
}
```
确保 `sqlite.go` 已 import `strings`(若未,加上)。

- [ ] **Step 5: 让 `handleAdminHome` 编译通过(admin.go,临时)**

把 `admin.go` 里
```go
	rows, err := s.store.AdminListUsers(r.Context())
```
临时改为(Task 4 会替换为真正的分页逻辑):
```go
	rows, _, err := s.store.AdminListUsers(r.Context(), AdminUserQuery{
		SortBy: "created", SortDir: "desc", Limit: 1000, Offset: 0,
	})
```

- [ ] **Step 6: 运行测试,确认通过**

Run: `go test ./internal/account/ -run 'TestAdminListUsersQuery|TestAdmin' -v && go build ./...`
Expected: 新测试 PASS;现有 admin 测试仍绿;整包编译通过。

- [ ] **Step 7: 提交**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go server/internal/account/admin.go
git commit -m "feat(admin): paginated/searchable/sortable AdminListUsers (rows,total)"
```

---

### Task 3: 把内联模板拆出 admin.go

**Files:**
- Create: `server/internal/account/admin_templates.go`
- Modify: `server/internal/account/admin.go`(移出模板与 `humanBytes`)

**Interfaces:**
- Consumes/Produces: 纯移动,包级标识符 `adminLoginTmpl`、`adminUsersTmpl`、`humanBytes`、`adminLoginData`、`adminHomeData`、`adminSettingsView` 名称不变。

- [ ] **Step 1: 建 `admin_templates.go`,迁入模板**

新建文件,`package account`,import `html/template`、`strconv`、`time`。把 admin.go 里这些**原样剪切**过来:`adminLoginData` 结构体、`adminLoginTmpl` 变量、`adminUsersTmpl` 变量(含其 FuncMap:`ts`、`bytes`)、`humanBytes` 函数。`adminHomeData` / `adminSettingsView` 也一并移到此文件(它们是模板数据类型)。

- [ ] **Step 2: 从 admin.go 删除已迁走的定义**

在 admin.go 删掉上述被剪切的定义。修正 admin.go 的 import:若 `html/template`、`strconv` 不再被 admin.go 使用则移除(`time` 仍被 session TTL 等使用,保留)。

- [ ] **Step 3: 编译 + 现有测试**

Run: `go build ./... && go test ./internal/account/ -v 2>&1 | tail -20`
Expected: 编译通过;所有现有测试(登录/2FA/settings/list)仍 PASS。纯移动,行为不变。

- [ ] **Step 4: 提交**

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go
git commit -m "refactor(admin): split inline templates into admin_templates.go"
```

---

### Task 4: 首页 handler + 模板接线(卡片 + 分页/搜索/排序 UI)

**Files:**
- Modify: `server/internal/account/admin.go`(`handleAdminHome` + 分页/链接辅助 + `adminHomeData` 扩展)
- Modify: `server/internal/account/admin_templates.go`(`adminUsersTmpl` 增加卡片/搜索/表头链接/分页器)
- Test: `server/internal/account/admin_test.go`

**Interfaces:**
- Consumes: `AdminMetrics(ctx, now)`(Task 1);`AdminListUsers(ctx, AdminUserQuery)→(rows,total)`(Task 2);现有 `s.newAdminSession()`、常量 `adminCookie`、`s.resolveSettings`、`humanBytes`、模板函数 `ts`。
- Produces: 常量 `adminUsersPerPage = 50`;扩展后的 `adminHomeData`。

- [ ] **Step 1: 扩展 `adminHomeData` 并加常量/辅助(admin.go 或 admin_templates.go 中 data 类型处)**

把 `adminHomeData` 改为:
```go
const adminUsersPerPage = 50

type adminHomeData struct {
	Metrics    AdminMetrics
	Users      []AdminUserRow
	Total      int64
	Page       int
	TotalPages int
	Search     string
	Sort       string
	Dir        string
	PrevHref   string            // 空 = 无上一页
	NextHref   string            // 空 = 无下一页
	SortHref   map[string]string // 列 key("created"/"email"/"relayed") → 点击后的排序链接
	Settings   adminSettingsView
}
```
在 admin.go 加链接辅助:
```go
// adminListHref 构造 /admin 的列表链接,只带非默认参数,值经 url 编码。
func adminListHref(search, sort, dir string, page int) string {
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
	if page > 1 {
		v.Set("page", strconv.Itoa(page))
	}
	if len(v) == 0 {
		return "/admin"
	}
	return "/admin?" + v.Encode()
}
```
admin.go 需 import `net/url`、`strconv`、`math`(下一步 ceil)。

- [ ] **Step 2: 写失败测试(admin_test.go)**

```go
func TestAdminHomeDashboardAndPaging(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		email := fmt.Sprintf("user%d@example.com", i)
		if _, err := store.UpsertUserByEmail(ctx, email, fmt.Sprintf("User %d", i)); err != nil {
			t.Fatal(err)
		}
	}
	s := NewService(store, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	s.now = func() time.Time { return time.Unix(1_700_000_000, 0) }

	get := func(query string) *httptest.ResponseRecorder {
		tok := s.newAdminSession()
		r := httptest.NewRequest("GET", "/admin"+query, nil)
		r.AddCookie(&http.Cookie{Name: adminCookie, Value: tok})
		w := httptest.NewRecorder()
		s.handleAdminHome(w, r)
		return w
	}

	// dashboard: metric card labels + a user present
	w := get("")
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{"总用户数", "中继流量", "user0@example.com"} {
		if !strings.Contains(body, want) {
			t.Fatalf("home body missing %q", want)
		}
	}

	// search filters to one user
	w = get("?q=user1")
	body = w.Body.String()
	if !strings.Contains(body, "user1@example.com") || strings.Contains(body, "user0@example.com") {
		t.Fatal("search did not filter to user1 only")
	}

	// page clamp: absurd page still 200, no crash
	if w := get("?page=999"); w.Code != http.StatusOK {
		t.Fatalf("out-of-range page: want 200, got %d", w.Code)
	}
}
```
确保 `admin_test.go` import:`context`、`fmt`、`net/http`、`net/http/httptest`、`strings`、`time`。

- [ ] **Step 3: 运行测试,确认失败**

Run: `go test ./internal/account/ -run TestAdminHomeDashboardAndPaging -v`
Expected: FAIL(当前 handler 不渲染卡片/不处理 q/page)。

- [ ] **Step 4: 重写 `handleAdminHome`(admin.go)**

```go
func (s *Service) handleAdminHome(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		s.renderAdminLogin(w, http.StatusOK, "")
		return
	}
	q := r.URL.Query()
	search := strings.TrimSpace(q.Get("q"))
	sortBy := q.Get("sort")
	if sortBy != "email" && sortBy != "relayed" {
		sortBy = "created"
	}
	dir := "desc"
	if strings.EqualFold(q.Get("dir"), "asc") {
		dir = "asc"
	}
	page, _ := strconv.Atoi(q.Get("page"))
	if page < 1 {
		page = 1
	}

	now := s.now().Unix()
	metrics, err := s.store.AdminMetrics(r.Context(), now)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	rows, total, err := s.store.AdminListUsers(r.Context(), AdminUserQuery{
		Search: search, SortBy: sortBy, SortDir: dir,
		Limit: adminUsersPerPage, Offset: (page - 1) * adminUsersPerPage,
	})
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	totalPages := int(math.Ceil(float64(total) / float64(adminUsersPerPage)))
	if totalPages < 1 {
		totalPages = 1
	}
	if page > totalPages { // 钳制到末页并重取该页
		page = totalPages
		rows, total, err = s.store.AdminListUsers(r.Context(), AdminUserQuery{
			Search: search, SortBy: sortBy, SortDir: dir,
			Limit: adminUsersPerPage, Offset: (page - 1) * adminUsersPerPage,
		})
		if err != nil {
			http.Error(w, "server error", http.StatusInternalServerError)
			return
		}
	}

	// 点击某列的排序链接:非当前列→desc;当前列→切换方向。回到第 1 页。
	sortHref := map[string]string{}
	for _, col := range []string{"created", "email", "relayed"} {
		nd := "desc"
		if sortBy == col && dir == "desc" {
			nd = "asc"
		}
		sortHref[col] = adminListHref(search, col, nd, 1)
	}
	prev, next := "", ""
	if page > 1 {
		prev = adminListHref(search, sortBy, dir, page-1)
	}
	if page < totalPages {
		next = adminListHref(search, sortBy, dir, page+1)
	}

	st := s.resolveSettings(r.Context())
	data := adminHomeData{
		Metrics: metrics, Users: rows, Total: total, Page: page, TotalPages: totalPages,
		Search: search, Sort: sortBy, Dir: dir,
		PrevHref: prev, NextHref: next, SortHref: sortHref,
		Settings: adminSettingsView{
			MaxFileSizeMB: st.MaxFileSize / (1024 * 1024),
			DailyQuotaMB:  st.DailyQuota / (1024 * 1024),
			DefaultTTLHrs: st.DefaultTTL / 3600,
			MaxTTLHrs:     st.MaxTTL / 3600,
		},
	}
	if err := adminUsersTmpl.Execute(w, data); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}
```

- [ ] **Step 5: 更新 `adminUsersTmpl`(admin_templates.go)**

在 `<body>` 顶部(退出按钮那行之后、settings 之前)加指标卡区,并把用户表换成带搜索/排序/分页的版本。把 `adminUsersTmpl` 的 body 部分改为:
```html
<body>
<div class="top"><h1>后台概览</h1>
<form method="post" action="/admin/logout"><button type="submit">退出</button></form></div>

<section class="cards">
<div class="card"><div class="n">{{.Metrics.TotalUsers}}</div><div class="l">总用户数</div></div>
<div class="card"><div class="n">{{.Metrics.ActiveStoredFiles}}</div><div class="l">未过期暂存文件</div></div>
<div class="card"><div class="n">{{bytes .Metrics.ActiveStoredBytes}}</div><div class="l">占用存储(近似)</div></div>
<div class="card"><div class="n">{{bytes .Metrics.RelayedBytes24h}}</div><div class="l">中继流量 · 近 24h</div></div>
<div class="card"><div class="n">{{bytes .Metrics.RelayedBytes7d}}</div><div class="l">中继流量 · 近 7d</div></div>
<div class="card"><div class="n">{{bytes .Metrics.UploadedBytes24h}}</div><div class="l">上传量 · 近 24h</div></div>
</section>

<section class="settings">
<h2>暂存传输设置</h2>
<form method="post" action="/admin/settings" class="grid">
<label>单文件上限 (MiB)<input type="number" name="max_file_size_mb" min="1" value="{{.Settings.MaxFileSizeMB}}"></label>
<label>每账号每日额度 (MiB)<input type="number" name="daily_quota_mb" min="1" value="{{.Settings.DailyQuotaMB}}"></label>
<label>默认有效期 (小时)<input type="number" name="default_ttl_hours" min="1" value="{{.Settings.DefaultTTLHrs}}"></label>
<label>最长有效期 (小时)<input type="number" name="max_ttl_hours" min="1" value="{{.Settings.MaxTTLHrs}}"></label>
<button type="submit">保存设置</button>
</form>
</section>

<div class="top"><h2>注册用户（{{.Total}}）</h2>
<form method="get" action="/admin" class="search">
<input type="text" name="q" value="{{.Search}}" placeholder="搜索邮箱或显示名">
<input type="hidden" name="sort" value="{{.Sort}}"><input type="hidden" name="dir" value="{{.Dir}}">
<button type="submit">搜索</button>
</form></div>

<table><thead><tr>
<th><a href="{{index .SortHref "email"}}">邮箱</a></th>
<th>显示名</th>
<th><a href="{{index .SortHref "created"}}">注册时间(UTC)</a></th>
<th>登录方式</th><th>设备</th>
<th><a href="{{index .SortHref "relayed"}}">中继流量</a></th>
</tr></thead><tbody>
{{range .Users}}<tr>
<td>{{.Email}}</td><td>{{.DisplayName}}</td><td>{{ts .CreatedAt}}</td>
<td>{{range $i, $m := .Methods}}{{if $i}}, {{end}}{{$m}}{{end}}</td>
<td>{{.DeviceCount}}</td><td>{{bytes .RelayedBytes}}</td>
</tr>{{end}}
</tbody></table>

<div class="pager">
{{if .PrevHref}}<a href="{{.PrevHref}}">← 上一页</a>{{else}}<span class="off">← 上一页</span>{{end}}
<span>第 {{.Page}} / {{.TotalPages}} 页</span>
{{if .NextHref}}<a href="{{.NextHref}}">下一页 →</a>{{else}}<span class="off">下一页 →</span>{{end}}
</div>
</body></html>
```
并在该模板 `<style>` 里补几条(加到现有 style 末尾):
```css
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:14px 0 26px}
.card{border:1px solid #ddd;border-radius:8px;padding:12px 16px;min-width:140px}
.card .n{font-size:20px;font-weight:600}.card .l{color:#666;font-size:12px;margin-top:4px}
.search{display:flex;gap:6px}.search input[type=text]{font:inherit;padding:6px 8px}
.pager{display:flex;gap:16px;align-items:center;margin:16px 0}
.pager .off{color:#bbb}
th a{text-decoration:none;color:inherit}th a:hover{text-decoration:underline}
```

- [ ] **Step 6: 运行测试,确认通过**

Run: `go test ./internal/account/ -run TestAdminHomeDashboardAndPaging -v && go test ./... && go vet ./...`
Expected: 新测试 PASS;全套绿;vet 干净。

- [ ] **Step 7: 手动确认(可选但推荐)**

Run(在 `server/`):`RELAYIUM_ADMIN_PASS=pw go run . -addr :8099 -db :memory:`,浏览器登录 `/admin`,确认顶部出现指标卡、用户表可搜索/点表头排序/翻页。Ctrl-C 结束。

- [ ] **Step 8: 提交**

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/admin_test.go
git commit -m "feat(admin): dashboard metric cards + user-list search/sort/paging UI"
```

---

## 完成后的整体验证

- [ ] `cd server && go test ./... && go vet ./...` 全绿。
- [ ] 手动:`RELAYIUM_ADMIN_PASS=pw go run . -db :memory:`,`/admin` 顶部 5(+存储合并成 6 卡)指标卡显示;用户列表可按邮箱/注册时间/中继流量排序、可搜索、可翻页;URL 带 `?q=&sort=&dir=&page=` 可刷新/分享。
- [ ] 无写操作被引入;暂存设置表单仍工作。

## Self-Review 记录

- **Spec 覆盖**:看板 6 指标(T1 Store + T4 卡片)、窗口索引(T1)、列表分页/搜索/排序 + total(T2 Store + T4 handler/UI)、`LIKE` 转义 + 排序白名单 + page 钳制(T2/T4)、模板拆分(T3)、测试(T1/T2/T4)——逐条有任务。
- **占位符**:无 TBD;每个代码步给出完整 Go/SQL/HTML 与确切命令/预期。
- **类型一致性**:`AdminMetrics`、`AdminUserQuery`、`AdminListUsers(ctx,q)→(rows,total,err)`、`escapeLike`、`adminHomeData`(Metrics/Users/Total/Page/TotalPages/Search/Sort/Dir/PrevHref/NextHref/SortHref/Settings)、`adminUsersPerPage`、`adminListHref` 在定义与调用处一致。T2 临时 handler 改动在 T4 被完整替换。
