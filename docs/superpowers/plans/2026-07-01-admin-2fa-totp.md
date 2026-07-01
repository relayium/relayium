# 管理员 2FA(TOTP)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `/admin` 管理员登录加一层基于环境变量静态密钥的 TOTP 双因素认证,默认关闭、向后兼容。

**Architecture:** 新增 env `RELAYIUM_ADMIN_TOTP_SECRET`(base32)。密钥非空即在现有 `handleAdminLogin` 的账号/密码常量时间比对之后追加一步 TOTP 校验(±1 步容差 + 内存防重放),单页一次填。`/admin/login` 加内存失败限流。一个 `-gen-admin-totp` CLI 分支生成密钥并打印 base32 + otpauth URL + ASCII 二维码后退出。管理员不入库,与现有"管理员活在 env"的架构一致。

**Tech Stack:** Go 1.26,标准库 `net/http`,`github.com/pquerna/otp`(TOTP),`github.com/mdp/qrterminal/v3`(终端二维码)。测试 `go test`。

## Global Constraints

- 密钥来源:env/flag `RELAYIUM_ADMIN_TOTP_SECRET` / `-admin-totp-secret`,**不入数据库**。
- 启用判定:`AdminEnabled() && cfg.AdminTOTPSecret != ""`。密钥空 → 现状不变(仅账号+密码)。
- TOTP 参数固定:**SHA1 / 6 位 / 30 秒周期 / Skew=1**(±1 时间步,共 90 秒窗口)。
- 登录任一因素(账号/密码/验证码)失败 → 同一句 `账号、密码或验证码错误`,HTTP 401,不泄露哪个因素错。
- 限流默认常量:阈值 `N=5` 次连续失败,锁定 `W=15分钟`;**不做成可配置**。锁定期内返回 HTTP 429。
- 防重放:一旦某时间步的码被成功用于登录,该步及更早的步的码不可再用(单调 `adminTOTPLastStep`)。
- 管理员密码比对**保持常量时间**(现有 `crypto/subtle`),TOTP 与限流不改这一点。
- 复用现有取 IP 语义:XFF 首段优先,否则 `RemoteAddr` 去端口(与 `internal/signal/roomkey.go` 的 `ClientIP` 同约定)。
- 遵循现有代码风格:错误信息/注释可中英混排(与 admin.go 现状一致),不引入 web 框架。

---

### Task 1: 引入依赖 + TOTP 校验核心(纯逻辑,可单测)

**Files:**
- Modify: `server/go.mod` / `server/go.sum`(新增依赖)
- Modify: `server/internal/account/service.go`(Config 加字段;Service 加防重放字段)
- Create: `server/internal/account/totp.go`
- Test: `server/internal/account/totp_test.go`

**Interfaces:**
- Produces:
  - `Config.AdminTOTPSecret string`(service.go 的 Config 结构新增字段,置于 `AdminPassword` 之后)
  - `Service` 新增字段:`adminTOTPMu sync.Mutex`、`adminTOTPLastStep int64`
  - `func (s *Service) AdminTOTPEnabled() bool`
  - `func (s *Service) validateAdminTOTP(code string) bool`
  - `func validateAdminTOTPSecret(secret string) error`(包级函数,供启动期校验单测)

- [ ] **Step 1: 加依赖**

Run(在 `server/` 目录):
```bash
go get github.com/pquerna/otp@latest
go get github.com/mdp/qrterminal/v3@latest
```
Expected: `go.mod` 出现这两个 require,`go.sum` 更新。

- [ ] **Step 2: Config 加字段**

在 `server/internal/account/service.go` 的 `Config` 结构,`AdminPassword string`(第 31 行)之后加一行:
```go
	AdminPassword   string
	AdminTOTPSecret string // base32 TOTP secret; empty disables admin 2FA
```
在 `Service` 结构(第 39-48 行)`adminMu sync.Mutex` 之后加:
```go
	adminMu           sync.Mutex
	adminTOTPMu       sync.Mutex
	adminTOTPLastStep int64 // last TOTP time-step accepted for admin login (replay guard)
```

- [ ] **Step 3: 写失败测试 `totp_test.go`**

