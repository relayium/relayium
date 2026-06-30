# 账号密码登录 + 管理后台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增邮箱+密码注册/登录，停用（但保留）Google 与邮箱 magic-link，并提供独立管理员密码访问的只读 `/admin` 后台。

**Architecture:** 沿用 `account` 包的 `Store`（SQLite）↔ `Service` ↔ HTTP handlers 三层。密码用 bcrypt 存 `users.password_hash`。Google/magic 路由由 `Config` 布尔开关在 `Routes()` 中条件注册。后台为 `html/template` 服务端渲染，独立 `relayium_admin` cookie + 内存登录态。前端 Svelte 据 `/api/auth/methods` 条件渲染。

**Tech Stack:** Go 1.26（标准库 + `golang.org/x/crypto/bcrypt`、`modernc.org/sqlite`）、Svelte 5 runes、Vitest。

## Global Constraints

- Go module path：`github.com/relayium/relayium`，包 `account` 位于 `server/internal/account/`。
- 所有 Store 实现方法必须同时出现在 `store.go` 的 `Store` interface 与 `sqlite.go` 的 `*SQLiteStore`，否则整包不编译。
- 邮箱一律经 `normEmail()` 规范化（`strings.ToLower(strings.TrimSpace())`）。
- 随机 token 一律用现有 `randToken()`（32 字节 hex）。
- Cookie 的 `Secure` 由 `s.cookieSecure()` 决定（base URL 为 https 时为 true）。
- 时间一律走 `s.now()`，便于测试注入。
- 测试运行：`cd server && go test ./internal/account/`；前端 `cd web && npx vitest run`。
- 不发任何邮件、不做邮箱验证、不做密码找回（YAGNI，见 spec 非目标）。

---

### Task 1: 密码列迁移 + 凭据读写（SQLite）

**Files:**
- Modify: `server/internal/account/sqlite.go`（`OpenSQLite` 加迁移；新增 `SetPassword`、`GetCredentials`）
- Modify: `server/internal/account/store.go`（`Store` interface 加两个方法）
- Test: `server/internal/account/sqlite_test.go`

**Interfaces:**
- Produces:
  - `SetPassword(ctx context.Context, userID, passwordHash string) error`
  - `GetCredentials(ctx context.Context, email string) (userID, passwordHash string, ok bool, err error)` — `ok=false` 表示该邮箱不存在或未设密码。

- [ ] **Step 1: 写失败测试**

在 `sqlite_test.go` 末尾追加：

```go
func TestSetAndGetCredentials(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	// 未知邮箱：ok=false，无错误。
	if _, _, ok, err := s.GetCredentials(ctx, "nobody@example.com"); err != nil || ok {
		t.Fatalf("unknown email: ok=%v err=%v", ok, err)
	}

	u, err := s.UpsertUserByEmail(ctx, "P@Example.com", "P")
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	// 用户存在但还没密码：ok=false。
	if _, _, ok, _ := s.GetCredentials(ctx, "p@example.com"); ok {
		t.Fatalf("user without password should have ok=false")
	}
	if err := s.SetPassword(ctx, u.ID, "hash-xyz"); err != nil {
		t.Fatalf("set password: %v", err)
	}
	uid, hash, ok, err := s.GetCredentials(ctx, "p@example.com")
	if err != nil || !ok {
		t.Fatalf("after set: ok=%v err=%v", ok, err)
	}
	if uid != u.ID || hash != "hash-xyz" {
		t.Fatalf("got uid=%q hash=%q want %q/hash-xyz", uid, hash, u.ID)
	}
}

func TestPasswordColumnMigrationIsIdempotent(t *testing.T) {
	// 在同一文件 DB 上连开两次，ALTER 重复加列不能报错。
	dir := t.TempDir()
	dsn := dir + "/mig.db"
	s1, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open1: %v", err)
	}
	s1.Close()
	s2, err := OpenSQLite(dsn)
	if err != nil {
		t.Fatalf("open2 (re-migrate) must succeed: %v", err)
	}
	s2.Close()
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./internal/account/ -run 'Credentials|Migration' -v`
Expected: 编译失败 —— `s.GetCredentials undefined` / `s.SetPassword undefined`。

- [ ] **Step 3: 加迁移与实现**

在 `sqlite.go` 的 `OpenSQLite` 中，`schema` 执行成功之后、`return` 之前插入迁移（`strings` 已在该文件导入）：

```go
	// password_hash 是初版之后新增的列。新库与老库都靠这一句补齐；
	// 列已存在时 SQLite 报 "duplicate column name"，幂等忽略。
	if _, err := db.ExecContext(context.Background(),
		`ALTER TABLE users ADD COLUMN password_hash TEXT`); err != nil &&
		!strings.Contains(err.Error(), "duplicate column name") {
		db.Close()
		return nil, err
	}
```

在 `sqlite.go` 末尾追加：

```go
func (s *SQLiteStore) SetPassword(ctx context.Context, userID, passwordHash string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE users SET password_hash = ? WHERE id = ?`, passwordHash, userID)
	return err
}

