# 设置 / 修改密码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让登录用户在账号菜单设置（无密码用户）或修改（已有密码用户）登录密码，改密后登出其他会话。

**Architecture:** 后端新增 `Service.ChangePassword`（GetCredentials 判断有无密码 → 有则校验旧密码、无则首次设置并 LinkIdentity → 写新哈希 → 撤销其他会话）+ 两个存储方法（`HasPassword`、`RevokeUserSessions`）+ 鉴权端点 `POST /api/auth/password/change`，`/api/me` 增加 `hasPassword`。前端 `auth.svelte` 加 `changePassword` 与 `hasPassword`，`Account.svelte` 加自适应表单。

**Tech Stack:** Go `net/http` + `golang.org/x/crypto/bcrypt` + modernc.org/sqlite；Svelte 5 runes + TypeScript；Vitest。

## Global Constraints

- 密码最短长度 `minPasswordLen = 8`（已存在，复用，勿改）。
- 无密码用户（Google/魔法）首次设密：跳过旧密码校验，并 `LinkIdentity("password", normEmail(u.Email), u.ID)`。
- 改密成功后撤销该用户除当前 session 外的所有会话（`sessions.revoked = 1`，与现有 `RevokeSession` 一致，用 UPDATE 不用 DELETE）。
- 错误映射：旧密码错 → `ErrBadCredentials` → HTTP 401 `{"error":"current password incorrect"}`；新密码太短 → `ErrWeakPassword` → HTTP 400 `{"error":"password too short"}`。
- 端点走 `RequireSession`（已登录）；当前 session id 从 cookie `sessionCookie`（= "relayium_session"）读取。
- 新 i18n 文案覆盖全部 6 语言（zh/en/ja/ko/de/fr）；每个语言对象 `: Messages`，缺键由 `svelte-check` 报错兜底。
- 提交信息结尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- 验证：`cd server && go test ./...`；`cd web && npm run check && npm test && npm run build`。

## File Structure

- `server/internal/account/store.go`（改）：`Store` 接口加 `HasPassword`、`RevokeUserSessions`。
- `server/internal/account/sqlite.go`（改）：两方法的 SQLite 实现。
- `server/internal/account/sqlite_test.go`（改）：两方法单测。
- `server/internal/account/password.go`（改）：`Service.ChangePassword`。
- `server/internal/account/password_test.go`（改）：ChangePassword 单测。
- `server/internal/account/handlers.go`（改）：注册 `POST /api/auth/password/change` + `handleChangePassword`；`handleMe` 加 `hasPassword`。
- `server/internal/account/handlers_test.go`（改）：端点 httptest。
- `web/src/lib/auth.svelte.ts`（改）：`SessionUser.hasPassword` + `changePassword`。
- `web/src/lib/auth.test.ts`（改）：`changePassword` 测试。
- `web/src/lib/i18n.svelte.ts`（改）：`account` 段新键（6 语言）。
- `web/src/lib/i18n.test.ts`（改）：新键完整性断言。
- `web/src/lib/Account.svelte`（改）：改密表单。

执行顺序：1 → 2 → 3 → 4 → 5 → 6。

---

### Task 1: 存储方法 HasPassword + RevokeUserSessions

**Files:**
- Modify: `server/internal/account/store.go`（`Store` 接口）
- Modify: `server/internal/account/sqlite.go`
- Test: `server/internal/account/sqlite_test.go`

**Interfaces:**
- Produces:
  - `HasPassword(ctx context.Context, userID string) (bool, error)` —— 用户 `users.password_hash` 非空则 true。
  - `RevokeUserSessions(ctx context.Context, userID, exceptID string) error` —— 撤销该用户除 `exceptID` 外的全部会话。

- [ ] **Step 1: Write the failing test (append to sqlite_test.go)**