```go
package account

import (
	"testing"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

const testSecret = "JBSWY3DPEHPK3PXP" // base32, RFC 6238-style test secret

// codeAt generates the valid 6-digit code for the fixed test secret at time t.
func codeAt(t *testing.T, tm time.Time) string {
	t.Helper()
	code, err := totp.GenerateCodeCustom(testSecret, tm, totp.ValidateOpts{
		Period: 30, Skew: 0, Digits: otp.DigitsSix, Algorithm: otp.AlgorithmSHA1,
	})
	if err != nil {
		t.Fatalf("GenerateCodeCustom: %v", err)
	}
	return code
}

func newTOTPService(secret string, at time.Time) *Service {
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminPassword: "pw", AdminTOTPSecret: secret})
	s.now = func() time.Time { return at }
	return s
}

func TestAdminTOTPEnabled(t *testing.T) {
	if newTOTPService("", time.Unix(0, 0)).AdminTOTPEnabled() {
		t.Fatal("empty secret should disable 2FA")
	}
	if !newTOTPService(testSecret, time.Unix(0, 0)).AdminTOTPEnabled() {
		t.Fatal("non-empty secret should enable 2FA")
	}
}

func TestValidateAdminTOTP(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)

	if !s.validateAdminTOTP(codeAt(t, base)) {
		t.Fatal("current-step code should pass")
	}
}

func TestValidateAdminTOTPSkew(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)

	// -1 step
	s := newTOTPService(testSecret, base)
	if !s.validateAdminTOTP(codeAt(t, base.Add(-30*time.Second))) {
		t.Fatal("-1 step code should pass (skew=1)")
	}
	// +1 step
	s = newTOTPService(testSecret, base)
	if !s.validateAdminTOTP(codeAt(t, base.Add(30*time.Second))) {
		t.Fatal("+1 step code should pass (skew=1)")
	}
	// +2 steps must fail
	s = newTOTPService(testSecret, base)
	if s.validateAdminTOTP(codeAt(t, base.Add(60*time.Second))) {
		t.Fatal("+2 step code must be rejected")
	}
}

func TestValidateAdminTOTPWrongCode(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)
	if s.validateAdminTOTP("000000") {
		t.Fatal("wrong code must be rejected")
	}
}

func TestValidateAdminTOTPReplay(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := newTOTPService(testSecret, base)
	code := codeAt(t, base)
	if !s.validateAdminTOTP(code) {
		t.Fatal("first use should pass")
	}
	if s.validateAdminTOTP(code) {
		t.Fatal("replay of same code/step must be rejected")
	}
}

func TestValidateAdminTOTPSecret(t *testing.T) {
	if err := validateAdminTOTPSecret(""); err != nil {
		t.Fatalf("empty secret is allowed (2FA off): %v", err)
	}
	if err := validateAdminTOTPSecret(testSecret); err != nil {
		t.Fatalf("valid base32 secret should pass: %v", err)
	}
	if err := validateAdminTOTPSecret("not base32!!"); err == nil {
		t.Fatal("invalid base32 secret must error")
	}
}
```

- [ ] **Step 4: 运行测试,确认失败**

Run: `go test ./internal/account/ -run 'AdminTOTP|ValidateAdminTOTP' -v`
Expected: 编译失败 / undefined: `AdminTOTPEnabled`, `validateAdminTOTP`, `validateAdminTOTPSecret`。

- [ ] **Step 5: 写实现 `totp.go`**