func (s *SQLiteStore) GetCredentials(ctx context.Context, email string) (string, string, bool, error) {
	email = normEmail(email)
	var uid string
	var hash sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT id, password_hash FROM users WHERE email = ?`, email,
	).Scan(&uid, &hash)
	if err == sql.ErrNoRows {
		return "", "", false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	if !hash.Valid || hash.String == "" {
		return uid, "", false, nil
	}
	return uid, hash.String, true, nil
}
```

在 `store.go` 的 `Store` interface 中，`// users + identities` 分组下追加：

```go
	SetPassword(ctx context.Context, userID, passwordHash string) error
	GetCredentials(ctx context.Context, email string) (userID, passwordHash string, ok bool, err error)
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && go test ./internal/account/ -run 'Credentials|Migration' -v`
Expected: PASS（两个测试均通过）。

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/sqlite.go server/internal/account/store.go server/internal/account/sqlite_test.go
git commit -m "feat(account): store password_hash with idempotent migration + credential accessors"
```

---

### Task 2: 注册/登录业务逻辑（bcrypt）

**Files:**
- Create: `server/internal/account/password.go`
- Modify: `server/go.mod` / `server/go.sum`（加 `golang.org/x/crypto`）
- Test: `server/internal/account/password_test.go`（新建）

**Interfaces:**
- Consumes（Task 1）：`store.SetPassword`、`store.GetCredentials`；既有 `store.UpsertUserByEmail`、`store.LinkIdentity`、`s.IssueSession`。
- Produces:
  - `Register(ctx context.Context, email, password, displayName string) (Session, error)`
  - `Login(ctx context.Context, email, password string) (Session, error)`
  - 哨兵错误：`ErrEmailTaken`、`ErrBadCredentials`、`ErrWeakPassword`
  - 常量：`minPasswordLen = 8`

- [ ] **Step 1: 加依赖**

Run: `cd server && go get golang.org/x/crypto/bcrypt`
Expected: `go.mod` 出现 `golang.org/x/crypto vX.Y.Z`，无网络错误（模块已在本地 cache）。

- [ ] **Step 2: 写失败测试**

新建 `server/internal/account/password_test.go`：

```go
package account

import (
	"context"
	"errors"
	"testing"
	"time"
)

func newPwService(t *testing.T) *Service {
	t.Helper()
	return NewService(newTestStore(t), &capturingMailer{}, Config{
		BaseURL: "https://relayium.com", SessionTTL: time.Hour,
	})
}

func TestRegisterThenLoginRoundTrip(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	sess, err := svc.Register(ctx, "New@Example.com", "hunter2hunter", "New User")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	u, ok, err := svc.ValidateSession(ctx, sess.ID)
	if err != nil || !ok {
		t.Fatalf("session invalid after register: ok=%v err=%v", ok, err)
	}
	if u.Email != "new@example.com" {
		t.Fatalf("email not normalized: %q", u.Email)
	}

	// 正确密码登录成功。
	if _, err := svc.Login(ctx, "new@example.com", "hunter2hunter"); err != nil {
		t.Fatalf("login: %v", err)
	}
	// 错误密码返回 ErrBadCredentials。
	if _, err := svc.Login(ctx, "new@example.com", "wrongpass1"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("wrong password: want ErrBadCredentials, got %v", err)
	}
	// 不存在的邮箱同样 ErrBadCredentials（不泄露枚举）。
	if _, err := svc.Login(ctx, "ghost@example.com", "hunter2hunter"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("unknown email: want ErrBadCredentials, got %v", err)
	}
}

func TestRegisterRejectsWeakAndDuplicate(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()

	if _, err := svc.Register(ctx, "a@example.com", "short", ""); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("short password: want ErrWeakPassword, got %v", err)
	}
	if _, err := svc.Register(ctx, "dup@example.com", "longenough1", ""); err != nil {
		t.Fatalf("first register: %v", err)
	}
	if _, err := svc.Register(ctx, "Dup@Example.com", "longenough2", ""); !errors.Is(err, ErrEmailTaken) {
		t.Fatalf("duplicate email: want ErrEmailTaken, got %v", err)
	}
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `cd server && go test ./internal/account/ -run 'Register|Login' -v`
Expected: 编译失败 —— `svc.Register undefined`、`ErrBadCredentials undefined` 等。

- [ ] **Step 4: 实现 password.go**

新建 `server/internal/account/password.go`：

```go
package account

import (
	"context"
	"errors"

	"golang.org/x/crypto/bcrypt"
)

const minPasswordLen = 8

var (
	// ErrEmailTaken 表示该邮箱已设置过密码。
	ErrEmailTaken = errors.New("account: email already registered")
	// ErrBadCredentials 同时覆盖"邮箱不存在"与"密码错误"，避免账号枚举。
	ErrBadCredentials = errors.New("account: invalid credentials")
	// ErrWeakPassword 表示密码短于 minPasswordLen。
	ErrWeakPassword = errors.New("account: password too short")
)

// Register 创建（或为已有无密码账号补设）密码并登录。同一邮箱已设密码时拒绝。
func (s *Service) Register(ctx context.Context, email, password, displayName string) (Session, error) {
	email = normEmail(email)
	if len(password) < minPasswordLen {
		return Session{}, ErrWeakPassword
	}
	if _, _, ok, err := s.store.GetCredentials(ctx, email); err != nil {
		return Session{}, err
	} else if ok {
		return Session{}, ErrEmailTaken
	}
	u, err := s.store.UpsertUserByEmail(ctx, email, displayName)
	if err != nil {
		return Session{}, err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return Session{}, err
	}
	if err := s.store.SetPassword(ctx, u.ID, string(hash)); err != nil {
		return Session{}, err
	}
	if err := s.store.LinkIdentity(ctx, "password", email, u.ID); err != nil {
		return Session{}, err
	}
	return s.IssueSession(ctx, u.ID)
}

// Login 校验邮箱+密码并签发会话。任何失败都返回 ErrBadCredentials。
func (s *Service) Login(ctx context.Context, email, password string) (Session, error) {
	email = normEmail(email)
	uid, hash, ok, err := s.store.GetCredentials(ctx, email)
	if err != nil {
		return Session{}, err
	}
	if !ok {
		return Session{}, ErrBadCredentials
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		return Session{}, ErrBadCredentials
	}
	return s.IssueSession(ctx, uid)
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd server && go test ./internal/account/ -run 'Register|Login' -v`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add server/go.mod server/go.sum server/internal/account/password.go server/internal/account/password_test.go
git commit -m "feat(account): email+password Register/Login with bcrypt"
```

---

### Task 3: 注册/登录/方法 HTTP 端点 + Google/magic 条件注册

**Files:**
- Modify: `server/internal/account/service.go`（`Config` 加 `EnableGoogle`、`EnableMagic`、`AdminPassword`）
- Modify: `server/internal/account/handlers.go`（`Routes()` 改造；加 3 个 handler；加 `errors` 导入）
- Test: `server/internal/account/handlers_test.go`

**Interfaces:**
- Consumes（Task 2）：`s.Register`、`s.Login`、`ErrEmailTaken`、`ErrWeakPassword`、`ErrBadCredentials`。
- Produces:
  - 路由 `POST /api/auth/register`、`POST /api/auth/password/login`、`GET /api/auth/methods`（始终注册）。
  - `GET /api/auth/magic/*`、`GET /api/auth/google/*` 仅在对应开关为 true 时注册。
  - `Config.EnableGoogle bool`、`Config.EnableMagic bool`、`Config.AdminPassword string`。

- [ ] **Step 1: 写失败测试**

在 `handlers_test.go` 末尾追加（`net/http`、`strings`、`encoding/json` 已导入）：

```go
func TestPasswordRegisterLoginAndMethods(t *testing.T) {
	store := newTestStore(t)
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
		EnableGoogle: false, EnableMagic: false,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// methods 反映开关：password 恒 true，google/magic 关。
	resp, _ := client.Get(ts.URL + "/api/auth/methods")
	var m struct{ Password, Google, Magic bool }
	_ = json.NewDecoder(resp.Body).Decode(&m)
	if !m.Password || m.Google || m.Magic {
		t.Fatalf("methods = %+v, want password-only", m)
	}

	// magic 关闭 => 路由不存在（404）。
	resp, _ = client.Post(ts.URL+"/api/auth/magic/request", "application/x-www-form-urlencoded", strings.NewReader("email=x@example.com"))
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("disabled magic should 404, got %d", resp.StatusCode)
	}

	// 注册成功 => 200 + session cookie。
	resp, _ = client.Post(ts.URL+"/api/auth/register", "application/json",
		strings.NewReader(`{"email":"u@example.com","password":"longenough1"}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("register: %d", resp.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("register set no session cookie")
	}

	// 重复注册 => 409。
	resp, _ = client.Post(ts.URL+"/api/auth/register", "application/json",
		strings.NewReader(`{"email":"u@example.com","password":"longenough2"}`))
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate register: want 409, got %d", resp.StatusCode)
	}

	// 密码过短 => 400。
	resp, _ = client.Post(ts.URL+"/api/auth/register", "application/json",
		strings.NewReader(`{"email":"v@example.com","password":"short"}`))
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("weak password: want 400, got %d", resp.StatusCode)
	}

	// 正确密码登录 => 200；错误密码 => 401。
	resp, _ = client.Post(ts.URL+"/api/auth/password/login", "application/json",
		strings.NewReader(`{"email":"u@example.com","password":"longenough1"}`))
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login: %d", resp.StatusCode)
	}
	resp, _ = client.Post(ts.URL+"/api/auth/password/login", "application/json",
		strings.NewReader(`{"email":"u@example.com","password":"nope"}`))
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad login: want 401, got %d", resp.StatusCode)
	}
}

func TestMethodsReflectsEnabledFlags(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{
		BaseURL: "http://example.test", EnableGoogle: true, EnableMagic: true,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	resp, _ := ts.Client().Get(ts.URL + "/api/auth/methods")
	var m struct{ Password, Google, Magic bool }
	_ = json.NewDecoder(resp.Body).Decode(&m)
	if !(m.Password && m.Google && m.Magic) {
		t.Fatalf("all enabled: methods = %+v", m)
	}
}
```

注意：既有测试 `newTestServer` 用的 Config 没开 magic，而 `TestMagicLinkRoundTripIssuesSession` 等走的是 `Service` 方法（非 HTTP），不受路由开关影响；但 `TestMagicRequestAlwaysOKAndLoginFlow`、`TestDeviceCRUDOverHTTP`、`TestUsageEndpoint...`、`TestCreateTransfer...` 经由 HTTP 用了 magic 登录。必须在它们用的 `newTestServer` 及就地构造的 Config 上打开 `EnableMagic: true`，详见 Step 4 末尾。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./internal/account/ -run 'PasswordRegister|MethodsReflects' -v`
Expected: 编译失败（`Config` 无 `EnableGoogle` 字段等）。

- [ ] **Step 3: 加 Config 字段**

在 `service.go` 的 `Config` struct 末尾追加：

```go
	EnableGoogle  bool
	EnableMagic   bool
	AdminPassword string
```

- [ ] **Step 4: 改造 Routes 并加 handler**

把 `handlers.go` 的 `import` 块加入 `"errors"`：

```go
import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)
```

将 `Routes()` 中认证相关的注册替换为：

```go
func (s *Service) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/password/login", s.handlePasswordLogin)
	mux.HandleFunc("GET /api/auth/methods", s.handleAuthMethods)
	if s.cfg.EnableMagic {
		mux.HandleFunc("POST /api/auth/magic/request", s.handleMagicRequest)
		mux.HandleFunc("GET /api/auth/magic/verify", s.handleMagicVerify)
	}
	if s.cfg.EnableGoogle {
		mux.HandleFunc("GET /api/auth/google/start", s.handleGoogleStart)
		mux.HandleFunc("GET /api/auth/google/callback", s.handleGoogleCallback)
	}
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("GET /api/me", s.RequireSession(s.handleMe))
	mux.HandleFunc("GET /api/devices", s.RequireSession(s.handleListDevices))
	mux.HandleFunc("POST /api/devices", s.RequireSession(s.handleUpsertDevice))
	mux.HandleFunc("PATCH /api/devices/{id}", s.RequireSession(s.handleRenameDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", s.RequireSession(s.handleDeleteDevice))
	mux.HandleFunc("POST /api/transfers", s.RequireSession(s.handleCreateTransfer))
	mux.HandleFunc("GET /api/ice", s.handleICE)
	mux.HandleFunc("GET /api/usage", s.RequireSession(s.handleUsage))
	return mux
}
```

在 `handlers.go` 末尾追加三个 handler：

```go
func (s *Service) handleAuthMethods(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{
		"password": true,
		"google":   s.cfg.EnableGoogle,
		"magic":    s.cfg.EnableMagic,
	})
}

func (s *Service) writeUser(w http.ResponseWriter, code int, u User) {
	writeJSON(w, code, map[string]any{
		"user": map[string]string{"id": u.ID, "email": u.Email, "displayName": u.DisplayName},
	})
}

func (s *Service) handleRegister(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email       string `json:"email"`
		Password    string `json:"password"`
		DisplayName string `json:"displayName"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	sess, err := s.Register(r.Context(), in.Email, in.Password, in.DisplayName)
	switch {
	case errors.Is(err, ErrWeakPassword):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password too short"})
		return
	case errors.Is(err, ErrEmailTaken):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "email already registered"})
		return
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	u, err := s.store.GetUserByID(r.Context(), sess.UserID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.setSessionCookie(w, sess)
	s.writeUser(w, http.StatusOK, u)
}

func (s *Service) handlePasswordLogin(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	sess, err := s.Login(r.Context(), in.Email, in.Password)
	if errors.Is(err, ErrBadCredentials) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	u, err := s.store.GetUserByID(r.Context(), sess.UserID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	s.setSessionCookie(w, sess)
	s.writeUser(w, http.StatusOK, u)
}
```

修复既有 HTTP 测试：把 `newTestServer`（`handlers_test.go` 第 18 行附近）与 `TestUsageEndpoint...`、`TestCreateTransfer...` 里就地构造的 `Config` 都加上 `EnableMagic: true`（因为它们靠 magic-link 登录）。例如 `newTestServer`：

```go
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour, MagicTTL: 15 * time.Minute, TransferTTL: time.Hour, EnableMagic: true})
```

同样给 `TestUsageEndpointRequiresSessionAndReturnsTotal`（第 148 行附近）和任何其它直接构造 `httptest.NewServer(svc.Routes())` 且依赖 `/api/auth/magic/*` 的 Config 补 `EnableMagic: true`。

- [ ] **Step 5: 运行全包测试确认通过**

Run: `cd server && go test ./internal/account/ -v`
Expected: 全部 PASS（含新测试与修复后的既有 HTTP 测试）。

- [ ] **Step 6: 提交**

```bash
git add server/internal/account/service.go server/internal/account/handlers.go server/internal/account/handlers_test.go
git commit -m "feat(account): register/login/methods endpoints; gate google+magic behind config flags"
```

---

### Task 4: 后台用户聚合查询

**Files:**
- Modify: `server/internal/account/store.go`（加 `AdminUserRow` 类型 + 接口方法）
- Modify: `server/internal/account/sqlite.go`（实现 `AdminListUsers`）
- Test: `server/internal/account/sqlite_test.go`

**Interfaces:**
- Produces:
  - 类型 `AdminUserRow{ ID, Email, DisplayName string; CreatedAt int64; Methods []string; DeviceCount int; RelayedBytes int64 }`
  - `AdminListUsers(ctx context.Context) ([]AdminUserRow, error)` — 按 `created_at DESC` 排序；`Methods` 为该用户在 `identities` 表中出现的 provider 升序去重列表。

- [ ] **Step 1: 写失败测试**

在 `sqlite_test.go` 末尾追加（需要 `sort`、`context` 已导入；加 `sort`）。先确认文件顶部 import 含 `"sort"`，没有则加。然后：

```go
func TestAdminListUsersAggregates(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	u, _ := s.UpsertUserByEmail(ctx, "agg@example.com", "Agg")
	_ = s.SetPassword(ctx, u.ID, "h")
	_ = s.LinkIdentity(ctx, "password", "agg@example.com", u.ID)
	_ = s.LinkIdentity(ctx, "google", "google-sub-1", u.ID)
	_, _ = s.UpsertDevice(ctx, Device{ID: "d1", UserID: u.ID, Name: "Laptop", CreatedAt: 1})
	_, _ = s.UpsertDevice(ctx, Device{ID: "d2", UserID: u.ID, Name: "Phone", CreatedAt: 2})
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "t", UserID: u.ID, RelayedBytes: 700, RecordedAt: 1})

	// 第二个用户：无设备、无流量、仅 password。
	u2, _ := s.UpsertUserByEmail(ctx, "solo@example.com", "Solo")
	_ = s.LinkIdentity(ctx, "password", "solo@example.com", u2.ID)

	rows, err := s.AdminListUsers(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows, got %d", len(rows))
	}
	var agg *AdminUserRow
	for i := range rows {
		if rows[i].Email == "agg@example.com" {
			agg = &rows[i]
		}
	}
	if agg == nil {
		t.Fatalf("agg row missing")
	}
	if agg.DeviceCount != 2 {
		t.Fatalf("device count = %d, want 2", agg.DeviceCount)
	}
	if agg.RelayedBytes != 700 {
		t.Fatalf("relayed = %d, want 700", agg.RelayedBytes)
	}
	want := []string{"google", "password"}
	got := append([]string(nil), agg.Methods...)
	sort.Strings(got)
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("methods = %v, want %v", agg.Methods, want)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && go test ./internal/account/ -run AdminListUsers -v`
Expected: 编译失败 —— `s.AdminListUsers undefined`、`AdminUserRow` 未定义。

- [ ] **Step 3: 加类型 + 接口 + 实现**

在 `store.go` 的类型定义区（`UsageEvent` 之后）追加：

```go
// AdminUserRow 是后台用户列表的一行聚合视图（只读）。
type AdminUserRow struct {
	ID           string
	Email        string
	DisplayName  string
	CreatedAt    int64
	Methods      []string // identities 表里的 provider 去重升序
	DeviceCount  int
	RelayedBytes int64
}
```

在 `Store` interface 末尾追加：

```go
	// admin (read-only)
	AdminListUsers(ctx context.Context) ([]AdminUserRow, error)
```

在 `sqlite.go` 末尾追加（顶部 import 加 `"sort"`）：

```go
func (s *SQLiteStore) AdminListUsers(ctx context.Context) ([]AdminUserRow, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.email, u.display_name, u.created_at,
		       (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id),
		       (SELECT COALESCE(SUM(relayed_bytes), 0) FROM usage_events e WHERE e.user_id = u.id)
		FROM users u
		ORDER BY u.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []AdminUserRow
	index := map[string]int{}
	for rows.Next() {
		var row AdminUserRow
		if err := rows.Scan(&row.ID, &row.Email, &row.DisplayName, &row.CreatedAt,
			&row.DeviceCount, &row.RelayedBytes); err != nil {
			return nil, err
		}
		index[row.ID] = len(out)
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 单独一遍把 provider 摊到对应用户，避免 N+1。
	irows, err := s.db.QueryContext(ctx, `SELECT user_id, provider FROM identities`)
	if err != nil {
		return nil, err
	}
	defer irows.Close()
	seen := map[string]map[string]bool{}
	for irows.Next() {
		var uid, provider string
		if err := irows.Scan(&uid, &provider); err != nil {
			return nil, err
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
		return nil, err
	}
	for i := range out {
		sort.Strings(out[i].Methods)
	}
	return out, nil
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && go test ./internal/account/ -run AdminListUsers -v`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go
git commit -m "feat(account): AdminListUsers aggregating methods, device count, relayed bytes"
```

---

### Task 5: 管理后台鉴权 + 页面

**Files:**
- Create: `server/internal/account/admin.go`
- Modify: `server/internal/account/service.go`（`Service` 加 `adminSessions` 字段；`NewService` 初始化；加 `sync` 导入）
- Test: `server/internal/account/admin_test.go`（新建）

**Interfaces:**
- Consumes（Task 4）：`store.AdminListUsers`；既有 `s.cookieSecure`、`s.now`、`randToken`。
- Produces:
  - `AdminEnabled() bool`
  - `RegisterAdmin(mux *http.ServeMux)` — 仅在 `AdminEnabled()` 时把 `GET /admin`、`POST /admin/login`、`POST /admin/logout` 注册到传入的根 mux。
  - 常量 `adminCookie = "relayium_admin"`。

- [ ] **Step 1: 给 Service 加内存登录态**

在 `service.go` 顶部 import 加 `"sync"`。`Service` struct 增加字段：

```go
	adminSessions map[string]int64 // token -> 过期 unix 秒
	adminMu       sync.Mutex
```

`NewService` 改为初始化该 map：

```go
func NewService(store Store, mailer Mailer, cfg Config) *Service {
	svc := &Service{store: store, mailer: mailer, cfg: cfg, now: time.Now, adminSessions: map[string]int64{}}
	svc.fetchGoogleUser = svc.realFetchGoogleUser
	return svc
}
```

- [ ] **Step 2: 写失败测试**

新建 `server/internal/account/admin_test.go`：

```go
package account

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newAdminServer(t *testing.T, pass string) *httptest.Server {
	t.Helper()
	store := newTestStore(t)
	// 种一个用户，列表里能看到。
	_, _ = store.UpsertUserByEmail(context.Background(), "seen@example.com", "Seen")
	svc := NewService(store, &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour, AdminPassword: pass,
	})
	mux := http.NewServeMux()
	svc.RegisterAdmin(mux)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts
}

func TestAdminDisabledWhenNoPassword(t *testing.T) {
	ts := newAdminServer(t, "")
	resp, _ := ts.Client().Get(ts.URL + "/admin")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("admin off => /admin should 404, got %d", resp.StatusCode)
	}
}

func TestAdminLoginGate(t *testing.T) {
	ts := newAdminServer(t, "s3cret")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// 未登录 GET /admin => 登录表单，不含用户邮箱。
	resp, _ := client.Get(ts.URL + "/admin")
	if resp.StatusCode != http.StatusOK || !bodyContains(resp, "password") {
		t.Fatalf("unauth admin should show login form")
	}

	// 错误密码 => 不设 cookie。
	resp, _ = client.PostForm(ts.URL+"/admin/login", map[string][]string{"password": {"wrong"}})
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			t.Fatalf("wrong password must not set admin cookie")
		}
	}

	// 正确密码 => 设 cookie + 重定向。
	resp, _ = client.PostForm(ts.URL+"/admin/login", map[string][]string{"password": {"s3cret"}})
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("good login should redirect, got %d", resp.StatusCode)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			cookie = c
		}
	}
	if cookie == nil {
		t.Fatalf("good login set no admin cookie")
	}

	// 带 cookie GET /admin => 用户列表含 seeded 邮箱。
	req, _ := http.NewRequest("GET", ts.URL+"/admin", nil)
	req.AddCookie(cookie)
	resp, _ = client.Do(req)
	if !bodyContains(resp, "seen@example.com") {
		t.Fatalf("authed admin should list users")
	}
}
```

注意：`bodyContains` 已在 `handlers_test.go`（同包）定义，这里直接复用。

- [ ] **Step 3: 运行测试确认失败**

Run: `cd server && go test ./internal/account/ -run Admin -v`
Expected: 编译失败 —— `svc.RegisterAdmin undefined`、`adminCookie undefined`。

- [ ] **Step 4: 实现 admin.go**

新建 `server/internal/account/admin.go`：

```go
package account

import (
	"crypto/subtle"
	"html/template"
	"net/http"
	"time"
)

const (
	adminCookie     = "relayium_admin"
	adminSessionTTL = 12 * time.Hour
)

// AdminEnabled 报告是否配置了管理员密码。
func (s *Service) AdminEnabled() bool { return s.cfg.AdminPassword != "" }

// RegisterAdmin 在根 mux 上挂载 /admin 路由（仅当配置了密码）。
func (s *Service) RegisterAdmin(mux *http.ServeMux) {
	if !s.AdminEnabled() {
		return
	}
	mux.HandleFunc("GET /admin", s.handleAdminHome)
	mux.HandleFunc("POST /admin/login", s.handleAdminLogin)
	mux.HandleFunc("POST /admin/logout", s.handleAdminLogout)
}

func (s *Service) newAdminSession() string {
	tok := randToken()
	s.adminMu.Lock()
	s.adminSessions[tok] = s.now().Add(adminSessionTTL).Unix()
	s.adminMu.Unlock()
	return tok
}

func (s *Service) validAdmin(tok string) bool {
	if tok == "" {
		return false
	}
	s.adminMu.Lock()
	defer s.adminMu.Unlock()
	exp, ok := s.adminSessions[tok]
	if !ok {
		return false
	}
	if s.now().Unix() >= exp {
		delete(s.adminSessions, tok)
		return false
	}
	return true
}

func (s *Service) isAdminReq(r *http.Request) bool {
	c, err := r.Cookie(adminCookie)
	return err == nil && s.validAdmin(c.Value)
}

func (s *Service) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	pass := r.FormValue("password")
	if subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.AdminPassword)) != 1 {
		w.WriteHeader(http.StatusUnauthorized)
		renderAdminLogin(w, "密码错误")
		return
	}
	tok := s.newAdminSession()
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(adminSessionTTL / time.Second),
	})
	http.Redirect(w, r, "/admin", http.StatusFound)
}

func (s *Service) handleAdminLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(adminCookie); err == nil {
		s.adminMu.Lock()
		delete(s.adminSessions, c.Value)
		s.adminMu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: "", Path: "/admin", MaxAge: -1,
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, "/admin", http.StatusFound)
}

func (s *Service) handleAdminHome(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		renderAdminLogin(w, "")
		return
	}
	rows, err := s.store.AdminListUsers(r.Context())
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	if err := adminUsersTmpl.Execute(w, rows); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
	}
}

func renderAdminLogin(w http.ResponseWriter, errMsg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = adminLoginTmpl.Execute(w, map[string]string{"Error": errMsg})
}

var adminLoginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin</title>
<style>body{font:15px system-ui;max-width:360px;margin:80px auto;padding:0 16px}
input,button{font:inherit;padding:8px 10px;width:100%;box-sizing:border-box;margin:6px 0}
.err{color:#c00}</style></head>
<body><h1>Relayium 后台</h1>
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
<form method="post" action="/admin/login">
<input type="password" name="password" placeholder="管理员密码" autofocus>
<button type="submit">登录</button>
</form></body></html>`))

var adminUsersTmpl = template.Must(template.New("users").Funcs(template.FuncMap{
	"ts":    func(sec int64) string { return time.Unix(sec, 0).UTC().Format("2006-01-02 15:04") },
	"bytes": humanBytes,
}).Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin · 用户</title>
<style>body{font:14px system-ui;margin:24px}h1{font-size:18px}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px;text-align:left}
th{background:#f5f5f5}.top{display:flex;justify-content:space-between;align-items:center}</style></head>
<body>
<div class="top"><h1>注册用户（{{len .}}）</h1>
<form method="post" action="/admin/logout"><button type="submit">退出</button></form></div>
<table><thead><tr>
<th>邮箱</th><th>显示名</th><th>注册时间(UTC)</th><th>登录方式</th><th>设备</th><th>中继流量</th>
</tr></thead><tbody>
{{range .}}<tr>
<td>{{.Email}}</td><td>{{.DisplayName}}</td><td>{{ts .CreatedAt}}</td>
<td>{{range $i, $m := .Methods}}{{if $i}}, {{end}}{{$m}}{{end}}</td>
<td>{{.DeviceCount}}</td><td>{{bytes .RelayedBytes}}</td>
</tr>{{end}}
</tbody></table>
</body></html>`))

// humanBytes 把字节数格式化为人类可读字符串。
func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmtInt(n) + " B"
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	val := float64(n) / float64(div)
	return fmtFloat(val) + " " + string("KMGTPE"[exp]) + "iB"
}

func fmtInt(n int64) string   { return template.HTMLEscapeString(itoa(n)) }
func fmtFloat(f float64) string {
	// 一位小数，足够后台展示。
	whole := int64(f)
	frac := int64((f - float64(whole)) * 10)
	return itoa(whole) + "." + itoa(frac)
}
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}
```

> 说明：为了不引入新依赖，`humanBytes` 自带极简整数/浮点格式化。若实现者更愿意用 `strconv`，可直接 `import "strconv"` 并用 `strconv.FormatInt`/`FormatFloat` 替换 `itoa`/`fmtFloat`，行为等价——任选其一，别留两套。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd server && go test ./internal/account/ -run Admin -v`
Expected: PASS（3 个 admin 测试）。再跑全包：`cd server && go test ./internal/account/` 应全绿。

- [ ] **Step 6: 提交**

```bash
git add server/internal/account/admin.go server/internal/account/service.go server/internal/account/admin_test.go
git commit -m "feat(account): read-only /admin dashboard with standalone admin password"
```

---

### Task 6: main.go flag 接线

**Files:**
- Modify: `server/main.go`

**Interfaces:**
- Consumes（Task 3/5）：`Config.EnableGoogle/EnableMagic/AdminPassword`、`acct.RegisterAdmin(mux)`。

- [ ] **Step 1: 加 flag**

在 `main.go` 的 flag 定义区（`stunURLs` 之后）追加：

```go
	enableGoogle := flag.Bool("enable-google", false, "enable Google OAuth login (disabled by default)")
	enableMagic := flag.Bool("enable-magic", false, "enable email magic-link login (disabled by default)")
	adminPass := flag.String("admin-pass", "", "admin dashboard password at /admin (empty disables the dashboard)")
```

- [ ] **Step 2: 写入 Config**

在 `account.NewService(... account.Config{...})` 的字面量中追加三个字段：

```go
			EnableGoogle:   *enableGoogle,
			EnableMagic:    *enableMagic,
			AdminPassword:  *adminPass,
```

- [ ] **Step 3: 注册 /admin 路由**

在 `mux.Handle("/api/", acct.Routes())` 之后、`dbErr` 的 `else` 块内追加：

```go
		acct.RegisterAdmin(mux)
```

- [ ] **Step 4: 编译并冒烟验证**

```bash
cd server && go build ./...
```
Expected: 编译通过。

手动冒烟（默认全关）：

```bash
cd server && go run . -db :memory: -admin-pass testpass &
sleep 1
curl -s localhost:8080/api/auth/methods            # {"google":false,"magic":false,"password":true}
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/api/auth/magic/request   # 404（magic 关）
curl -s -X POST localhost:8080/api/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","password":"longenough1"}' -i | grep -i set-cookie       # 有 relayium_session
curl -s -o /dev/null -w "%{http_code}\n" localhost:8080/admin                      # 200（登录表单）
kill %1
```
Expected: 各行输出如注释所示。

- [ ] **Step 5: 提交**

```bash
git add server/main.go
git commit -m "feat(server): -enable-google/-enable-magic/-admin-pass flags + mount /admin"
```

---

### Task 7: 前端账号密码表单 + 条件渲染

**Files:**
- Modify: `web/src/lib/auth.svelte.ts`（加 `fetchAuthMethods`、`register`、`passwordLogin`、`AuthMethods`）
- Modify: `web/src/lib/Account.svelte`（密码表单 + 据 methods 条件渲染）
- Modify: `web/src/lib/i18n.svelte.ts`（接口 + 6 语言新增文案）
- Test: `web/src/lib/auth.test.ts`

**Interfaces:**
- Consumes（Task 3）：`GET /api/auth/methods`、`POST /api/auth/register`、`POST /api/auth/password/login`。
- Produces:
  - `interface AuthMethods { password: boolean; google: boolean; magic: boolean }`
  - `fetchAuthMethods(): Promise<AuthMethods>`（失败回落 `{password:true,google:false,magic:false}`）
  - `register(email, password): Promise<{ ok: boolean; error?: string }>`
  - `passwordLogin(email, password): Promise<{ ok: boolean; error?: string }>`

- [ ] **Step 1: 写失败测试**

在 `web/src/lib/auth.test.ts` 的 `describe` 块内追加：

```ts
  it("fetchAuthMethods falls back to password-only on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch);
    const { fetchAuthMethods } = await import("./auth.svelte");
    const m = await fetchAuthMethods();
    expect(m).toEqual({ password: true, google: false, magic: false });
  });

  it("register sets the session user on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ user: { id: "u9", email: "r@b.com", displayName: "" } }),
    })) as unknown as typeof fetch);
    const { register, session } = await import("./auth.svelte");
    const res = await register("r@b.com", "longenough1");
    expect(res.ok).toBe(true);
    expect(session().user?.email).toBe("r@b.com");
  });

  it("register surfaces server error on 409", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 409, json: async () => ({ error: "email already registered" }),
    })) as unknown as typeof fetch);
    const { register } = await import("./auth.svelte");
    const res = await register("dup@b.com", "longenough1");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("registered");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd web && npx vitest run src/lib/auth.test.ts`
Expected: FAIL —— 从 `./auth.svelte` 导入的 `fetchAuthMethods`/`register` 不存在。

- [ ] **Step 3: 实现 auth.svelte.ts 函数**

在 `web/src/lib/auth.svelte.ts` 的 `googleLoginUrl` 之后追加：

```ts
export interface AuthMethods {
  password: boolean;
  google: boolean;
  magic: boolean;
}

export async function fetchAuthMethods(): Promise<AuthMethods> {
  try {
    const res = await fetch("/api/auth/methods", { credentials: "include" });
    if (res.ok) return (await res.json()) as AuthMethods;
  } catch {
    /* fall through to default */
  }
  return { password: true, google: false, magic: false };
}