```go
func TestHasPassword(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, err := s.UpsertUserByEmail(ctx, "p@example.com", "P")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if has, err := s.HasPassword(ctx, u.ID); err != nil || has {
		t.Fatalf("fresh user: has=%v err=%v, want false", has, err)
	}
	if err := s.SetPassword(ctx, u.ID, "somehash"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if has, err := s.HasPassword(ctx, u.ID); err != nil || !has {
		t.Fatalf("after SetPassword: has=%v err=%v, want true", has, err)
	}
	if has, err := s.HasPassword(ctx, "no-such-user"); err != nil || has {
		t.Fatalf("unknown user: has=%v err=%v, want false", has, err)
	}
}

func TestRevokeUserSessions(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "s@example.com", "S")
	keep := Session{ID: "keep", UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40}
	drop := Session{ID: "drop", UserID: u.ID, CreatedAt: 1, ExpiresAt: 1 << 40}
	other, _ := s.UpsertUserByEmail(ctx, "o@example.com", "O")
	otherSess := Session{ID: "other", UserID: other.ID, CreatedAt: 1, ExpiresAt: 1 << 40}
	for _, ss := range []Session{keep, drop, otherSess} {
		if err := s.CreateSession(ctx, ss); err != nil {
			t.Fatalf("create %s: %v", ss.ID, err)
		}
	}
	if err := s.RevokeUserSessions(ctx, u.ID, "keep"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, ok, _ := s.GetSession(ctx, "keep"); !ok {
		t.Fatal("current session must survive")
	}
	if _, ok, _ := s.GetSession(ctx, "drop"); ok {
		t.Fatal("other session of same user must be revoked")
	}
	if _, ok, _ := s.GetSession(ctx, "other"); !ok {
		t.Fatal("another user's session must be untouched")
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run 'TestHasPassword|TestRevokeUserSessions' -v`
Expected: FAIL — `s.HasPassword` / `s.RevokeUserSessions` undefined.

- [ ] **Step 3: Add to the `Store` interface (store.go)**

In `server/internal/account/store.go`, in the `Store` interface under the `// users + identities` group (next to `GetCredentials`), add:

```go
	HasPassword(ctx context.Context, userID string) (bool, error)
```

and under the `// sessions` group (next to `RevokeSession`), add:

```go
	RevokeUserSessions(ctx context.Context, userID, exceptID string) error
```

- [ ] **Step 4: Implement in sqlite.go**

Add after `SetPassword` (around line 327) and after `RevokeSession` respectively (placement is cosmetic; both can go near their kin):

```go
// HasPassword reports whether the user has a usable password hash set.
func (s *SQLiteStore) HasPassword(ctx context.Context, userID string) (bool, error) {
	var hash sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT password_hash FROM users WHERE id = ?`, userID).Scan(&hash)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return hash.Valid && hash.String != "", nil
}