```go
package account

import (
	"fmt"
	"time"

	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// totpOpts are the fixed TOTP parameters (Google Authenticator / 1Password
// compatible). Validation iterates steps manually for exact replay tracking,
// so per-call Skew stays 0 here.
var totpOpts = totp.ValidateOpts{
	Period:    30,
	Skew:      0,
	Digits:    otp.DigitsSix,
	Algorithm: otp.AlgorithmSHA1,
}

// AdminTOTPEnabled reports whether admin login requires a TOTP code: the
// dashboard must be enabled (password set) AND a secret configured.
func (s *Service) AdminTOTPEnabled() bool {
	return s.AdminEnabled() && s.cfg.AdminTOTPSecret != ""
}

// validateAdminTOTP checks a 6-digit code against the configured secret,
// allowing ±1 time-step of clock skew. It rejects replays: once a code from
// a given time-step succeeds, that step and any earlier one are permanently
// dead (monotonic adminTOTPLastStep).
func (s *Service) validateAdminTOTP(code string) bool {
	secret := s.cfg.AdminTOTPSecret
	if secret == "" || code == "" {
		return false
	}
	now := s.now()
	for delta := int64(-1); delta <= 1; delta++ {
		t := now.Add(time.Duration(delta) * 30 * time.Second)
		ok, err := totp.ValidateCustom(code, secret, t, totpOpts)
		if err != nil || !ok {
			continue
		}
		step := t.Unix() / 30
		s.adminTOTPMu.Lock()
		defer s.adminTOTPMu.Unlock()
		if step <= s.adminTOTPLastStep {
			return false // replay or stale step
		}
		s.adminTOTPLastStep = step
		return true
	}
	return false
}

// validateAdminTOTPSecret returns an error if secret is non-empty but not a
// usable base32 TOTP secret. Empty is valid and means 2FA is off.
func validateAdminTOTPSecret(secret string) error {
	if secret == "" {
		return nil
	}
	if _, err := totp.GenerateCode(secret, time.Unix(0, 0)); err != nil {
		return fmt.Errorf("invalid RELAYIUM_ADMIN_TOTP_SECRET (must be base32): %w", err)
	}
	return nil
}
```

- [ ] **Step 6: 运行测试,确认通过**

Run: `go test ./internal/account/ -run 'AdminTOTP|ValidateAdminTOTP' -v`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add server/go.mod server/go.sum server/internal/account/service.go server/internal/account/totp.go server/internal/account/totp_test.go
git commit -m "feat(admin): TOTP validation core with skew + replay guard"
```

---

### Task 2: 登录失败限流(纯逻辑,可单测)

**Files:**
- Create: `server/internal/account/throttle.go`
- Test: `server/internal/account/throttle_test.go`

**Interfaces:**
- Produces:
  - `const adminLoginMaxFails = 5`
  - `const adminLoginLockWindow = 15 * time.Minute`
  - `type loginThrottle struct { ... }`
  - `func newLoginThrottle() *loginThrottle`
  - `func (t *loginThrottle) locked(key string, now time.Time) bool`
  - `func (t *loginThrottle) recordFail(key string, now time.Time)`
  - `func (t *loginThrottle) reset(key string)`
  - `func clientIP(r *http.Request) string`

- [ ] **Step 1: 写失败测试 `throttle_test.go`**

```go
package account

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginThrottleLocksAfterThreshold(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < adminLoginMaxFails; i++ {
		if tr.locked("1.2.3.4", now) {
			t.Fatalf("should not be locked before threshold (i=%d)", i)
		}
		tr.recordFail("1.2.3.4", now)
	}
	if !tr.locked("1.2.3.4", now) {
		t.Fatal("should be locked after threshold reached")
	}
}

func TestLoginThrottleUnlocksAfterWindow(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < adminLoginMaxFails; i++ {
		tr.recordFail("1.2.3.4", now)
	}
	later := now.Add(adminLoginLockWindow + time.Second)
	if tr.locked("1.2.3.4", later) {
		t.Fatal("should unlock after lock window passes")
	}
}

func TestLoginThrottleResetOnSuccess(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < adminLoginMaxFails-1; i++ {
		tr.recordFail("1.2.3.4", now)
	}
	tr.reset("1.2.3.4")
	tr.recordFail("1.2.3.4", now) // one fail after reset
	if tr.locked("1.2.3.4", now) {
		t.Fatal("reset should clear prior failure count")
	}
}

func TestLoginThrottlePerKey(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < adminLoginMaxFails; i++ {
		tr.recordFail("1.1.1.1", now)
	}
	if tr.locked("2.2.2.2", now) {
		t.Fatal("different key must not be affected")
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("POST", "/admin/login", nil)
	r.RemoteAddr = "9.9.9.9:5555"
	if got := clientIP(r); got != "9.9.9.9" {
		t.Fatalf("RemoteAddr host: got %q", got)
	}
	r.Header.Set("X-Forwarded-For", "5.5.5.5, 9.9.9.9")
	if got := clientIP(r); got != "5.5.5.5" {
		t.Fatalf("XFF first entry: got %q", got)
	}
}
```

- [ ] **Step 2: 运行测试,确认失败**

Run: `go test ./internal/account/ -run 'LoginThrottle|ClientIP' -v`
Expected: 编译失败,undefined: `newLoginThrottle` 等。

- [ ] **Step 3: 写实现 `throttle.go`**

```go
package account

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	adminLoginMaxFails   = 5
	adminLoginLockWindow = 15 * time.Minute
)