async function postCredentials(
  path: string,
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) {
    const body = (await res.json()) as { user: SessionUser };
    user = body.user;
    return { ok: true };
  }
  let error = "error";
  try {
    error = ((await res.json()) as { error?: string }).error ?? error;
  } catch {
    /* non-JSON body */
  }
  return { ok: false, error };
}

export function register(email: string, password: string) {
  return postCredentials("/api/auth/register", email, password);
}

export function passwordLogin(email: string, password: string) {
  return postCredentials("/api/auth/password/login", email, password);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd web && npx vitest run src/lib/auth.test.ts`
Expected: PASS（含新增 3 个）。

- [ ] **Step 5: 加 i18n 文案**

在 `web/src/lib/i18n.svelte.ts` 的 `Messages` 接口 `account` 块（约 61 行）加字段：

```ts
    password: string;
    createAccount: string;
    logInBtn: string;
    toRegister: string;
    toLogin: string;
    errTooShort: string;
    errEmailTaken: string;
    errLogin: string;
```

然后在 6 个语言对象的 `account` 块里，紧跟 `signedInAs` 之后各加：

zh（约 143 行后）:
```ts
    password: "密码",
    createAccount: "注册",
    logInBtn: "登录",
    toRegister: "没有账号？去注册",
    toLogin: "已有账号？去登录",
    errTooShort: "密码至少 8 位。",
    errEmailTaken: "该邮箱已注册，请直接登录。",
    errLogin: "邮箱或密码错误。",
```
en:
```ts
    password: "Password",
    createAccount: "Create account",
    logInBtn: "Log in",
    toRegister: "No account? Sign up",
    toLogin: "Have an account? Log in",
    errTooShort: "Password must be at least 8 characters.",
    errEmailTaken: "That email is already registered — please log in.",
    errLogin: "Wrong email or password.",
```
ja:
```ts
    password: "パスワード",
    createAccount: "登録",
    logInBtn: "ログイン",
    toRegister: "アカウントがない？新規登録",
    toLogin: "アカウントをお持ちの方はログイン",
    errTooShort: "パスワードは8文字以上にしてください。",
    errEmailTaken: "このメールは登録済みです。ログインしてください。",
    errLogin: "メールアドレスまたはパスワードが違います。",
```
ko:
```ts
    password: "비밀번호",
    createAccount: "회원가입",
    logInBtn: "로그인",
    toRegister: "계정이 없으신가요? 가입하기",
    toLogin: "이미 계정이 있으신가요? 로그인",
    errTooShort: "비밀번호는 8자 이상이어야 합니다.",
    errEmailTaken: "이미 가입된 이메일입니다. 로그인해 주세요.",
    errLogin: "이메일 또는 비밀번호가 올바르지 않습니다.",
```
de:
```ts
    password: "Passwort",
    createAccount: "Registrieren",
    logInBtn: "Anmelden",
    toRegister: "Kein Konto? Registrieren",
    toLogin: "Schon ein Konto? Anmelden",
    errTooShort: "Das Passwort muss mindestens 8 Zeichen haben.",
    errEmailTaken: "Diese E-Mail ist bereits registriert — bitte anmelden.",
    errLogin: "Falsche E-Mail oder falsches Passwort.",
```
fr:
```ts
    password: "Mot de passe",
    createAccount: "Créer un compte",
    logInBtn: "Se connecter",
    toRegister: "Pas de compte ? S'inscrire",
    toLogin: "Déjà un compte ? Se connecter",
    errTooShort: "Le mot de passe doit comporter au moins 8 caractères.",
    errEmailTaken: "Cet e-mail est déjà enregistré — veuillez vous connecter.",
    errLogin: "E-mail ou mot de passe incorrect.",
```

- [ ] **Step 6: 改 Account.svelte 用密码表单 + 条件渲染**

将 `web/src/lib/Account.svelte` 的 `<script>` 顶部 import 与状态替换为：

```svelte
<script lang="ts">
  import { onMount } from "svelte";
  import {
    session, refreshSession, logout, localDeviceId,
    googleLoginUrl, requestMagicLink,
    register, passwordLogin, fetchAuthMethods, type AuthMethods,
  } from "./auth.svelte";
  import { lang, messages, type Messages } from "./i18n.svelte";

  const t = $derived<Messages>(messages[lang()]);
  let open = $state(false);
  let email = $state("");
  let password = $state("");
  let mode = $state<"login" | "register">("login");
  let error = $state("");
  let methods = $state<AuthMethods>({ password: true, google: false, magic: false });

  // magic-link 备用入口（仅当后端开启）
  let magicSent = $state(false);

  async function claimDevice() {
    try {
      await fetch("/api/devices", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: localDeviceId(), name: navigator.platform || "device" }),
      });
    } catch { /* non-fatal */ }
  }

  onMount(async () => {
    methods = await fetchAuthMethods();
    await refreshSession();
    if (session().user) claimDevice();
  });

  function mapError(code?: string): string {
    if (code === "password too short") return t.account.errTooShort;
    if (code === "email already registered") return t.account.errEmailTaken;
    if (code === "invalid credentials") return t.account.errLogin;
    return t.account.errLogin;
  }

  async function onSubmit() {
    error = "";
    if (!email || !password) return;
    const res = mode === "register"
      ? await register(email, password)
      : await passwordLogin(email, password);
    if (res.ok) {
      open = false;
      password = "";
      claimDevice();
    } else {
      error = mapError(res.error);
    }
  }

  async function onSendLink() {
    if (!email) return;
    await requestMagicLink(email);
    magicSent = true;
  }

  async function onLogout() {
    await logout();
    open = false;
  }