// RevokeUserSessions revokes every session of userID except exceptID.
func (s *SQLiteStore) RevokeUserSessions(ctx context.Context, userID, exceptID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id <> ?`, userID, exceptID)
	return err
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -run 'TestHasPassword|TestRevokeUserSessions' -v`
Expected: PASS (2 tests).

- [ ] **Step 6: Full package test (interface satisfied)**

Run: `cd server && go build ./... && go test ./internal/account/`
Expected: build clean (SQLiteStore satisfies the extended interface), all account tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go
git commit -m "feat(account): HasPassword + RevokeUserSessions store methods

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Service.ChangePassword

**Files:**
- Modify: `server/internal/account/password.go`
- Test: `server/internal/account/password_test.go`

**Interfaces:**
- Consumes: `store.GetCredentials`, `store.SetPassword`, `store.LinkIdentity`, `store.RevokeUserSessions` (Task 1), `minPasswordLen`, `ErrBadCredentials`, `ErrWeakPassword`, `normEmail`.
- Produces:
  - `func (s *Service) ChangePassword(ctx context.Context, u User, currentSessionID, currentPassword, newPassword string) error`
    - 已有密码 → `currentPassword` 必须 bcrypt 校验通过，否则 `ErrBadCredentials`。
    - 无密码 → 跳过旧密码校验，并 `LinkIdentity("password", normEmail(u.Email), u.ID)`。
    - `len(newPassword) < minPasswordLen` → `ErrWeakPassword`。
    - 成功后 `RevokeUserSessions(u.ID, currentSessionID)`。

- [ ] **Step 1: Write the failing test (append to password_test.go)**

```go
func TestChangePasswordExistingUser(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()
	sess, err := svc.Register(ctx, "c@example.com", "oldpassword1", "C")
	if err != nil {
		t.Fatalf("register: %v", err)
	}
	u, _, _ := svc.ValidateSession(ctx, sess.ID)

	// 旧密码错 => ErrBadCredentials。
	if err := svc.ChangePassword(ctx, u, sess.ID, "wrongold12", "newpassword1"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("wrong current: want ErrBadCredentials, got %v", err)
	}
	// 新密码太短 => ErrWeakPassword。
	if err := svc.ChangePassword(ctx, u, sess.ID, "oldpassword1", "short"); !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("weak new: want ErrWeakPassword, got %v", err)
	}
	// 正确旧密码 => 成功；新密码可登录、旧密码失效。
	if err := svc.ChangePassword(ctx, u, sess.ID, "oldpassword1", "newpassword1"); err != nil {
		t.Fatalf("change: %v", err)
	}
	if _, err := svc.Login(ctx, "c@example.com", "newpassword1"); err != nil {
		t.Fatalf("login with new password: %v", err)
	}
	if _, err := svc.Login(ctx, "c@example.com", "oldpassword1"); !errors.Is(err, ErrBadCredentials) {
		t.Fatalf("old password should fail: got %v", err)
	}
}

func TestChangePasswordSetsForPasswordlessUser(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()
	// 模拟 Google/魔法用户：有账号、无密码。
	u, err := svc.store.UpsertUserByEmail(ctx, "g@example.com", "G")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// currentPassword 被忽略；首次设密成功。
	if err := svc.ChangePassword(ctx, u, "no-session", "", "freshpass12"); err != nil {
		t.Fatalf("set: %v", err)
	}
	if _, err := svc.Login(ctx, "g@example.com", "freshpass12"); err != nil {
		t.Fatalf("login after set: %v", err)
	}
}

func TestChangePasswordRevokesOtherSessions(t *testing.T) {
	svc := newPwService(t)
	ctx := context.Background()
	sess, _ := svc.Register(ctx, "r@example.com", "oldpassword1", "R")
	u, _, _ := svc.ValidateSession(ctx, sess.ID)
	// 第二个会话（另一台设备）。
	other, err := svc.IssueSession(ctx, u.ID)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if err := svc.ChangePassword(ctx, u, sess.ID, "oldpassword1", "newpassword1"); err != nil {
		t.Fatalf("change: %v", err)
	}
	if _, ok, _ := svc.ValidateSession(ctx, sess.ID); !ok {
		t.Fatal("current session must survive")
	}
	if _, ok, _ := svc.ValidateSession(ctx, other.ID); ok {
		t.Fatal("other session must be revoked")
	}
}
```

Note: `svc.store` is the unexported field holding the `Store`; these tests are in package `account` so they can reach it (mirrors how the codebase tests internals).

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestChangePassword -v`
Expected: FAIL — `svc.ChangePassword` undefined.

- [ ] **Step 3: Implement ChangePassword (append to password.go)**

```go
// ChangePassword sets or changes the authenticated user's password, then revokes
// the user's other sessions. For a user who already has a password, currentPassword
// must verify; for a passwordless user (Google/magic) it is a first-time set that
// also links a "password" identity so they can subsequently log in by email+password.
func (s *Service) ChangePassword(ctx context.Context, u User, currentSessionID, currentPassword, newPassword string) error {
	_, hash, hasPass, err := s.store.GetCredentials(ctx, u.Email)
	if err != nil {
		return err
	}
	if hasPass {
		if bcrypt.CompareHashAndPassword([]byte(hash), []byte(currentPassword)) != nil {
			return ErrBadCredentials
		}
	}
	if len(newPassword) < minPasswordLen {
		return ErrWeakPassword
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	if err := s.store.SetPassword(ctx, u.ID, string(newHash)); err != nil {
		return err
	}
	if !hasPass {
		if err := s.store.LinkIdentity(ctx, "password", normEmail(u.Email), u.ID); err != nil {
			return err
		}
	}
	return s.store.RevokeUserSessions(ctx, u.ID, currentSessionID)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestChangePassword -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/password.go server/internal/account/password_test.go
git commit -m "feat(account): Service.ChangePassword (set/change + revoke other sessions)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: 端点 POST /api/auth/password/change + /api/me hasPassword

**Files:**
- Modify: `server/internal/account/handlers.go`
- Test: `server/internal/account/handlers_test.go`

**Interfaces:**
- Consumes: `Service.ChangePassword` (Task 2), `store.HasPassword` (Task 1), `RequireSession`, `sessionCookie`, `writeJSON`, `ErrBadCredentials`, `ErrWeakPassword`.
- Produces:
  - Route `POST /api/auth/password/change` (RequireSession) → `handleChangePassword`.
  - `/api/me` user object gains `"hasPassword": bool`.

- [ ] **Step 1: Write the failing test (append to handlers_test.go)**

```go
func TestChangePasswordEndpoint(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{
		BaseURL: "http://example.test", SessionTTL: time.Hour,
	})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	// 注册取得 session cookie。
	resp, _ := client.Post(ts.URL+"/api/auth/register", "application/json",
		strings.NewReader(`{"email":"e@example.com","password":"oldpassword1"}`))
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
		t.Fatal("no session cookie")
	}

	do := func(body string) int {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/auth/password/change", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(cookie)
		r, err := client.Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		return r.StatusCode
	}

	// /api/me 报告 hasPassword=true。
	meReq, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/me", nil)
	meReq.AddCookie(cookie)
	meResp, _ := client.Do(meReq)
	var me struct {
		User struct {
			HasPassword bool `json:"hasPassword"`
		} `json:"user"`
	}
	_ = json.NewDecoder(meResp.Body).Decode(&me)
	if !me.User.HasPassword {
		t.Fatal("me.hasPassword: want true for a password user")
	}

	// 旧密码错 => 401。
	if got := do(`{"currentPassword":"wrongold12","newPassword":"newpassword1"}`); got != http.StatusUnauthorized {
		t.Fatalf("wrong current: want 401, got %d", got)
	}
	// 新密码太短 => 400。
	if got := do(`{"currentPassword":"oldpassword1","newPassword":"short"}`); got != http.StatusBadRequest {
		t.Fatalf("weak new: want 400, got %d", got)
	}
	// 正确 => 200。
	if got := do(`{"currentPassword":"oldpassword1","newPassword":"newpassword1"}`); got != http.StatusOK {
		t.Fatalf("change: want 200, got %d", got)
	}
	// 未登录 => 401。
	noauth, _ := client.Post(ts.URL+"/api/auth/password/change", "application/json",
		strings.NewReader(`{"newPassword":"whatever12"}`))
	if noauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth: want 401, got %d", noauth.StatusCode)
	}
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestChangePasswordEndpoint -v`
Expected: FAIL — route 404 / `handleChangePassword` undefined / `hasPassword` absent.

- [ ] **Step 3: Register the route (handlers.go `Routes()`)**

In `Routes()`, after the `POST /api/auth/password/login` line (line 23), add:

```go
	mux.HandleFunc("POST /api/auth/password/change", s.RequireSession(s.handleChangePassword))
```

- [ ] **Step 4: Add the handler (handlers.go)**

Add near the other auth handlers:

```go
func (s *Service) handleChangePassword(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	currentSessionID := ""
	if c, err := r.Cookie(sessionCookie); err == nil {
		currentSessionID = c.Value
	}
	err := s.ChangePassword(r.Context(), u, currentSessionID, in.CurrentPassword, in.NewPassword)
	switch {
	case errors.Is(err, ErrBadCredentials):
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "current password incorrect"})
	case errors.Is(err, ErrWeakPassword):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password too short"})
	case err != nil:
		http.Error(w, "server error", http.StatusInternalServerError)
	default:
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	}
}
```

(`errors` is already imported in handlers.go.)

- [ ] **Step 5: Add hasPassword to handleMe (handlers.go)**

Replace the existing `handleMe`:

```go
func (s *Service) handleMe(w http.ResponseWriter, r *http.Request, u User) {
	hasPass, err := s.store.HasPassword(r.Context(), u.ID)
	if err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id": u.ID, "email": u.Email, "displayName": u.DisplayName, "hasPassword": hasPass,
		},
	})
}
```

- [ ] **Step 6: Run to verify it passes + full package**

Run: `cd server && go build ./... && go vet ./... && go test ./...`
Expected: build/vet clean; `TestChangePasswordEndpoint` and all packages PASS.

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/handlers.go server/internal/account/handlers_test.go
git commit -m "feat(account): POST /api/auth/password/change + hasPassword in /api/me

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: auth.svelte — hasPassword + changePassword

**Files:**
- Modify: `web/src/lib/auth.svelte.ts`
- Test: `web/src/lib/auth.test.ts`

**Interfaces:**
- Produces:
  - `SessionUser` gains `hasPassword: boolean`.
  - `changePassword(currentPassword, newPassword): Promise<{ ok: boolean; error?: string }>` — POST `/api/auth/password/change`; on success flips the local `user.hasPassword` to true.

- [ ] **Step 1: Write the failing test (append to auth.test.ts)**

```ts
import { changePassword } from "./auth.svelte";

describe("changePassword", () => {
  it("returns ok on 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ status: "ok" }),
    })) as unknown as typeof fetch);
    const res = await changePassword("old", "newpassword1");
    expect(res.ok).toBe(true);
  });

  it("maps the server error on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({ error: "current password incorrect" }),
    })) as unknown as typeof fetch);
    const res = await changePassword("bad", "newpassword1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("current password incorrect");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/lib/auth.test.ts`
Expected: FAIL — `changePassword` not exported.

- [ ] **Step 3: Add hasPassword to the type (auth.svelte.ts)**

```ts
export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  hasPassword: boolean;
}
```

- [ ] **Step 4: Add changePassword (auth.svelte.ts)**

Add after `passwordLogin`:

```ts
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/auth/password/change", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (res.ok) {
    if (user) user = { ...user, hasPassword: true };
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
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd web && npx vitest run src/lib/auth.test.ts && npm run check`
Expected: auth tests PASS; `npm run check` 0 errors (the existing `/api/me` stub in auth.test.ts omits `hasPassword`, but it is cast `as unknown as typeof fetch`, so it does not type-check against `SessionUser` — no error).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/auth.svelte.ts web/src/lib/auth.test.ts
git commit -m "feat(web): changePassword + hasPassword on SessionUser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: i18n — account 改密文案（6 语言）

**Files:**
- Modify: `web/src/lib/i18n.svelte.ts`
- Test: `web/src/lib/i18n.test.ts`

**Interfaces:**
- Produces: `Messages["account"]` gains `changePassword`, `setPassword`, `currentPassword`, `newPassword`, `confirmPassword`, `pwChanged`, `errCurrentWrong`, `errMismatch` (all `string`). Used by Task 6.

- [ ] **Step 1: Add the keys to the `Messages` interface**

In the `account: { … }` block of `interface Messages`, after `errLogin: string;`, add:

```ts
    changePassword: string;
    setPassword: string;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    pwChanged: string;
    errCurrentWrong: string;
    errMismatch: string;
```

- [ ] **Step 2: Add the 8 keys to all 6 language `account` blocks (verbatim)**

Each language object is typed `: Messages`, so `npm run check` fails until all six have these keys. Append to each language's `account` block:

**zh:**
```ts
    changePassword: "修改密码",
    setPassword: "设置密码",
    currentPassword: "当前密码",
    newPassword: "新密码",
    confirmPassword: "确认新密码",
    pwChanged: "密码已更新，其他设备已登出。",
    errCurrentWrong: "当前密码不正确。",
    errMismatch: "两次输入的新密码不一致。",
```

**en:**
```ts
    changePassword: "Change password",
    setPassword: "Set a password",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    pwChanged: "Password updated. Other devices have been signed out.",
    errCurrentWrong: "Current password is incorrect.",
    errMismatch: "The new passwords do not match.",
```

**ja:**
```ts
    changePassword: "パスワードを変更",
    setPassword: "パスワードを設定",
    currentPassword: "現在のパスワード",
    newPassword: "新しいパスワード",
    confirmPassword: "新しいパスワード（確認）",
    pwChanged: "パスワードを更新しました。他の端末はログアウトされました。",
    errCurrentWrong: "現在のパスワードが正しくありません。",
    errMismatch: "新しいパスワードが一致しません。",
```

**ko:**
```ts
    changePassword: "비밀번호 변경",
    setPassword: "비밀번호 설정",
    currentPassword: "현재 비밀번호",
    newPassword: "새 비밀번호",
    confirmPassword: "새 비밀번호 확인",
    pwChanged: "비밀번호가 변경되었습니다. 다른 기기는 로그아웃되었습니다.",
    errCurrentWrong: "현재 비밀번호가 올바르지 않습니다.",
    errMismatch: "새 비밀번호가 일치하지 않습니다.",
```

**de:**
```ts
    changePassword: "Passwort ändern",
    setPassword: "Passwort festlegen",
    currentPassword: "Aktuelles Passwort",
    newPassword: "Neues Passwort",
    confirmPassword: "Neues Passwort bestätigen",
    pwChanged: "Passwort aktualisiert. Andere Geräte wurden abgemeldet.",
    errCurrentWrong: "Aktuelles Passwort ist falsch.",
    errMismatch: "Die neuen Passwörter stimmen nicht überein.",
```

**fr:**
```ts
    changePassword: "Changer le mot de passe",
    setPassword: "Définir un mot de passe",
    currentPassword: "Mot de passe actuel",
    newPassword: "Nouveau mot de passe",
    confirmPassword: "Confirmer le nouveau mot de passe",
    pwChanged: "Mot de passe mis à jour. Les autres appareils ont été déconnectés.",
    errCurrentWrong: "Le mot de passe actuel est incorrect.",
    errMismatch: "Les nouveaux mots de passe ne correspondent pas.",
```

- [ ] **Step 3: Add a completeness assertion (i18n.test.ts)**

Append inside the existing `describe("i18n completeness", …)`:

```ts
  it("every language has the change-password strings", () => {
    for (const { code } of LANGS) {
      const m = messages[code];
      expect(m.account.changePassword, `${code}.account.changePassword`).toBeTruthy();
      expect(m.account.confirmPassword, `${code}.account.confirmPassword`).toBeTruthy();
      expect(m.account.errCurrentWrong, `${code}.account.errCurrentWrong`).toBeTruthy();
    }
  });
```

- [ ] **Step 4: Type-check and test**

Run: `cd web && npm run check && npx vitest run src/lib/i18n.test.ts`
Expected: check 0 errors (all 6 langs satisfy `Messages`), i18n tests PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/i18n.svelte.ts web/src/lib/i18n.test.ts
git commit -m "feat(web): i18n change-password strings across all 6 languages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Account.svelte — 改密表单

**Files:**
- Modify: `web/src/lib/Account.svelte`

**Interfaces:**
- Consumes: `changePassword`, `session` (with `hasPassword`) from `auth.svelte` (Task 4); `t.account.*` keys (Task 5).

- [ ] **Step 1: Add the form to the logged-in menu**

In `Account.svelte`, import `changePassword`:

```ts
  import {
    session, refreshSession, logout, localDeviceId,
    googleLoginUrl, requestMagicLink,
    register, passwordLogin, fetchAuthMethods, changePassword, type AuthMethods,
  } from "./auth.svelte";
```

Add state below the existing `let magicSent`:

```ts
  // 改密表单
  let pwOpen = $state(false);
  let curPw = $state("");
  let newPw = $state("");
  let confirmPw = $state("");
  let pwError = $state("");
  let pwDone = $state(false);

  function mapPwError(code?: string): string {
    if (code === "current password incorrect") return t.account.errCurrentWrong;
    if (code === "password too short") return t.account.errTooShort;
    return t.account.errLogin;
  }

  async function onChangePassword() {
    pwError = "";
    pwDone = false;
    if (newPw.length < 8) { pwError = t.account.errTooShort; return; }
    if (newPw !== confirmPw) { pwError = t.account.errMismatch; return; }
    const res = await changePassword(curPw, newPw);
    if (res.ok) {
      pwDone = true;
      curPw = ""; newPw = ""; confirmPw = "";
      pwOpen = false;
    } else {
      pwError = mapPwError(res.error);
    }
  }
```

Replace the signed-in menu block (the `{#if open}` under the signed-in branch, currently showing only "who" + sign out) with one that adds the password section:

```svelte
    {#if open}
      <div class="menu">
        <div class="who">{t.account.signedInAs(session().user!.email)}</div>

        {#if pwOpen}
          {#if session().user!.hasPassword}
            <input type="password" bind:value={curPw} placeholder={t.account.currentPassword} />
          {/if}
          <input type="password" bind:value={newPw} placeholder={t.account.newPassword} />
          <input type="password" bind:value={confirmPw} placeholder={t.account.confirmPassword} />
          {#if pwError}<p class="err">{pwError}</p>{/if}
          <button class="primary" onclick={onChangePassword}>
            {session().user!.hasPassword ? t.account.changePassword : t.account.setPassword}
          </button>
          <button class="link" onclick={() => { pwOpen = false; pwError = ""; }}>{t.close}</button>
        {:else}
          {#if pwDone}<p class="hint">{t.account.pwChanged}</p>{/if}
          <button class="ghost" onclick={() => { pwOpen = true; pwDone = false; }}>
            {session().user!.hasPassword ? t.account.changePassword : t.account.setPassword}
          </button>
        {/if}

        <button class="ghost" onclick={onLogout}>{t.account.signOut}</button>
      </div>
    {/if}
```

(The `.menu input`, `.primary`, `.ghost`, `.link`, `.err`, `.hint` styles already exist — no CSS change needed. The cancel link uses the existing top-level `t.close` string. Confirm `t.close` exists in the `Messages` interface before use — it does, used in `App.svelte` as `aria-label={t.close}`.)

- [ ] **Step 2: Type-check, test, build**

Run: `cd web && npm run check && npm test && npm run build`
Expected: check 0 errors, all vitest PASS, build succeeds.

- [ ] **Step 3: Manual smoke (document in commit; not automated)**

With `npm run dev` + the Go server:
1. 登录（密码用户）→ 账号菜单点「修改密码」→ 输旧/新/确认 → 成功提示，菜单显示"其他设备已登出"。
2. 在另一浏览器登录同账号 → 改密后该会话被登出（刷新即 401）。
3. 旧密码错 / 两次新密码不一致 → 对应报错。
4. （可选）Google/魔法用户 → 菜单显示「设置密码」，无「当前密码」字段，设后可用密码登录。

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/Account.svelte
git commit -m "feat(web): set/change password form in the account menu

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 完成后

整支验证：
- `cd server && go build ./... && go vet ./... && go test ./...`
- `cd web && npm run check && npm test && npm run build`

随后进入 `superpowers:finishing-a-development-branch`（含最终整支 opus 审查）。