type failEntry struct {
	count     int
	lockUntil time.Time
}

// loginThrottle is a per-key in-memory failed-login limiter. Process-scoped,
// like admin sessions — no persistence needed.
type loginThrottle struct {
	mu      sync.Mutex
	entries map[string]*failEntry
}

func newLoginThrottle() *loginThrottle {
	return &loginThrottle{entries: map[string]*failEntry{}}
}

// locked reports whether key is currently within a lockout window.
func (t *loginThrottle) locked(key string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.entries[key]
	if e == nil {
		return false
	}
	if !e.lockUntil.IsZero() && now.Before(e.lockUntil) {
		return true
	}
	// lock expired: forget the entry so counting restarts clean.
	if !e.lockUntil.IsZero() && !now.Before(e.lockUntil) {
		delete(t.entries, key)
	}
	return false
}

// recordFail increments the failure count for key and arms a lockout once the
// threshold is reached.
func (t *loginThrottle) recordFail(key string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.entries[key]
	if e == nil {
		e = &failEntry{}
		t.entries[key] = e
	}
	e.count++
	if e.count >= adminLoginMaxFails {
		e.lockUntil = now.Add(adminLoginLockWindow)
	}
}

// reset clears any failure state for key (call on successful login).
func (t *loginThrottle) reset(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, key)
}

// clientIP returns the client's IP: first X-Forwarded-For entry when a reverse
// proxy sets it, else RemoteAddr with the port stripped. Mirrors
// internal/signal.ClientIP — SAME DEPLOYMENT CONTRACT: the proxy MUST overwrite
// (not append) X-Forwarded-For, else an attacker can spoof the leading entry
// and dodge the per-IP admin-login limit.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
```

- [ ] **Step 4: 运行测试,确认通过**

Run: `go test ./internal/account/ -run 'LoginThrottle|ClientIP' -v`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add server/internal/account/throttle.go server/internal/account/throttle_test.go
git commit -m "feat(admin): in-memory per-IP failed-login throttle"
```

---

### Task 3: 接入 `handleAdminLogin` 与登录模板

**Files:**
- Modify: `server/internal/account/service.go`(Service 加 throttle 字段;NewService 初始化)
- Modify: `server/internal/account/admin.go`(模板 + `renderAdminLogin` + `handleAdminLogin`)
- Test: `server/internal/account/admin_test.go`(追加 httptest 用例)

**Interfaces:**
- Consumes: `AdminTOTPEnabled()`、`validateAdminTOTP()`(Task 1);`loginThrottle`、`clientIP()`(Task 2)
- Produces: `handleAdminLogin` 新行为(429 锁定 / 401 通用错误 / 成功签发 session)

- [ ] **Step 1: Service 加 throttle 字段并初始化**

在 `service.go` 的 `Service` 结构加:
```go
	adminTOTPLastStep int64
	adminLogins       *loginThrottle
```
在 `NewService` 的字面量里加初始化:
```go
	svc := &Service{store: store, mailer: mailer, cfg: cfg, now: time.Now,
		adminSessions: map[string]int64{}, adminLogins: newLoginThrottle()}
```

- [ ] **Step 2: 写失败测试(追加到 `admin_test.go`)**