</script>
```

把 `{:else}`（未登录）分支的菜单替换为：

```svelte
  {:else}
    <button class="acct-btn" onclick={() => (open = !open)}>{t.account.signIn}</button>
    {#if open}
      <div class="menu">
        <input type="email" bind:value={email} placeholder={t.account.email} />
        <input type="password" bind:value={password} placeholder={t.account.password} />
        {#if error}<p class="err">{error}</p>{/if}
        <button class="primary" onclick={onSubmit}>
          {mode === "register" ? t.account.createAccount : t.account.logInBtn}
        </button>
        <button class="link" onclick={() => { mode = mode === "register" ? "login" : "register"; error = ""; }}>
          {mode === "register" ? t.account.toLogin : t.account.toRegister}
        </button>

        {#if methods.google || methods.magic}
          <div class="sep">{t.account.or}</div>
        {/if}
        {#if methods.google}
          <a class="google" href={googleLoginUrl()}>{t.account.continueGoogle}</a>
        {/if}
        {#if methods.magic}
          {#if magicSent}
            <p class="hint">{t.account.linkSent}</p>
          {:else}
            <button class="ghost" onclick={onSendLink}>{t.account.sendLink}</button>
          {/if}
        {/if}
      </div>
    {/if}
  {/if}
```

在 `<style>` 块追加：

```svelte
  .menu .err { color: #c00; font-size: 12px; margin: 0; }
  .menu .link { background: none; border: none; color: var(--text); cursor: pointer; font: inherit; font-size: 12px; padding: 2px; text-decoration: underline; }
  .menu .primary { padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--text-h); color: var(--bg); cursor: pointer; font: inherit; }
  .menu .ghost { padding: 8px; border-radius: 8px; border: 1px solid var(--border); background: var(--social-bg); color: var(--text-h); cursor: pointer; font: inherit; }
```
（若 `.primary` / `.ghost` 已在别处定义则跳过重复项，避免重复样式。）

- [ ] **Step 7: 类型检查 + 全量前端测试**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: 类型无错误；测试全绿。

- [ ] **Step 8: 构建确认**

Run: `cd web && npm run build`
Expected: 构建成功，无未用导入/类型错误。

- [ ] **Step 9: 提交**

```bash
git add web/src/lib/auth.svelte.ts web/src/lib/Account.svelte web/src/lib/i18n.svelte.ts web/src/lib/auth.test.ts
git commit -m "feat(web): email+password sign-up/login form; hide google+magic unless enabled"
```

---

## 收尾验证（全部任务完成后）

- [ ] 后端全测试：`cd server && go test ./...` 全绿。
- [ ] 前端：`cd web && npx vitest run` 全绿，`npm run build` 成功。
- [ ] 端到端冒烟：`cd server && go run . -db :memory: -admin-pass testpass`，前端 `cd web && npm run dev`，浏览器走一遍：注册 → 自动登录 → 退出 → 登录；`/admin` 输 `testpass` 看到刚注册的用户、登录方式列显示 `password`、设备数随"附近设备"注册增长。
- [ ] 确认默认不传 `-enable-google`/`-enable-magic` 时，登录浮层只显示邮箱+密码，无 Google 按钮、无 magic-link。

## 备注：将来重新启用 Google / 邮箱

无需改代码：启动时加 `-enable-google -google-id ... -google-secret ...` 或 `-enable-magic`（配合 `-smtp-*`）即可。前端 `/api/auth/methods` 会自动放出对应入口。