```go
func TestAdminLoginTOTP(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminPassword: "pw", AdminTOTPSecret: testSecret})
	s.now = func() time.Time { return base }

	post := func(user, pass, code string) *httptest.ResponseRecorder {
		form := url.Values{"username": {user}, "password": {pass}, "totp": {code}}
		r := httptest.NewRequest("POST", "/admin/login", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.RemoteAddr = "7.7.7.7:1111"
		w := httptest.NewRecorder()
		s.handleAdminLogin(w, r)
		return w
	}

	// good creds + good code -> 302 redirect with cookie
	w := post("admin", "pw", codeAt(t, base))
	if w.Code != http.StatusFound {
		t.Fatalf("valid login: want 302, got %d", w.Code)
	}
	if len(w.Result().Cookies()) == 0 {
		t.Fatal("valid login should set admin cookie")
	}

	// good creds + wrong code -> 401
	if w := post("admin", "pw", "000000"); w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong code: want 401, got %d", w.Code)
	}
}

func TestAdminLoginLockout(t *testing.T) {
	base := time.Unix(1_700_000_000, 0)
	s := NewService(nil, nil, Config{AdminUser: "admin", AdminPassword: "pw"})
	s.now = func() time.Time { return base }

	fail := func() *httptest.ResponseRecorder {
		form := url.Values{"username": {"admin"}, "password": {"wrong"}}
		r := httptest.NewRequest("POST", "/admin/login", strings.NewReader(form.Encode()))
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		r.RemoteAddr = "8.8.8.8:2222"
		w := httptest.NewRecorder()
		s.handleAdminLogin(w, r)
		return w
	}
	for i := 0; i < adminLoginMaxFails; i++ {
		if w := fail(); w.Code != http.StatusUnauthorized {
			t.Fatalf("fail %d: want 401, got %d", i, w.Code)
		}
	}
	if w := fail(); w.Code != http.StatusTooManyRequests {
		t.Fatalf("after threshold: want 429, got %d", w.Code)
	}
}
```

Make sure `admin_test.go` imports: `net/http`, `net/http/httptest`, `net/url`, `strings`, `time`.

- [ ] **Step 3: 运行测试,确认失败**

Run: `go test ./internal/account/ -run 'AdminLogin' -v`
Expected: FAIL —— 当前 `handleAdminLogin` 不校验 TOTP、不限流(错误码不符 / lockout 用例得不到 429)。

- [ ] **Step 4: 改 `renderAdminLogin` 与登录模板(admin.go)**

把登录模板数据从 `map[string]string` 改为结构体,并在启用 2FA 时渲染验证码框。替换 `renderAdminLogin` 与 `adminLoginTmpl`:

```go
type adminLoginData struct {
	Error string
	TOTP  bool // render the 6-digit code field
}

func (s *Service) renderAdminLogin(w http.ResponseWriter, errMsg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = adminLoginTmpl.Execute(w, adminLoginData{Error: errMsg, TOTP: s.AdminTOTPEnabled()})
}

var adminLoginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html><head><meta charset="utf-8"><title>Relayium Admin</title>
<style>body{font:15px system-ui;max-width:360px;margin:80px auto;padding:0 16px}
input,button{font:inherit;padding:8px 10px;width:100%;box-sizing:border-box;margin:6px 0}
.err{color:#c00}</style></head>
<body><h1>Relayium 后台</h1>
{{if .Error}}<p class="err">{{.Error}}</p>{{end}}
<form method="post" action="/admin/login">
<input type="text" name="username" placeholder="管理员账号" autofocus autocomplete="username">
<input type="password" name="password" placeholder="管理员密码" autocomplete="current-password">
{{if .TOTP}}<input type="text" name="totp" placeholder="6 位验证码" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6">{{end}}
<button type="submit">登录</button>
</form></body></html>`))
```

注意:`renderAdminLogin` 现在是 `Service` 的方法。更新它的两处调用(`handleAdminLogin` 里失败分支、`handleAdminHome` 里未登录分支)为 `s.renderAdminLogin(w, ...)`。

- [ ] **Step 5: 改 `handleAdminLogin`(admin.go)**

替换整个函数体:
```go
func (s *Service) handleAdminLogin(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.adminLogins.locked(ip, s.now()) {
		w.WriteHeader(http.StatusTooManyRequests)
		s.renderAdminLogin(w, "尝试过于频繁，请稍后再试")
		return
	}

	user := r.FormValue("username")
	pass := r.FormValue("password")
	// Compare both fields in constant time and combine without short-circuit,
	// so neither a wrong username nor a wrong password is distinguishable by timing.
	userOK := subtle.ConstantTimeCompare([]byte(user), []byte(s.adminUser()))
	passOK := subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.AdminPassword))
	credsOK := userOK&passOK == 1
	totpOK := !s.AdminTOTPEnabled() || s.validateAdminTOTP(r.FormValue("totp"))

	if !credsOK || !totpOK {
		s.adminLogins.recordFail(ip, s.now())
		w.WriteHeader(http.StatusUnauthorized)
		s.renderAdminLogin(w, "账号、密码或验证码错误")
		return
	}

	s.adminLogins.reset(ip)
	tok := s.newAdminSession()
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(adminSessionTTL / time.Second),
	})
	http.Redirect(w, r, "/admin", http.StatusFound)
}
```

> 说明:`totpOK` 在 2FA 未启用时恒为 true;`validateAdminTOTP` 只在启用时对空/错码返回 false。即便账号密码先错,也照常调用 `validateAdminTOTP` 消费一次(无副作用,验证码错时不推进 `adminTOTPLastStep`),保持"任一因素错回同一句"。

- [ ] **Step 6: 更新旧的 `renderAdminLogin` 自由函数调用**

删除原来的包级 `func renderAdminLogin(w, errMsg)`(已被方法取代)。`handleAdminHome`(`admin.go:117`)里 `renderAdminLogin(w, "")` 改为 `s.renderAdminLogin(w, "")`。

- [ ] **Step 7: 运行测试,确认通过**

Run: `go test ./internal/account/ -run 'AdminLogin' -v && go build ./...`
Expected: PASS 且整包编译通过。

- [ ] **Step 8: 提交**

```bash
git add server/internal/account/service.go server/internal/account/admin.go server/internal/account/admin_test.go
git commit -m "feat(admin): enforce TOTP + rate limit in login handler"
```

---

### Task 4: CLI 生成器 + 配置接线 + 启动期校验

**Files:**
- Modify: `server/main.go`

**Interfaces:**
- Consumes: `validateAdminTOTPSecret()`(Task 1);`account.Config.AdminTOTPSecret`(Task 1)

- [ ] **Step 1: 加 flag**

在 `main.go` 的 flag 区(`adminPass` 定义之后,约第 64 行)加:
```go
	adminTOTPSecret := flag.String("admin-totp-secret", envStr("RELAYIUM_ADMIN_TOTP_SECRET", ""), "base32 TOTP secret for admin 2FA (empty disables 2FA)")
	genAdminTOTP := flag.Bool("gen-admin-totp", false, "generate a new admin TOTP secret + QR and exit")
```

- [ ] **Step 2: 生成器分支(flag.Parse 之后第一时间)**

在 `flag.Parse()`(第 70 行)之后、`mime.AddExtensionType` 之前插入:
```go
	if *genAdminTOTP {
		if err := generateAdminTOTP(*adminUser); err != nil {
			log.Fatalf("generate admin TOTP: %v", err)
		}
		return
	}
```
并在 `main.go` 末尾(或紧邻 main 之下)新增函数:
```go
func generateAdminTOTP(adminUser string) error {
	if adminUser == "" {
		adminUser = "admin"
	}
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      "Relayium",
		AccountName: adminUser,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return err
	}
	fmt.Println("扫描下面的二维码，或手动输入密钥到你的验证器 App：")
	fmt.Println()
	qrterminal.GenerateHalfBlock(key.URL(), qrterminal.L, os.Stdout)
	fmt.Println()
	fmt.Println("Secret (base32):", key.Secret())
	fmt.Println("otpauth URL:    ", key.URL())
	fmt.Println()
	fmt.Println("把 Secret 填入 RELAYIUM_ADMIN_TOTP_SECRET 后重启服务即可启用 2FA。")
	return nil
}
```
在 `main.go` 顶部 import 加:`"fmt"`、`"os"`、`"github.com/pquerna/otp"`、`"github.com/pquerna/otp/totp"`、`"github.com/mdp/qrterminal/v3"`。

- [ ] **Step 3: 把密钥接入 Config + 启动期校验**

找到 `main.go` 里构造 `account.Config{...}` 的位置(约第 150-151 行,含 `AdminUser`/`AdminPassword`),在其中加一行:
```go
		AdminPassword:   *adminPass,
		AdminTOTPSecret: *adminTOTPSecret,
```
在构造 `Service` / 调用 `RegisterAdmin` 之前(约第 188 行附近)加启动期校验:
```go
	if err := account.ValidateAdminTOTPSecret(*adminTOTPSecret); err != nil {
		log.Fatalf("%v", err)
	}
	if *adminTOTPSecret != "" && *adminPass == "" {
		log.Printf("WARNING: RELAYIUM_ADMIN_TOTP_SECRET set but admin password empty; /admin disabled, 2FA ignored")
	}
```

> 注:`validateAdminTOTPSecret`(Task 1)是包内私有;为供 main 调用,在 `totp.go` 里额外导出一个薄封装:
> ```go
> // ValidateAdminTOTPSecret is the exported startup-check wrapper.
> func ValidateAdminTOTPSecret(secret string) error { return validateAdminTOTPSecret(secret) }
> ```
> (加到 Task 1 的 totp.go;若已在执行 Task 1 时一并加上则跳过。)

- [ ] **Step 4: 编译并手动验证生成器**

Run:
```bash
cd server && go build ./... && go run . -gen-admin-totp
```
Expected: 终端打印二维码 + `Secret (base32): ...` + otpauth URL,然后进程退出(不监听端口)。

- [ ] **Step 5: 手动验证启动校验**

Run:
```bash
RELAYIUM_ADMIN_PASS=x RELAYIUM_ADMIN_TOTP_SECRET='bad!!!' go run . -addr :0
```
Expected: 立刻 `log.Fatal` 报 "invalid RELAYIUM_ADMIN_TOTP_SECRET"。

- [ ] **Step 6: 提交**

```bash
git add server/main.go server/internal/account/totp.go
git commit -m "feat(admin): -gen-admin-totp generator + startup secret validation"
```

---

### Task 5: 文档(含面向部署者的 2FA 操作文档)

**Files:**
- Modify: `server/.env.example`
- Modify: `README.md` 和/或 `SECURITY.md`
- Create: `docs/admin-2fa.md`

- [ ] **Step 1: `.env.example` 加条目**

在 admin 配置段(现有 `RELAYIUM_ADMIN_USER`/`RELAYIUM_ADMIN_PASS`,约第 12-16 行)之后加:
```bash
# 管理员双因素认证(TOTP)。留空 = 关闭,仅账号+密码登录。
# 生成密钥:在 server/ 下运行  go run . -gen-admin-totp  ,扫码后把 base32 密钥填在这里并重启。
RELAYIUM_ADMIN_TOTP_SECRET=
```

- [ ] **Step 2: 写 `docs/admin-2fa.md`(操作文档)**

面向自托管部署者,覆盖:概述与启用模型(留空=关闭)、生成步骤(`go run . -gen-admin-totp` / 编译后 `./relayium -gen-admin-totp`)、扫码与填 env、重启、登录时输入验证码、参数说明(SHA1/6/30、±1 步容差)、限流行为(5 次失败锁 15 分钟)、丢手机/换设备如何恢复(重跑生成器换新密钥,或用旧密钥重扫)、如何临时关闭(注释掉变量重启)、安全提示(密钥等同第二凭据,勿进版本库;反代必须 overwrite X-Forwarded-For)。

- [ ] **Step 3: README/SECURITY 补一句指引**

在 README 的部署/配置段或 SECURITY.md 加一行,指向 `docs/admin-2fa.md`。

- [ ] **Step 4: 提交**

```bash
git add server/.env.example docs/admin-2fa.md README.md SECURITY.md
git commit -m "docs(admin): 2FA setup guide + env example"
```

---

## 完成后的整体验证

- [ ] `cd server && go test ./... && go vet ./...` 全绿。
- [ ] `go run . -gen-admin-totp` 能出二维码;用验证器扫码后,把密钥填入 env,`RELAYIUM_ADMIN_PASS=… RELAYIUM_ADMIN_TOTP_SECRET=…` 启动,浏览器 `/admin` 登录需要验证码,正确码可进、错码 401、连续错 5 次后 429。
- [ ] 不设 `RELAYIUM_ADMIN_TOTP_SECRET` 时,`/admin` 登录与改动前完全一致(回归)。

## Self-Review 记录

- **Spec 覆盖**:启用模型(T1+T4)、TOTP 参数/校验/防重放(T1)、生成器(T4)、单页验证码登录+通用错误(T3)、限流(T2+T3)、启动校验(T1+T4)、测试(T1/T2/T3 + 手动)、文档含操作文档(T5)——逐条有对应任务。
- **占位符**:无 TBD;每个代码步给出完整 Go 代码与确切命令/预期。
- **类型一致性**:`validateAdminTOTP`/`AdminTOTPEnabled`/`validateAdminTOTPSecret`(+导出封装 `ValidateAdminTOTPSecret`)、`loginThrottle` 方法签名、`clientIP`、`adminLoginData` 在定义与调用处一致。`totpOpts` 供校验;测试用 `totp.GenerateCodeCustom` 造码,参数与 `totpOpts` 对齐。
