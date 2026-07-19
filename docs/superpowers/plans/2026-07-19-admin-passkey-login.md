# 管理员后台 Passkey 登录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员日常进后台从「账号+密码+TOTP」降为一次生物识别，密码+TOTP 保留为后备通道。

**Architecture:** 在既有 `internal/account` 包内新增 WebAuthn RP。凭据存 SQLite 新表 `admin_credentials`（整条 `webauthn.Credential` 以 JSON 存放）。登录走 discoverable（免用户名）流程，成功后复用既有 `newAdminSession()` 与 `relayium_admin` cookie——会话机制完全不动。注册新凭据要求 step-up 重验密码+TOTP。后台首次引入内联 JS，严格渐进增强。

**Tech Stack:** Go 1.26.3、`github.com/go-webauthn/webauthn v0.17.4`、`github.com/fxamacker/cbor/v2`（仅测试用）、`modernc.org/sqlite`、`html/template`、原生 `navigator.credentials`（无前端框架）。

设计文档：`docs/superpowers/specs/2026-07-19-admin-passkey-login-design.md`

## Global Constraints

- 依赖版本固定：`github.com/go-webauthn/webauthn v0.17.4`
- RP ID 由 `Config.BaseURL` 推导：取 host 并去端口（`u.Hostname()`）；RP origins 用 `s.selfOrigin()` 的完整值
- RP DisplayName 固定为 `"Relayium 后台"`
- 所有 passkey 端点路径前缀 `/admin/passkey/`
- passkey 登录失败**必须**使用独立 throttle 桶 `s.adminPasskeyLogins`，**不得**写入 `s.adminLogins`
- 注册 step-up 失败**使用** `s.adminLogins`（它验的确实是密码+TOTP）
- JSON 端点必须同时挂 `s.csrfGuard` 与新增的 `s.requireOrigin`
- 新增 Store 方法必须同时加到 `store.go` 的 `Store` 接口与 `sqlite.go` 的 `SQLiteStore`（本包仅此一个实现）
- 测试遵循既有惯例：`_test.go` 同包内部测试、真实内存 SQLite（`newTestStore`）、纯 `testing`、无 testify
- 用户可见文案一律中文
- 每个任务结束前跑 `cd server && go test ./...` 必须全绿

---

### Task 1: 存储层（`admin_credentials` 表与 CRUD）

**Files:**
- Modify: `server/go.mod`（新增 go-webauthn 依赖）
- Modify: `server/internal/account/sqlite.go`（schema 常量 + Store 方法实现）
- Modify: `server/internal/account/store.go:336`（`Store` 接口新增方法）
- Create: `server/internal/account/passkey_store_test.go`

**Interfaces:**
- Consumes: 既有 `newTestStore(t)`、`SQLiteStore`、`Store` 接口
- Produces:
  - `type AdminCredential struct { ID string; UserHandle []byte; CredJSON []byte; Name string; CreatedAt int64; LastUsedAt int64 }`
  - `ListAdminCredentials(ctx context.Context) ([]AdminCredential, error)`
  - `GetAdminCredential(ctx context.Context, id string) (AdminCredential, bool, error)`
  - `InsertAdminCredential(ctx context.Context, c AdminCredential) error`
  - `TouchAdminCredential(ctx context.Context, id string, credJSON []byte, lastUsedAt int64) error`
  - `DeleteAdminCredential(ctx context.Context, id string) error`
  - `AdminUserHandle(ctx context.Context) ([]byte, bool, error)`

- [ ] **Step 1: 添加依赖**

```bash
cd server && go get github.com/go-webauthn/webauthn@v0.17.4
```

预期输出包含 `go: added github.com/go-webauthn/webauthn v0.17.4`（或 `go: upgraded`）。

- [ ] **Step 2: 写失败测试**

创建 `server/internal/account/passkey_store_test.go`：

```go
package account

import (
	"bytes"
	"context"
	"testing"
)

func TestAdminCredentialCRUD(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	// 空表：无 handle
	if _, ok, err := st.AdminUserHandle(ctx); err != nil || ok {
		t.Fatalf("empty store: handle ok=%v err=%v, want ok=false", ok, err)
	}
	if creds, err := st.ListAdminCredentials(ctx); err != nil || len(creds) != 0 {
		t.Fatalf("empty store: got %d creds err=%v, want 0", len(creds), err)
	}

	handle := []byte("handle-32-bytes-aaaaaaaaaaaaaaaa")
	c := AdminCredential{
		ID: "cred-a", UserHandle: handle, CredJSON: []byte(`{"id":"a"}`),
		Name: "MacBook", CreatedAt: 1000, LastUsedAt: 0,
	}
	if err := st.InsertAdminCredential(ctx, c); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, ok, err := st.GetAdminCredential(ctx, "cred-a")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if got.Name != "MacBook" || !bytes.Equal(got.UserHandle, handle) {
		t.Fatalf("get: name=%q handle=%q", got.Name, got.UserHandle)
	}
	if !bytes.Equal(got.CredJSON, []byte(`{"id":"a"}`)) {
		t.Fatalf("get: credJSON=%q", got.CredJSON)
	}

	// handle 现在可读
	h, ok, err := st.AdminUserHandle(ctx)
	if err != nil || !ok || !bytes.Equal(h, handle) {
		t.Fatalf("handle: %q ok=%v err=%v", h, ok, err)
	}

	// 回写 credJSON + last_used_at
	if err := st.TouchAdminCredential(ctx, "cred-a", []byte(`{"id":"a","n":1}`), 2000); err != nil {
		t.Fatalf("touch: %v", err)
	}
	got, _, _ = st.GetAdminCredential(ctx, "cred-a")
	if got.LastUsedAt != 2000 || !bytes.Equal(got.CredJSON, []byte(`{"id":"a","n":1}`)) {
		t.Fatalf("after touch: lastUsed=%d json=%q", got.LastUsedAt, got.CredJSON)
	}

	// 缺失键
	if _, ok, err := st.GetAdminCredential(ctx, "nope"); err != nil || ok {
		t.Fatalf("missing: ok=%v err=%v, want ok=false", ok, err)
	}

	// 删除
	if err := st.DeleteAdminCredential(ctx, "cred-a"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok, _ := st.GetAdminCredential(ctx, "cred-a"); ok {
		t.Fatalf("still present after delete")
	}
}

// 第二枚凭据必须复用第一枚的 user handle：handle 与 RELAYIUM_ADMIN_USER 解耦，
// 变更用户名不得作废已注册凭据。
func TestAdminUserHandleSharedAcrossCredentials(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	handle := []byte("shared-handle-aaaaaaaaaaaaaaaaaa")

	for _, id := range []string{"c1", "c2"} {
		err := st.InsertAdminCredential(ctx, AdminCredential{
			ID: id, UserHandle: handle, CredJSON: []byte(`{}`),
			Name: id, CreatedAt: 1, LastUsedAt: 0,
		})
		if err != nil {
			t.Fatalf("insert %s: %v", id, err)
		}
	}

	h, ok, err := st.AdminUserHandle(ctx)
	if err != nil || !ok || !bytes.Equal(h, handle) {
		t.Fatalf("shared handle: %q ok=%v err=%v", h, ok, err)
	}
	creds, err := st.ListAdminCredentials(ctx)
	if err != nil || len(creds) != 2 {
		t.Fatalf("list: %d creds err=%v, want 2", len(creds), err)
	}
	// 按 created_at, id 稳定排序
	if creds[0].ID != "c1" || creds[1].ID != "c2" {
		t.Fatalf("order: %s,%s", creds[0].ID, creds[1].ID)
	}
}
```

- [ ] **Step 3: 跑测试确认失败**

```bash
cd server && go test ./internal/account/ -run 'TestAdminCredential|TestAdminUserHandle' 2>&1 | tail -20
```

预期：编译失败，`undefined: AdminCredential`。

- [ ] **Step 4: 加表结构**

在 `server/internal/account/sqlite.go` 的 `schema` 常量末尾（`plans` 表之后）追加：

```sql
CREATE TABLE IF NOT EXISTS admin_credentials (
  id           TEXT PRIMARY KEY,
  user_handle  BLOB NOT NULL,
  cred_json    BLOB NOT NULL,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 5: 加类型与 Store 接口方法**

在 `server/internal/account/store.go` 中，`Store` 接口定义之前加类型：

```go
// AdminCredential is one registered admin passkey. CredJSON holds the full
// webauthn.Credential record (public key, sign counter, flags, transports,
// attestation) as JSON: the library requires the whole record be preserved and
// written back after each successful login, so it is not split into columns.
// UserHandle is the WebAuthn user ID, identical across all rows and
// deliberately decoupled from RELAYIUM_ADMIN_USER so renaming the admin does
// not silently invalidate every registered passkey.
type AdminCredential struct {
	ID         string
	UserHandle []byte
	CredJSON   []byte
	Name       string
	CreatedAt  int64
	LastUsedAt int64
}
```

在 `Store` 接口内（`store.go:336` 起）追加：

```go
	// admin passkeys
	ListAdminCredentials(ctx context.Context) ([]AdminCredential, error)
	GetAdminCredential(ctx context.Context, id string) (AdminCredential, bool, error)
	InsertAdminCredential(ctx context.Context, c AdminCredential) error
	// TouchAdminCredential writes back the updated credential record and the
	// last-used timestamp after a successful login.
	TouchAdminCredential(ctx context.Context, id string, credJSON []byte, lastUsedAt int64) error
	DeleteAdminCredential(ctx context.Context, id string) error
	// AdminUserHandle returns the shared WebAuthn user handle, ok=false when no
	// credential is registered yet (the first registration mints one).
	AdminUserHandle(ctx context.Context) ([]byte, bool, error)
```

- [ ] **Step 6: 实现 Store 方法**

在 `server/internal/account/sqlite.go` 末尾追加：

```go
func (s *SQLiteStore) ListAdminCredentials(ctx context.Context) ([]AdminCredential, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, user_handle, cred_json, name, created_at, last_used_at
FROM admin_credentials ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AdminCredential
	for rows.Next() {
		var c AdminCredential
		if err := rows.Scan(&c.ID, &c.UserHandle, &c.CredJSON, &c.Name, &c.CreatedAt, &c.LastUsedAt); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *SQLiteStore) GetAdminCredential(ctx context.Context, id string) (AdminCredential, bool, error) {
	var c AdminCredential
	err := s.db.QueryRowContext(ctx, `
SELECT id, user_handle, cred_json, name, created_at, last_used_at
FROM admin_credentials WHERE id = ?`, id).
		Scan(&c.ID, &c.UserHandle, &c.CredJSON, &c.Name, &c.CreatedAt, &c.LastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AdminCredential{}, false, nil
	}
	if err != nil {
		return AdminCredential{}, false, err
	}
	return c, true, nil
}

func (s *SQLiteStore) InsertAdminCredential(ctx context.Context, c AdminCredential) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO admin_credentials (id, user_handle, cred_json, name, created_at, last_used_at)
VALUES (?, ?, ?, ?, ?, ?)`,
		c.ID, c.UserHandle, c.CredJSON, c.Name, c.CreatedAt, c.LastUsedAt)
	return err
}

func (s *SQLiteStore) TouchAdminCredential(ctx context.Context, id string, credJSON []byte, lastUsedAt int64) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE admin_credentials SET cred_json = ?, last_used_at = ? WHERE id = ?`,
		credJSON, lastUsedAt, id)
	return err
}

func (s *SQLiteStore) DeleteAdminCredential(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM admin_credentials WHERE id = ?`, id)
	return err
}

func (s *SQLiteStore) AdminUserHandle(ctx context.Context) ([]byte, bool, error) {
	var h []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT user_handle FROM admin_credentials ORDER BY created_at, id LIMIT 1`).Scan(&h)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return h, true, nil
}
```

若 `sqlite.go` 尚未导入 `errors` / `database/sql`，补上导入（文件顶部大概率已有，先确认再改）。

- [ ] **Step 7: 跑测试确认通过**

```bash
cd server && go test ./internal/account/ -run 'TestAdminCredential|TestAdminUserHandle' -v 2>&1 | tail -20
```

预期：两个测试 PASS。

- [ ] **Step 8: 全量测试**

```bash
cd server && go test ./... 2>&1 | tail -20
```

预期：全部 ok，无 FAIL。

- [ ] **Step 9: 提交**

```bash
cd server && git add go.mod go.sum internal/account/sqlite.go internal/account/store.go internal/account/passkey_store_test.go
git commit -m "feat(admin): admin_credentials 表与 passkey 凭据存储层

user handle 与 RELAYIUM_ADMIN_USER 解耦，改用户名不作废已注册凭据。
凭据整条以 JSON 存 cred_json，避免拆列丢弃 flags/transports/attestation。"
```

---

### Task 2: WebAuthn RP 配置、User 实现与软件 authenticator 测试辅助

本任务交付一条不经过 HTTP 的完整往返测试：注册 → discoverable 登录全部在库层跑通。此处的软件 authenticator 是后续所有端点测试的基础设施，**下面的代码已实测通过**，照抄即可。

**Files:**
- Create: `server/internal/account/passkey.go`
- Create: `server/internal/account/passkey_authenticator_test.go`
- Create: `server/internal/account/passkey_test.go`

**Interfaces:**
- Consumes: Task 1 的 `AdminCredential` 与 Store 方法；既有 `s.selfOrigin()`（`handlers.go:40`）、`s.adminUser()`、`s.store`
- Produces:
  - `func (s *Service) adminRP() (*webauthn.WebAuthn, error)`
  - `type adminPasskeyUser struct{ handle []byte; name string; creds []webauthn.Credential }`（实现 `webauthn.User`）
  - `func (s *Service) loadAdminPasskeyUser(ctx context.Context) (*adminPasskeyUser, error)`
  - `func (s *Service) adminPasskeyCount(ctx context.Context) int`
  - 测试辅助：`newTestAuthenticator(t)` → `*testAuthenticator`，含方法 `registerBody(t, rpID, origin, challenge) string`、`assertBody(t, rpID, origin, challenge string, userHandle []byte) string`、字段 `credID []byte`

- [ ] **Step 1: 写失败测试**

创建 `server/internal/account/passkey_test.go`：

```go
package account

import (
	"context"
	"crypto/rand"
	"net/http"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// RP ID 必须是去端口的 host：带端口会被浏览器拒绝。
func TestAdminRPIDDerivation(t *testing.T) {
	cases := []struct {
		baseURL string
		wantRP  string
		wantErr bool
	}{
		{"https://relayium.com", "relayium.com", false},
		{"https://relayium.com:8443", "relayium.com", false},
		{"http://localhost:8080", "localhost", false},
		{"", "", true},
	}
	for _, tc := range cases {
		s := &Service{cfg: Config{BaseURL: tc.baseURL}}
		rp, err := s.adminRP()
		if tc.wantErr {
			if err == nil {
				t.Fatalf("%q: want error, got none", tc.baseURL)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%q: %v", tc.baseURL, err)
		}
		if rp.Config.RPID != tc.wantRP {
			t.Fatalf("%q: RPID=%q want %q", tc.baseURL, rp.Config.RPID, tc.wantRP)
		}
	}
}

// 库层完整往返：注册一枚凭据，再用它做 discoverable 登录。
func TestPasskeyRoundTripAtLibraryLayer(t *testing.T) {
	const rpID, origin = "localhost", "https://localhost"
	w, err := webauthn.New(&webauthn.Config{
		RPID: rpID, RPDisplayName: "Relayium 后台", RPOrigins: []string{origin},
	})
	if err != nil {
		t.Fatalf("new rp: %v", err)
	}

	auth := newTestAuthenticator(t)
	handle := make([]byte, 32)
	if _, err := rand.Read(handle); err != nil {
		t.Fatalf("handle: %v", err)
	}
	user := &adminPasskeyUser{handle: handle, name: "admin"}

	creation, sess, err := w.BeginRegistration(user,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
	)
	if err != nil {
		t.Fatalf("begin registration: %v", err)
	}
	if creation.Response.Challenge.String() == "" {
		t.Fatalf("empty challenge")
	}

	req, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.registerBody(t, rpID, origin, sess.Challenge)))
	req.Header.Set("Content-Type", "application/json")

	cred, err := w.FinishRegistration(user, *sess, req)
	if err != nil {
		t.Fatalf("finish registration: %v", err)
	}
	user.creds = append(user.creds, *cred)

	_, lsess, err := w.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		t.Fatalf("begin login: %v", err)
	}
	lreq, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.assertBody(t, rpID, origin, lsess.Challenge, handle)))
	lreq.Header.Set("Content-Type", "application/json")

	handler := func(rawID, userHandle []byte) (webauthn.User, error) { return user, nil }
	_, lcred, err := w.FinishPasskeyLogin(handler, *lsess, lreq)
	if err != nil {
		t.Fatalf("finish login: %v", err)
	}
	if lcred.Authenticator.CloneWarning {
		t.Fatalf("unexpected clone warning on first login")
	}
}

// 错误 challenge 必须被拒绝。
func TestPasskeyRejectsWrongChallenge(t *testing.T) {
	const rpID, origin = "localhost", "https://localhost"
	w, _ := webauthn.New(&webauthn.Config{
		RPID: rpID, RPDisplayName: "Relayium 后台", RPOrigins: []string{origin},
	})
	auth := newTestAuthenticator(t)
	handle := make([]byte, 32)
	rand.Read(handle)
	user := &adminPasskeyUser{handle: handle, name: "admin"}

	_, sess, _ := w.BeginRegistration(user,
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}))
	req, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.registerBody(t, rpID, origin, "aGVsbG8td3JvbmctY2hhbGxlbmdl")))
	req.Header.Set("Content-Type", "application/json")
	if _, err := w.FinishRegistration(user, *sess, req); err == nil {
		t.Fatalf("wrong challenge accepted")
	}
}

// 空表时 loadAdminPasskeyUser 返回空 handle 的 user（首次注册再铸 handle）。
func TestLoadAdminPasskeyUserEmpty(t *testing.T) {
	s := &Service{cfg: Config{BaseURL: "https://localhost", AdminUser: "root"}, store: newTestStore(t)}
	u, err := s.loadAdminPasskeyUser(context.Background())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(u.handle) != 0 || len(u.creds) != 0 {
		t.Fatalf("empty store: handle=%d creds=%d, want 0/0", len(u.handle), len(u.creds))
	}
	if u.WebAuthnName() != "root" {
		t.Fatalf("name=%q want root", u.WebAuthnName())
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd server && go test ./internal/account/ -run 'TestAdminRPID|TestPasskey|TestLoadAdminPasskey' 2>&1 | tail -20
```

预期：编译失败，`undefined: newTestAuthenticator`、`undefined: adminPasskeyUser`。

- [ ] **Step 3: 写软件 authenticator 测试辅助**

创建 `server/internal/account/passkey_authenticator_test.go`。**以下代码已实测跑通，请勿改动加密逻辑**：

```go
package account

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math/big"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

// testAuthenticator is a minimal software WebAuthn authenticator (ES256, "none"
// attestation). It exists because the real ceremony signs a server-generated
// challenge, so no static fixture can exercise the finish endpoints — the only
// code path that actually decides who gets into the admin panel.
type testAuthenticator struct {
	key       *ecdsa.PrivateKey
	credID    []byte
	signCount uint32
}

func newTestAuthenticator(t *testing.T) *testAuthenticator {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		t.Fatalf("credential id: %v", err)
	}
	return &testAuthenticator{key: k, credID: id}
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// pad32 left-pads an EC coordinate to the fixed 32 bytes COSE requires.
func pad32(i *big.Int) []byte {
	b := i.Bytes()
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

func cborEnc(t *testing.T, v any) []byte {
	t.Helper()
	em, err := cbor.CanonicalEncOptions().EncMode()
	if err != nil {
		t.Fatalf("cbor encmode: %v", err)
	}
	b, err := em.Marshal(v)
	if err != nil {
		t.Fatalf("cbor marshal: %v", err)
	}
	return b
}

// coseKey encodes the public key as a COSE_Key: kty=EC2, alg=ES256, crv=P-256.
func (a *testAuthenticator) coseKey(t *testing.T) []byte {
	t.Helper()
	return cborEnc(t, map[int]any{
		1: 2, 3: -7, -1: 1,
		-2: pad32(a.key.PublicKey.X),
		-3: pad32(a.key.PublicKey.Y),
	})
}

func (a *testAuthenticator) clientData(typ, challenge, origin string) []byte {
	b, _ := json.Marshal(map[string]any{
		"type": typ, "challenge": challenge, "origin": origin, "crossOrigin": false,
	})
	return b
}

// authData builds authenticatorData: rpIdHash || flags || signCount
// [|| aaguid || credIdLen || credId || coseKey when attested].
func (a *testAuthenticator) authData(t *testing.T, rpID string, flags byte, attested bool) []byte {
	t.Helper()
	h := sha256.Sum256([]byte(rpID))
	out := append([]byte{}, h[:]...)
	out = append(out, flags)
	var ctr [4]byte
	binary.BigEndian.PutUint32(ctr[:], a.signCount)
	out = append(out, ctr[:]...)
	if attested {
		out = append(out, make([]byte, 16)...) // zero AAGUID
		var l [2]byte
		binary.BigEndian.PutUint16(l[:], uint16(len(a.credID)))
		out = append(out, l[:]...)
		out = append(out, a.credID...)
		out = append(out, a.coseKey(t)...)
	}
	return out
}

// registerBody produces the JSON navigator.credentials.create() would POST.
// Flags 0x45 = UserPresent | UserVerified | AttestedCredentialData.
func (a *testAuthenticator) registerBody(t *testing.T, rpID, origin, challenge string) string {
	t.Helper()
	cd := a.clientData("webauthn.create", challenge, origin)
	ad := a.authData(t, rpID, 0x45, true)
	att := cborEnc(t, map[string]any{
		"fmt": "none", "attStmt": map[string]any{}, "authData": ad,
	})
	body, _ := json.Marshal(map[string]any{
		"id": b64url(a.credID), "rawId": b64url(a.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64url(cd),
			"attestationObject": b64url(att),
		},
	})
	return string(body)
}

// assertBody produces the JSON navigator.credentials.get() would POST, signing
// over authenticatorData || SHA256(clientDataJSON). Flags 0x05 = UP | UV.
func (a *testAuthenticator) assertBody(t *testing.T, rpID, origin, challenge string, userHandle []byte) string {
	t.Helper()
	a.signCount++
	cd := a.clientData("webauthn.get", challenge, origin)
	ad := a.authData(t, rpID, 0x05, false)
	cdh := sha256.Sum256(cd)
	signed := sha256.Sum256(append(append([]byte{}, ad...), cdh[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, a.key, signed[:])
	if err != nil {
		t.Fatalf("sign assertion: %v", err)
	}
	body, _ := json.Marshal(map[string]any{
		"id": b64url(a.credID), "rawId": b64url(a.credID), "type": "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64url(cd),
			"authenticatorData": b64url(ad),
			"signature":         b64url(sig),
			"userHandle":        b64url(userHandle),
		},
	})
	return string(body)
}

// replayAssertBody re-signs with a stale (non-incrementing) counter to simulate
// a cloned authenticator.
func (a *testAuthenticator) replayAssertBody(t *testing.T, rpID, origin, challenge string, userHandle []byte, counter uint32) string {
	t.Helper()
	saved := a.signCount
	a.signCount = counter - 1 // assertBody increments before use
	defer func() { a.signCount = saved }()
	return a.assertBody(t, rpID, origin, challenge, userHandle)
}
```

- [ ] **Step 4: 写 RP 配置与 User 实现**

创建 `server/internal/account/passkey.go`：

```go
package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"

	"github.com/go-webauthn/webauthn/webauthn"
)

// rpDisplayName is shown by the platform's passkey prompt.
const rpDisplayName = "Relayium 后台"

// adminRP builds the WebAuthn relying party from BaseURL. RPID must be the bare
// host with no port (browsers reject a port in the RP ID), while the origin
// check uses the full scheme://host[:port] value.
func (s *Service) adminRP() (*webauthn.WebAuthn, error) {
	origin := s.selfOrigin()
	if origin == "" {
		return nil, errors.New("passkey: BaseURL 未配置或无效")
	}
	u, err := url.Parse(origin)
	if err != nil {
		return nil, err
	}
	host := u.Hostname()
	if host == "" {
		return nil, errors.New("passkey: BaseURL 缺少 host")
	}
	return webauthn.New(&webauthn.Config{
		RPID:          host,
		RPDisplayName: rpDisplayName,
		RPOrigins:     []string{origin},
	})
}

// adminPasskeyUser is the single WebAuthn user backing the admin panel. handle
// is the stable WebAuthn user ID, deliberately independent of the configured
// admin username: name is display-only.
type adminPasskeyUser struct {
	handle []byte
	name   string
	creds  []webauthn.Credential
}

func (u *adminPasskeyUser) WebAuthnID() []byte                         { return u.handle }
func (u *adminPasskeyUser) WebAuthnName() string                       { return u.name }
func (u *adminPasskeyUser) WebAuthnDisplayName() string                { return u.name }
func (u *adminPasskeyUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// loadAdminPasskeyUser assembles the admin user from stored credentials. With
// no credentials registered the handle is empty; the first registration mints
// one.
func (s *Service) loadAdminPasskeyUser(ctx context.Context) (*adminPasskeyUser, error) {
	u := &adminPasskeyUser{name: s.adminUser()}
	handle, ok, err := s.store.AdminUserHandle(ctx)
	if err != nil {
		return nil, err
	}
	if ok {
		u.handle = handle
	}
	rows, err := s.store.ListAdminCredentials(ctx)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		var c webauthn.Credential
		if err := json.Unmarshal(row.CredJSON, &c); err != nil {
			// A single corrupt row must not lock the admin out of every passkey.
			continue
		}
		u.creds = append(u.creds, c)
	}
	return u, nil
}

// adminPasskeyCount reports how many passkeys are registered; 0 means the login
// page must not offer the passkey button.
func (s *Service) adminPasskeyCount(ctx context.Context) int {
	rows, err := s.store.ListAdminCredentials(ctx)
	if err != nil {
		return 0
	}
	return len(rows)
}
```

- [ ] **Step 5: 跑测试确认通过**

```bash
cd server && go test ./internal/account/ -run 'TestAdminRPID|TestPasskey|TestLoadAdminPasskey' -v 2>&1 | tail -25
```

预期：4 个测试全部 PASS。

- [ ] **Step 6: 全量测试**

```bash
cd server && go test ./... 2>&1 | tail -20
```

预期：全部 ok。

- [ ] **Step 7: 提交**

```bash
cd server && git add go.mod go.sum internal/account/passkey.go internal/account/passkey_test.go internal/account/passkey_authenticator_test.go
git commit -m "feat(admin): WebAuthn RP 配置与 passkey 用户模型

含软件 authenticator 测试辅助（ES256/none attestation），使注册与
discoverable 登录的完整往返可在 go test 内验证。"
```

---

### Task 3: 登录端点（begin/finish）与独立 throttle 桶

**Files:**
- Modify: `server/internal/account/service.go:146`（新增 `adminPasskeyLogins`、ceremony map 字段）与其 `NewService` 初始化处（`service.go:198` 附近）
- Modify: `server/internal/account/admin.go:177`（注册路由）
- Modify: `server/internal/account/handlers.go`（新增 `requireOrigin`）
- Create: `server/internal/account/passkey_login.go`
- Create: `server/internal/account/passkey_login_test.go`

**Interfaces:**
- Consumes: Task 2 的 `adminRP()`、`loadAdminPasskeyUser()`、`testAuthenticator`；既有 `newAdminSession()`、`adminCookie`、`cookieSecure()`、`adminSessionTTL`、`clientIP()`、`writeJSON(w, code, v)`（`handlers.go:286`）、`loginThrottle`
- Produces:
  - `func (s *Service) requireOrigin(next http.Handler) http.Handler`
  - `POST /admin/passkey/login/begin`、`POST /admin/passkey/login/finish`
  - ceremony 辅助：`putCeremony(w, sess webauthn.SessionData, name string)`、`takeCeremony(r) (passkeyCeremony, bool)`

- [ ] **Step 1: 写失败测试**

创建 `server/internal/account/passkey_login_test.go`：

```go
package account

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// registerTestPasskey 走库层注册一枚凭据并写库，返回 authenticator 与 handle。
func registerTestPasskey(t *testing.T, s *Service) (*testAuthenticator, []byte) {
	t.Helper()
	ctx := context.Background()
	rp, err := s.adminRP()
	if err != nil {
		t.Fatalf("rp: %v", err)
	}
	handle := make([]byte, 32)
	if _, err := rand.Read(handle); err != nil {
		t.Fatalf("handle: %v", err)
	}
	user := &adminPasskeyUser{handle: handle, name: s.adminUser()}
	_, sess, err := rp.BeginRegistration(user, adminRegistrationOpts()...)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	auth := newTestAuthenticator(t)
	req, _ := http.NewRequest("POST", "/", strings.NewReader(
		auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), sess.Challenge)))
	req.Header.Set("Content-Type", "application/json")
	cred, err := rp.FinishRegistration(user, *sess, req)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	blob, _ := json.Marshal(cred)
	err = s.store.InsertAdminCredential(ctx, AdminCredential{
		ID: b64url(cred.ID), UserHandle: handle, CredJSON: blob,
		Name: "测试设备", CreatedAt: s.now().Unix(),
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	return auth, handle
}

func TestPasskeyLoginEndToEnd(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)

	// begin
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("begin status=%d want 200", resp.StatusCode)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&opts); err != nil {
		t.Fatalf("decode: %v", err)
	}
	resp.Body.Close()
	if opts.PublicKey.Challenge == "" {
		t.Fatalf("empty challenge")
	}
	ceremony := resp.Cookies()

	// finish
	rp, _ := s.adminRP()
	body := auth.assertBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge, handle)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish", strings.NewReader(body))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	for _, c := range ceremony {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("finish status=%d want 200", fresp.StatusCode)
	}

	// 必须种下管理员会话 cookie
	var admin string
	for _, c := range fresp.Cookies() {
		if c.Name == adminCookie {
			admin = c.Value
		}
	}
	if admin == "" || !s.validAdmin(admin) {
		t.Fatalf("no valid admin session issued")
	}

	// last_used_at 必须被回写
	rows, _ := s.store.ListAdminCredentials(context.Background())
	if len(rows) != 1 || rows[0].LastUsedAt == 0 {
		t.Fatalf("last_used_at not written: %+v", rows)
	}
}

// 无 ceremony cookie 的 finish 必须被拒（防止跨会话拼接 challenge）。
func TestPasskeyLoginFinishWithoutCeremony(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	registerTestPasskey(t, s)
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
		strings.NewReader(`{"id":"x","type":"public-key"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("finish without ceremony succeeded")
	}
}

// 缺失 Origin 头必须被拒：这些端点只由 fetch 调用，fetch 必带 Origin。
func TestPasskeyEndpointsRequireOrigin(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	registerTestPasskey(t, s)
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("no-Origin begin status=%d want 403", resp.StatusCode)
	}
}

// 核心安全断言：passkey 失败刷爆后，密码后备通道必须仍然可用。
// 两者共用一个 throttle 桶会让攻击者用 passkey 失败锁死唯一退路。
func TestPasskeyThrottleDoesNotLockPasswordLogin(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)
	rp, _ := s.adminRP()

	for i := 0; i < adminLoginMaxFails+3; i++ {
		// 取一个合法 ceremony，再用错误 challenge 签名 → 必然验签失败
		breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
		breq.Header.Set("Origin", s.selfOrigin())
		bresp, err := srv.Client().Do(breq)
		if err != nil {
			t.Fatalf("begin %d: %v", i, err)
		}
		cookies := bresp.Cookies()
		bresp.Body.Close()

		bad := auth.assertBody(t, rp.Config.RPID, s.selfOrigin(),
			"d3JvbmctY2hhbGxlbmdlLXZhbHVl", handle)
		freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
			strings.NewReader(bad))
		freq.Header.Set("Content-Type", "application/json")
		freq.Header.Set("Origin", s.selfOrigin())
		for _, c := range cookies {
			freq.AddCookie(c)
		}
		fresp, err := srv.Client().Do(freq)
		if err != nil {
			t.Fatalf("finish %d: %v", i, err)
		}
		fresp.Body.Close()
		if fresp.StatusCode == http.StatusOK {
			t.Fatalf("bad challenge accepted at attempt %d", i)
		}
	}

	// 密码通道必须没被连带锁死
	form := strings.NewReader("username=admin&password=pw")
	preq, _ := http.NewRequest("POST", srv.URL+"/admin/login", form)
	preq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	preq.Header.Set("Origin", s.selfOrigin())
	presp, err := srv.Client().Do(preq)
	if err != nil {
		t.Fatalf("password login: %v", err)
	}
	defer presp.Body.Close()
	if presp.StatusCode == http.StatusTooManyRequests {
		t.Fatalf("passkey failures locked the password fallback — throttle buckets are shared")
	}
}

// 克隆凭据（计数器回退）必须被拒。
func TestPasskeyRejectsClonedCredential(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)
	rp, _ := s.adminRP()

	login := func(body string, cookies []*http.Cookie) int {
		req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
			strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", s.selfOrigin())
		for _, c := range cookies {
			req.AddCookie(c)
		}
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("do: %v", err)
		}
		defer resp.Body.Close()
		return resp.StatusCode
	}
	begin := func() (string, []*http.Cookie) {
		req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
		req.Header.Set("Origin", s.selfOrigin())
		resp, err := srv.Client().Do(req)
		if err != nil {
			t.Fatalf("begin: %v", err)
		}
		defer resp.Body.Close()
		var o struct {
			PublicKey struct {
				Challenge string `json:"challenge"`
			} `json:"publicKey"`
		}
		json.NewDecoder(resp.Body).Decode(&o)
		return o.PublicKey.Challenge, resp.Cookies()
	}

	// 先正常登录若干次，把 sign count 推上去
	for i := 0; i < 3; i++ {
		ch, ck := begin()
		if code := login(auth.assertBody(t, rp.Config.RPID, s.selfOrigin(), ch, handle), ck); code != http.StatusOK {
			t.Fatalf("legit login %d: status=%d", i, code)
		}
	}
	// 再用回退的计数器（克隆特征）
	ch, ck := begin()
	body := auth.replayAssertBody(t, rp.Config.RPID, s.selfOrigin(), ch, handle, 1)
	if code := login(body, ck); code == http.StatusOK {
		t.Fatalf("cloned credential (rolled-back counter) was accepted")
	}
}

// 过期 ceremony 必须被拒：challenge 不得在 TTL 之后仍可兑换。
func TestPasskeyCeremonyExpires(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	auth, handle := registerTestPasskey(t, s)
	rp, _ := s.adminRP()

	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/begin", nil)
	breq.Header.Set("Origin", s.selfOrigin())
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	var o struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&o)
	cookies := bresp.Cookies()
	bresp.Body.Close()

	// 把时钟推过 ceremony TTL
	base := s.now()
	s.now = func() time.Time { return base.Add(passkeyCeremonyTTL + time.Minute) }

	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/login/finish",
		strings.NewReader(auth.assertBody(t, rp.Config.RPID, s.selfOrigin(), o.PublicKey.Challenge, handle)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode == http.StatusOK {
		t.Fatalf("expired ceremony was accepted")
	}
}
```

`TestPasskeyCeremonyExpires` 需在导入中加 `"time"`。`Service.now` 是可写字段（`service.go:130`，类型 `func() time.Time`），直接替换即可推进时钟。

**注意** `newAdminServer(t, user, pass)` 现有签名（`admin_test.go:14`）只返回 `*httptest.Server`。本任务需要它同时返回 `*Service`。第一步先改造它。

- [ ] **Step 2: 改造 newAdminServer 返回 Service**

读 `server/internal/account/admin_test.go:14-27`，把签名改为 `func newAdminServer(t *testing.T, user, pass string) (*httptest.Server, *Service)`，返回同时构造出的 service，并更新该文件内所有既有调用点（改为 `srv, _ := newAdminServer(...)`）。

```bash
cd server && go test ./internal/account/ -run TestAdmin 2>&1 | tail -20
```

预期：既有 admin 测试仍全部 PASS。

- [ ] **Step 3: 跑新测试确认失败**

```bash
cd server && go test ./internal/account/ -run TestPasskeyLogin 2>&1 | tail -20
```

预期：编译失败，`undefined: adminRegistrationOpts`。

- [ ] **Step 4: 加 Service 字段**

在 `server/internal/account/service.go` 的 Service 结构中，`adminLogins` 一行之后加：

```go
	// adminPasskeyLogins is a SEPARATE bucket from adminLogins on purpose: if
	// passkey failures counted against the password bucket, an attacker could
	// spam failed passkey attempts to lock out the password fallback — the one
	// escape hatch when passkeys are unavailable.
	adminPasskeyLogins *loginThrottle
	// passkeyCeremonies holds in-flight WebAuthn challenges keyed by an opaque
	// cookie value, mirroring how adminSessions works (process-local, short TTL).
	passkeyCeremonies map[string]passkeyCeremony
	passkeyMu         sync.Mutex
```

在 `NewService` 内 `adminSessions` 初始化附近加：

```go
	s.adminPasskeyLogins = newLoginThrottle()
	s.passkeyCeremonies = map[string]passkeyCeremony{}
```

- [ ] **Step 5: 加 requireOrigin**

在 `server/internal/account/handlers.go` 的 `csrfGuard` 之后追加：

```go
// requireOrigin rejects requests that carry no Origin header. csrfGuard
// deliberately exempts those (top-level form posts, native clients need it),
// but the passkey JSON endpoints are only ever called by fetch, which always
// sends Origin — so a missing one there is a forgery signal, not a legitimate
// client. Compose as csrfGuard(requireOrigin(h)).
func (s *Service) requireOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") == "" {
			http.Error(w, "origin required", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 6: 实现登录端点**

创建 `server/internal/account/passkey_login.go`：

```go
package account

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

const (
	// passkeyCeremonyCookie ties a begin call to its finish call. The library
	// requires SessionData be anchored to the user agent and not client-modifiable.
	passkeyCeremonyCookie = "relayium_admin_ceremony"
	passkeyCeremonyTTL    = 5 * time.Minute
)

// passkeyCeremony is one in-flight WebAuthn ceremony. name carries the
// operator-supplied credential label through registration (finish reads the raw
// body as the credential response, so the label cannot ride along there).
type passkeyCeremony struct {
	session webauthn.SessionData
	name    string
	expires time.Time
}

// adminRegistrationOpts pins registration to a discoverable credential with
// user verification, which is what makes username-less one-tap login possible.
func adminRegistrationOpts() []webauthn.RegistrationOption {
	return []webauthn.RegistrationOption{
		webauthn.WithAuthenticatorSelection(protocol.AuthenticatorSelection{
			ResidentKey:      protocol.ResidentKeyRequirementRequired,
			UserVerification: protocol.VerificationRequired,
		}),
	}
}

func (s *Service) putCeremony(w http.ResponseWriter, sess webauthn.SessionData, name string) {
	tok := randToken()
	s.passkeyMu.Lock()
	// Opportunistically drop expired ceremonies so the map stays bounded.
	now := s.now()
	for k, c := range s.passkeyCeremonies {
		if now.After(c.expires) {
			delete(s.passkeyCeremonies, k)
		}
	}
	s.passkeyCeremonies[tok] = passkeyCeremony{
		session: sess, name: name, expires: now.Add(passkeyCeremonyTTL),
	}
	s.passkeyMu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name: passkeyCeremonyCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(passkeyCeremonyTTL / time.Second),
	})
}

// takeCeremony consumes the ceremony one-shot: a challenge must never be
// replayable.
func (s *Service) takeCeremony(r *http.Request) (passkeyCeremony, bool) {
	c, err := r.Cookie(passkeyCeremonyCookie)
	if err != nil || c.Value == "" {
		return passkeyCeremony{}, false
	}
	s.passkeyMu.Lock()
	cer, ok := s.passkeyCeremonies[c.Value]
	delete(s.passkeyCeremonies, c.Value)
	s.passkeyMu.Unlock()
	if !ok || s.now().After(cer.expires) {
		return passkeyCeremony{}, false
	}
	return cer, true
}

func (s *Service) handleAdminPasskeyLoginBegin(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if s.adminPasskeyLogins.locked(ip, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	assertion, sess, err := rp.BeginDiscoverableLogin(
		webauthn.WithUserVerification(protocol.VerificationRequired))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "无法发起验证"})
		return
	}
	s.putCeremony(w, *sess, "")
	writeJSON(w, http.StatusOK, assertion)
}

func (s *Service) handleAdminPasskeyLoginFinish(w http.ResponseWriter, r *http.Request) {
	ip := s.clientIP(r)
	if s.adminPasskeyLogins.locked(ip, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	cer, ok := s.takeCeremony(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "验证已过期，请重试"})
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	user, err := s.loadAdminPasskeyUser(r.Context())
	if err != nil || len(user.creds) == 0 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "尚未注册 passkey"})
		return
	}
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		if !bytes.Equal(userHandle, user.handle) {
			return nil, errors.New("unknown user handle")
		}
		return user, nil
	}
	_, cred, err := rp.FinishPasskeyLogin(handler, cer.session, r)
	if err != nil {
		s.adminPasskeyLogins.recordFail(ip, s.now())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "验证失败"})
		return
	}
	// CloneWarning means the counter went backwards: two copies of the private
	// key may be in use. The library already tolerates counters that stay at 0
	// (iCloud Keychain and other synced passkeys never increment).
	if cred.Authenticator.CloneWarning {
		s.adminPasskeyLogins.recordFail(ip, s.now())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "凭据异常，已拒绝"})
		return
	}
	blob, err := json.Marshal(cred)
	if err == nil {
		// Best effort: a failed write-back must not block a valid login.
		_ = s.store.TouchAdminCredential(r.Context(), b64url(cred.ID), blob, s.now().Unix())
	}
	s.adminPasskeyLogins.reset(ip)
	tok := s.newAdminSession()
	http.SetCookie(w, &http.Cookie{
		Name: adminCookie, Value: tok, Path: "/admin",
		HttpOnly: true, Secure: s.cookieSecure(), SameSite: http.SameSiteLaxMode,
		MaxAge: int(adminSessionTTL / time.Second),
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
```

`b64url` 目前定义在 `passkey_authenticator_test.go`（仅测试可见）。把它移到 `passkey.go` 作为生产代码：

```go
// b64url encodes credential IDs the way WebAuthn does (base64url, no padding).
func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
```

并从 `passkey_authenticator_test.go` 中删除该函数定义、在 `passkey.go` 补 `encoding/base64` 导入。

- [ ] **Step 7: 注册路由**

在 `server/internal/account/admin.go` 的 `RegisterAdmin` 内，`POST /admin/logout` 之后加：

```go
	mux.Handle("POST /admin/passkey/login/begin",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminPasskeyLoginBegin))))
	mux.Handle("POST /admin/passkey/login/finish",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminPasskeyLoginFinish))))
```

- [ ] **Step 8: 跑测试确认通过**

```bash
cd server && go test ./internal/account/ -run TestPasskey -v 2>&1 | tail -30
```

预期：所有 TestPasskey* PASS，特别确认 `TestPasskeyThrottleDoesNotLockPasswordLogin` 与 `TestPasskeyRejectsClonedCredential` 为 PASS。

- [ ] **Step 9: 全量测试**

```bash
cd server && go test ./... 2>&1 | tail -20
```

预期：全部 ok。

- [ ] **Step 10: 提交**

```bash
cd server && git add -A internal/account/
git commit -m "feat(admin): passkey discoverable 登录端点

独立 throttle 桶：passkey 失败不得连带锁死密码后备通道。
ceremony 一次性消费 + Origin 强制存在（csrfGuard 对缺失 Origin 豁免）。"
```

---

### Task 4: 注册端点（step-up）与删除端点

**Files:**
- Modify: `server/internal/account/admin.go`（抽出 `verifyAdminCreds`、注册路由）
- Create: `server/internal/account/passkey_register.go`
- Create: `server/internal/account/passkey_register_test.go`

**Interfaces:**
- Consumes: Task 3 的 ceremony 辅助、`adminRegistrationOpts()`、`requireOrigin`；既有 `matchAdminTOTPStep`、`commitAdminTOTPStep`、`isAdminReq`、`adminLogins`
- Produces:
  - `func (s *Service) verifyAdminCreds(user, pass, code string) (totpStep int64, ok bool)`
  - `POST /admin/passkey/register/begin`（form-encoded：`username`/`password`/`totp`/`name`）
  - `POST /admin/passkey/register/finish`（JSON body 为凭据响应）
  - `POST /admin/passkey/delete`（form-encoded：`id`，重定向回 `/admin`）

- [ ] **Step 1: 写失败测试**

创建 `server/internal/account/passkey_register_test.go`：

```go
package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// step-up 是本功能最重要的安全边界：仅凭已登录会话不得注册新 passkey，
// 否则一次会话 cookie 泄露即可升级为永久后门。
func TestPasskeyRegisterRequiresStepUp(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")

	// 先用密码登录拿到管理员会话
	loginForm := strings.NewReader("username=admin&password=pw")
	lreq, _ := http.NewRequest("POST", srv.URL+"/admin/login", loginForm)
	lreq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	lreq.Header.Set("Origin", s.selfOrigin())
	lresp, err := srv.Client().Do(lreq)
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	lresp.Body.Close()
	var session *http.Cookie
	for _, c := range lresp.Cookies() {
		if c.Name == adminCookie {
			session = c
		}
	}
	if session == nil {
		t.Fatalf("no admin session from password login")
	}

	// 有会话但不带密码 → 必须被拒
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("name=Laptop"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	req.AddCookie(session)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("register/begin succeeded with session only — step-up not enforced")
	}

	// 带正确密码 → 放行
	ok, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=Laptop"))
	ok.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	ok.Header.Set("Origin", s.selfOrigin())
	ok.AddCookie(session)
	okResp, err := srv.Client().Do(ok)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer okResp.Body.Close()
	if okResp.StatusCode != http.StatusOK {
		t.Fatalf("register/begin with correct creds: status=%d want 200", okResp.StatusCode)
	}
}

// 未登录会话根本不能碰注册端点。
func TestPasskeyRegisterRequiresSession(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=Laptop"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatalf("register/begin succeeded without an admin session")
	}
}

// 完整注册往返：begin(step-up) → authenticator → finish → 入库。
func TestPasskeyRegisterEndToEnd(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)

	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name=MacBook"))
	breq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	breq.Header.Set("Origin", s.selfOrigin())
	breq.AddCookie(session)
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&opts)
	bresp.Body.Close()
	cookies := bresp.Cookies()
	if opts.PublicKey.Challenge == "" {
		t.Fatalf("empty challenge")
	}

	rp, _ := s.adminRP()
	auth := newTestAuthenticator(t)
	body := auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/finish",
		strings.NewReader(body))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	freq.AddCookie(session)
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("finish status=%d want 200", fresp.StatusCode)
	}

	rows, err := s.store.ListAdminCredentials(context.Background())
	if err != nil || len(rows) != 1 {
		t.Fatalf("stored %d credentials err=%v, want 1", len(rows), err)
	}
	if rows[0].Name != "MacBook" {
		t.Fatalf("name=%q want MacBook", rows[0].Name)
	}
	if len(rows[0].UserHandle) != 32 {
		t.Fatalf("user handle len=%d want 32", len(rows[0].UserHandle))
	}
}

// 第二枚凭据必须复用同一 user handle。
func TestPasskeyRegisterReusesUserHandle(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "第一台")
	registerViaHTTP(t, srv, s, session, "第二台")

	rows, _ := s.store.ListAdminCredentials(context.Background())
	if len(rows) != 2 {
		t.Fatalf("got %d credentials, want 2", len(rows))
	}
	if string(rows[0].UserHandle) != string(rows[1].UserHandle) {
		t.Fatalf("user handle differs between credentials")
	}
}

// 改掉管理员用户名后，已注册的 passkey 必须仍然可用。
func TestPasskeySurvivesAdminUsernameChange(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")

	before, _ := s.store.AdminUserHandle(context.Background())
	s.cfg.AdminUser = "someone-else"
	user, err := s.loadAdminPasskeyUser(context.Background())
	if err != nil {
		t.Fatalf("load after rename: %v", err)
	}
	if string(user.handle) != string(before) {
		t.Fatalf("user handle changed with admin username")
	}
	if len(user.creds) != 1 {
		t.Fatalf("credentials lost after rename: %d", len(user.creds))
	}
}

// 删除必须要求已登录会话，且成功后凭据消失。
func TestPasskeyDelete(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")
	rows, _ := s.store.ListAdminCredentials(context.Background())
	id := rows[0].ID

	// 无会话 → 拒绝
	noAuth, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/delete",
		strings.NewReader("id="+url.QueryEscape(id)))
	noAuth.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	noAuth.Header.Set("Origin", s.selfOrigin())
	nresp, _ := srv.Client().Do(noAuth)
	nresp.Body.Close()
	rows, _ = s.store.ListAdminCredentials(context.Background())
	if len(rows) != 1 {
		t.Fatalf("credential deleted without a session")
	}

	// 有会话 → 删除
	req, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/delete",
		strings.NewReader("id="+url.QueryEscape(id)))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	req.AddCookie(session)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}
	resp.Body.Close()
	rows, _ = s.store.ListAdminCredentials(context.Background())
	if len(rows) != 0 {
		t.Fatalf("credential still present after delete: %d", len(rows))
	}
}
```

在同一文件的 import 之后补两个辅助：

```go
// adminPasswordLogin logs in through the password path and returns the session cookie.
func adminPasswordLogin(t *testing.T, srv *httptest.Server, s *Service) *http.Cookie {
	t.Helper()
	req, _ := http.NewRequest("POST", srv.URL+"/admin/login",
		strings.NewReader("username=admin&password=pw"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", s.selfOrigin())
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("password login: %v", err)
	}
	defer resp.Body.Close()
	for _, c := range resp.Cookies() {
		if c.Name == adminCookie {
			return c
		}
	}
	t.Fatalf("no admin session cookie")
	return nil
}

// registerViaHTTP drives a full register begin+finish through the HTTP endpoints.
func registerViaHTTP(t *testing.T, srv *httptest.Server, s *Service, session *http.Cookie, name string) {
	t.Helper()
	breq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/begin",
		strings.NewReader("username=admin&password=pw&name="+url.QueryEscape(name)))
	breq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	breq.Header.Set("Origin", s.selfOrigin())
	breq.AddCookie(session)
	bresp, err := srv.Client().Do(breq)
	if err != nil {
		t.Fatalf("register begin: %v", err)
	}
	var opts struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	json.NewDecoder(bresp.Body).Decode(&opts)
	cookies := bresp.Cookies()
	bresp.Body.Close()

	rp, _ := s.adminRP()
	auth := newTestAuthenticator(t)
	freq, _ := http.NewRequest("POST", srv.URL+"/admin/passkey/register/finish",
		strings.NewReader(auth.registerBody(t, rp.Config.RPID, s.selfOrigin(), opts.PublicKey.Challenge)))
	freq.Header.Set("Content-Type", "application/json")
	freq.Header.Set("Origin", s.selfOrigin())
	freq.AddCookie(session)
	for _, c := range cookies {
		freq.AddCookie(c)
	}
	fresp, err := srv.Client().Do(freq)
	if err != nil {
		t.Fatalf("register finish: %v", err)
	}
	defer fresp.Body.Close()
	if fresp.StatusCode != http.StatusOK {
		t.Fatalf("register finish %q: status=%d", name, fresp.StatusCode)
	}
}
```

导入需含 `net/http/httptest`。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd server && go test ./internal/account/ -run TestPasskeyRegister 2>&1 | tail -20
```

预期：404 或编译失败（端点不存在）。

- [ ] **Step 3: 抽出 verifyAdminCreds**

在 `server/internal/account/admin.go` 中新增：

```go
// verifyAdminCreds runs the constant-time username/password comparison plus the
// TOTP match shared by password login and passkey-registration step-up. It does
// NOT consume the TOTP step; callers commit it only after full success.
func (s *Service) verifyAdminCreds(user, pass, code string) (totpStep int64, ok bool) {
	userOK := subtle.ConstantTimeCompare([]byte(user), []byte(s.adminUser()))
	passOK := subtle.ConstantTimeCompare([]byte(pass), []byte(s.cfg.AdminPassword))
	credsOK := userOK&passOK == 1
	step, totpOK := int64(0), true
	if s.AdminTOTPEnabled() {
		step, totpOK = s.matchAdminTOTPStep(code)
	}
	return step, credsOK && totpOK
}
```

改写 `handleAdminLogin`（`admin.go:236-251`）中间那段为：

```go
	totpStep, ok := s.verifyAdminCreds(
		r.FormValue("username"), r.FormValue("password"), r.FormValue("totp"))
	if !ok {
		s.adminLogins.recordFail(ip, s.now())
		s.renderAdminLogin(w, http.StatusUnauthorized, "账号、密码或验证码错误")
		return
	}
```

保持其后的 `commitAdminTOTPStep` / `reset` / 种 cookie 逻辑不变。

```bash
cd server && go test ./internal/account/ -run 'TestAdmin|TestTOTP' 2>&1 | tail -20
```

预期：既有登录与 TOTP 测试仍全绿（证明重构未改变行为）。

- [ ] **Step 4: 实现注册与删除端点**

创建 `server/internal/account/passkey_register.go`：

```go
package account

import (
	"crypto/rand"
	"encoding/json"
	"net/http"
)

// handleAdminPasskeyRegisterBegin gates registration behind a fresh password +
// TOTP check on top of the existing session. A writable credential table is a
// permanent backdoor if a leaked session alone can add to it; registration is
// rare enough that the extra prompt costs nothing.
func (s *Service) handleAdminPasskeyRegisterBegin(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "未登录"})
		return
	}
	ip := s.clientIP(r)
	if s.adminLogins.locked(ip, s.now()) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "尝试过于频繁，请稍后再试"})
		return
	}
	step, ok := s.verifyAdminCreds(
		r.FormValue("username"), r.FormValue("password"), r.FormValue("totp"))
	if !ok {
		s.adminLogins.recordFail(ip, s.now())
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "账号、密码或验证码错误"})
		return
	}
	if s.AdminTOTPEnabled() {
		s.commitAdminTOTPStep(step)
	}
	s.adminLogins.reset(ip)

	rp, err := s.adminRP()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	user, err := s.loadAdminPasskeyUser(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "读取凭据失败"})
		return
	}
	// First registration mints the handle; later ones reuse it so all passkeys
	// belong to one WebAuthn user.
	if len(user.handle) == 0 {
		h := make([]byte, 32)
		if _, err := rand.Read(h); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "生成标识失败"})
			return
		}
		user.handle = h
	}
	name := r.FormValue("name")
	if name == "" {
		name = "未命名设备"
	}
	creation, sess, err := rp.BeginRegistration(user, adminRegistrationOpts()...)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "无法发起注册"})
		return
	}
	s.putCeremony(w, *sess, name)
	writeJSON(w, http.StatusOK, creation)
}

func (s *Service) handleAdminPasskeyRegisterFinish(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "未登录"})
		return
	}
	cer, ok := s.takeCeremony(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "注册已过期，请重试"})
		return
	}
	rp, err := s.adminRP()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "passkey 未正确配置"})
		return
	}
	user, err := s.loadAdminPasskeyUser(r.Context())
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "读取凭据失败"})
		return
	}
	// The handle minted at begin lives in the ceremony's SessionData, which is
	// the authoritative copy for this ceremony.
	user.handle = cer.session.UserID

	cred, err := rp.FinishRegistration(user, cer.session, r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "注册验证失败"})
		return
	}
	blob, err := json.Marshal(cred)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "序列化失败"})
		return
	}
	err = s.store.InsertAdminCredential(r.Context(), AdminCredential{
		ID: b64url(cred.ID), UserHandle: user.handle, CredJSON: blob,
		Name: cer.name, CreatedAt: s.now().Unix(),
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存失败"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleAdminPasskeyDelete is a plain form post (no JS) like the other admin
// mutations. No step-up: deleting can only lock the operator out, and the
// password path remains as the way back in.
func (s *Service) handleAdminPasskeyDelete(w http.ResponseWriter, r *http.Request) {
	if !s.isAdminReq(r) {
		http.Redirect(w, r, "/admin", http.StatusFound)
		return
	}
	if id := r.FormValue("id"); id != "" {
		_ = s.store.DeleteAdminCredential(r.Context(), id)
	}
	http.Redirect(w, r, "/admin", http.StatusFound)
}
```

- [ ] **Step 5: 注册路由**

在 `RegisterAdmin` 内的 passkey 登录路由之后加：

```go
	mux.Handle("POST /admin/passkey/register/begin",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminPasskeyRegisterBegin))))
	mux.Handle("POST /admin/passkey/register/finish",
		s.csrfGuard(s.requireOrigin(http.HandlerFunc(s.handleAdminPasskeyRegisterFinish))))
	mux.Handle("POST /admin/passkey/delete",
		s.csrfGuard(http.HandlerFunc(s.handleAdminPasskeyDelete)))
```

删除端点是普通表单提交（非 fetch），故不挂 `requireOrigin`。

- [ ] **Step 6: 跑测试确认通过**

```bash
cd server && go test ./internal/account/ -run TestPasskey -v 2>&1 | tail -35
```

预期：全部 PASS，特别是 `TestPasskeyRegisterRequiresStepUp` 与 `TestPasskeySurvivesAdminUsernameChange`。

- [ ] **Step 7: 全量测试**

```bash
cd server && go test ./... 2>&1 | tail -20
```

预期：全部 ok。

- [ ] **Step 8: 提交**

```bash
cd server && git add -A internal/account/
git commit -m "feat(admin): passkey 注册（step-up 重验密码+TOTP）与删除端点

抽出 verifyAdminCreds 供密码登录与 step-up 共用。
首枚凭据铸 user handle，后续复用，与管理员用户名解耦。"
```

---

### Task 5: 前端（登录页按钮与设置页管理区块）

**Files:**
- Modify: `server/internal/account/admin_templates.go:59-84`（`adminLoginData` + `adminLoginTmpl`）
- Modify: `server/internal/account/admin_templates.go`（`adminHomeData` + `adminUsersTmpl` 新增 passkey 区块）
- Modify: `server/internal/account/admin.go:704`（`renderAdminLogin` 签名）与其 3 处调用点（`admin.go:231`、`:249`、`:410`）
- Modify: `server/internal/account/admin.go`（`buildAdminHomeData` 填充 passkey 列表）
- Create: `server/internal/account/passkey_template_test.go`

**Interfaces:**
- Consumes: Task 2 的 `adminPasskeyCount()`；Task 1 的 `ListAdminCredentials`
- Produces:
  - `adminLoginData` 新增字段 `Passkey bool`
  - `renderAdminLogin(w http.ResponseWriter, status int, errMsg string, passkey bool)`
  - `adminHomeData` 新增字段 `Passkeys []AdminCredential`

- [ ] **Step 1: 写失败测试**

创建 `server/internal/account/passkey_template_test.go`：

```go
package account

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func fetchAdminLogin(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	resp, err := srv.Client().Get(srv.URL + "/admin")
	if err != nil {
		t.Fatalf("get /admin: %v", err)
	}
	defer resp.Body.Close()
	b := new(strings.Builder)
	if _, err := b.ReadFrom(resp.Body); err != nil {
		t.Fatalf("read: %v", err)
	}
	return b.String()
}

// 没有注册任何 passkey 时不得渲染 passkey 按钮：点了只会得到
// 「无可用凭据」，等于给一条死路。
func TestLoginPageHidesPasskeyButtonWhenNoneRegistered(t *testing.T) {
	srv, _ := newAdminServer(t, "admin", "pw")
	html := fetchAdminLogin(t, srv)
	if strings.Contains(html, "passkey-login") {
		t.Fatalf("passkey button rendered with zero credentials registered")
	}
	// 密码表单必须在
	if !strings.Contains(html, `name="password"`) {
		t.Fatalf("password form missing")
	}
}

// 注册后按钮出现，但密码表单必须原样保留（渐进增强，绝不砸旧路径）。
func TestLoginPageShowsPasskeyButtonAndKeepsPasswordForm(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "MacBook")

	html := fetchAdminLogin(t, srv)
	if !strings.Contains(html, "passkey-login") {
		t.Fatalf("passkey button missing after registration")
	}
	if !strings.Contains(html, `name="password"`) {
		t.Fatalf("password form disappeared — progressive enhancement broken")
	}
	if !strings.Contains(html, `name="username"`) {
		t.Fatalf("username field disappeared")
	}
}

// 设置页必须列出已注册凭据及其名字。
func TestAdminHomeListsPasskeys(t *testing.T) {
	srv, s := newAdminServer(t, "admin", "pw")
	session := adminPasswordLogin(t, srv, s)
	registerViaHTTP(t, srv, s, session, "我的-MacBook")

	req, _ := http.NewRequest("GET", srv.URL+"/admin", nil)
	req.AddCookie(session)
	resp, err := srv.Client().Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	b := new(strings.Builder)
	b.ReadFrom(resp.Body)
	if !strings.Contains(b.String(), "我的-MacBook") {
		t.Fatalf("registered passkey not listed on admin home")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd server && go test ./internal/account/ -run 'TestLoginPage|TestAdminHomeListsPasskeys' 2>&1 | tail -20
```

预期：FAIL（按钮与列表都不存在）。

- [ ] **Step 3: 改 renderAdminLogin 与 adminLoginData**

`admin_templates.go` 中：

```go
type adminLoginData struct {
	Error   string
	TOTP    bool // render the 6-digit code field
	Passkey bool // render the passkey button (only when a credential exists)
}
```

`admin.go:704`：

```go
func (s *Service) renderAdminLogin(w http.ResponseWriter, status int, errMsg string, passkey bool) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_ = adminLoginTmpl.Execute(w, adminLoginData{
		Error: errMsg, TOTP: s.AdminTOTPEnabled(), Passkey: passkey,
	})
}
```

三处调用点改为传入实际数量：
- `admin.go:231`：`s.renderAdminLogin(w, http.StatusTooManyRequests, "尝试过于频繁，请稍后再试", s.adminPasskeyCount(r.Context()) > 0)`
- `admin.go:249`：`s.renderAdminLogin(w, http.StatusUnauthorized, "账号、密码或验证码错误", s.adminPasskeyCount(r.Context()) > 0)`
- `admin.go:410`：`s.renderAdminLogin(w, http.StatusOK, "", s.adminPasskeyCount(r.Context()) > 0)`

- [ ] **Step 4: 改登录模板**

在 `adminLoginTmpl` 的 `</form>` 之后、`</body>` 之前插入：

```html
{{if .Passkey}}
<button type="button" id="passkey-login" style="margin-top:12px;background:transparent;color:var(--a);border:1px solid var(--bd)">使用 passkey 登录</button>
<p class="err" id="passkey-error" hidden></p>
<script>
(function(){
  var btn = document.getElementById('passkey-login');
  var err = document.getElementById('passkey-error');
  // Progressive enhancement: on anything without WebAuthn the button vanishes
  // and the password form above is untouched.
  if (!window.PublicKeyCredential || !navigator.credentials) { btn.hidden = true; return; }
  function dec(s){
    s = s.replace(/-/g,'+').replace(/_/g,'/');
    var pad = s.length % 4 ? '='.repeat(4 - s.length % 4) : '';
    var bin = atob(s + pad), out = new Uint8Array(bin.length);
    for (var i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function enc(buf){
    var b = new Uint8Array(buf), s = '';
    for (var i=0;i<b.length;i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  btn.addEventListener('click', function(){
    err.hidden = true; btn.disabled = true;
    fetch('/admin/passkey/login/begin', {method:'POST'})
      .then(function(r){ if(!r.ok) throw new Error('服务器错误 ' + r.status); return r.json(); })
      .then(function(o){
        var pk = o.publicKey;
        pk.challenge = dec(pk.challenge);
        if (pk.allowCredentials) pk.allowCredentials.forEach(function(c){ c.id = dec(c.id); });
        return navigator.credentials.get({publicKey: pk});
      })
      .then(function(c){
        return fetch('/admin/passkey/login/finish', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            id: c.id, rawId: enc(c.rawId), type: c.type,
            response: {
              clientDataJSON: enc(c.response.clientDataJSON),
              authenticatorData: enc(c.response.authenticatorData),
              signature: enc(c.response.signature),
              userHandle: c.response.userHandle ? enc(c.response.userHandle) : null
            }
          })
        });
      })
      .then(function(r){
        if (r.ok) { location.href = '/admin'; return; }
        return r.json().then(function(j){ throw new Error(j.error || '验证失败'); });
      })
      .catch(function(e){
        btn.disabled = false;
        // Cancelling the platform prompt is a normal action, not an error.
        if (e && e.name === 'NotAllowedError') return;
        err.textContent = e.message || '登录失败';
        err.hidden = false;
      });
  });
})();
</script>
{{end}}
```

- [ ] **Step 5: 设置页列表与添加流程**

`adminHomeData` 增加字段：

```go
	// Passkeys are the registered admin credentials, listed so a never-used
	// entry (an attacker's planted credential) is visible.
	Passkeys []AdminCredential
```

`buildAdminHomeData`（`admin.go:281`）没有中间变量，直接在末尾的 `return adminHomeData{...}`（`admin.go:387`）之前取值：

```go
	// A passkey that was never used is how a planted credential shows itself,
	// so the list is part of the security surface, not just a convenience.
	passkeys, err := s.store.ListAdminCredentials(r.Context())
	if err != nil {
		return adminHomeData{}, err
	}
```

再在该 composite literal 的字段列表中加一行 `Passkeys: passkeys,`。

在 `adminUsersTmpl` 中新增一个区块（放在设置区块附近，沿用页面既有 card/table 样式类）：

```html
<h2>Passkey</h2>
<table>
<tr><th>名称</th><th>添加时间</th><th>最后使用</th><th></th></tr>
{{range .Passkeys}}
<tr>
  <td>{{.Name}}</td>
  <td>{{ts .CreatedAt}}</td>
  <td>{{if .LastUsedAt}}{{ts .LastUsedAt}}{{else}}从未使用{{end}}</td>
  <td><form method="post" action="/admin/passkey/delete" onsubmit="return confirm('删除这枚 passkey？')">
    <input type="hidden" name="id" value="{{.ID}}"><button type="submit">删除</button></form></td>
</tr>
{{else}}
<tr><td colspan="4">尚未添加 passkey</td></tr>
{{end}}
</table>
<form id="passkey-add" onsubmit="return false">
  <input type="text" name="name" placeholder="设备名称，如 MacBook" required>
  <input type="text" name="username" placeholder="管理员账号" autocomplete="username" required>
  <input type="password" name="password" placeholder="管理员密码" autocomplete="current-password" required>
  <input type="text" name="totp" placeholder="6 位验证码（如已启用）" inputmode="numeric" autocomplete="one-time-code">
  <button type="submit">添加 passkey</button>
</form>
<p class="err" id="passkey-add-error" hidden></p>
<script>
(function(){
  var form = document.getElementById('passkey-add');
  var err = document.getElementById('passkey-add-error');
  if (!window.PublicKeyCredential || !navigator.credentials) { form.hidden = true; return; }
  function dec(s){
    s = s.replace(/-/g,'+').replace(/_/g,'/');
    var pad = s.length % 4 ? '='.repeat(4 - s.length % 4) : '';
    var bin = atob(s + pad), out = new Uint8Array(bin.length);
    for (var i=0;i<bin.length;i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function enc(buf){
    var b = new Uint8Array(buf), s = '';
    for (var i=0;i<b.length;i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  form.addEventListener('submit', function(){
    err.hidden = true;
    fetch('/admin/passkey/register/begin', {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams(new FormData(form)).toString()
    })
      .then(function(r){
        if (r.ok) return r.json();
        return r.json().then(function(j){ throw new Error(j.error || '验证失败'); });
      })
      .then(function(o){
        var pk = o.publicKey;
        pk.challenge = dec(pk.challenge);
        pk.user.id = dec(pk.user.id);
        if (pk.excludeCredentials) pk.excludeCredentials.forEach(function(c){ c.id = dec(c.id); });
        return navigator.credentials.create({publicKey: pk});
      })
      .then(function(c){
        return fetch('/admin/passkey/register/finish', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            id: c.id, rawId: enc(c.rawId), type: c.type,
            response: {
              clientDataJSON: enc(c.response.clientDataJSON),
              attestationObject: enc(c.response.attestationObject)
            }
          })
        });
      })
      .then(function(r){
        if (r.ok) { location.reload(); return; }
        return r.json().then(function(j){ throw new Error(j.error || '注册失败'); });
      })
      .catch(function(e){
        if (e && e.name === 'NotAllowedError') return;
        err.textContent = e.message || '注册失败';
        err.hidden = false;
      });
  });
})();
</script>
```

`ts` 模板函数已存在于 `adminUsersTmpl` 的 `FuncMap`（`admin_templates.go:87`）。

- [ ] **Step 6: 跑测试确认通过**

```bash
cd server && go test ./internal/account/ -run 'TestLoginPage|TestAdminHomeListsPasskeys' -v 2>&1 | tail -20
```

预期：3 个测试 PASS。

- [ ] **Step 7: 确认 CSP 不会拦掉内联脚本**

```bash
cd server && go build ./... && echo BUILD_OK
```

然后确认 `/admin` 是否被 `spa.go` 的 CSP 中间件覆盖：

```bash
cd server && grep -n "contentSecurityPolicy\|securityHeaders" spa.go main.go | head -20
```

若 `/admin` 经过该中间件，确认 CSP 含 `script-src 'self' 'unsafe-inline'`（`spa.go:23` 当前即是），内联脚本可执行；若不经过，则无 CSP 限制。两种情况都无需改动——**但必须实际确认一次并在提交信息中写明结论**。

- [ ] **Step 8: 全量测试**

```bash
cd server && go test ./... 2>&1 | tail -20
```

预期：全部 ok。

- [ ] **Step 9: 提交**

```bash
cd server && git add -A internal/account/
git commit -m "feat(admin): 登录页 passkey 按钮与后台凭据管理区块

渐进增强：无 WebAuthn/无 JS 时按钮隐藏，密码表单完全不受影响。
零凭据时不渲染按钮，避免把用户导向死路。
列出最后使用时间，使从未使用过的可疑凭据可见。"
```

---

### Task 6: CDP 虚拟 authenticator 端到端验证（收尾，可独立跳过）

前五个任务已用 Go 测试覆盖全部安全关键面。本任务补的是浏览器里那段 JS 的真实路径。**若 CDP 比预期棘手，不要阻塞前面的成果——记录问题并转手工验证即可。**

**Files:**
- Create: `docs/TESTING-passkey.md`

- [ ] **Step 1: 起服务**

```bash
cd server && go build -o /tmp/relayium-passkey ./ && \
RELAYIUM_ADMIN_PASS=testpw /tmp/relayium-passkey -addr 127.0.0.1:8099 -base-url http://localhost:8099 -db /tmp/passkey-test.db
```

保持前台运行，另开终端继续。

- [ ] **Step 2: 用 CDP 虚拟 authenticator 跑一遍**

沿用 `docs/TESTING.md` 的 CDP 手法，启动带远程调试端口的 Chrome：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/passkey-chrome \
  http://localhost:8099/admin
```

在 CDP 会话中启用虚拟 authenticator（需 `WebAuthn.enable` 后 `WebAuthn.addVirtualAuthenticator`，参数 `{protocol:"ctap2", transport:"internal", hasResidentKey:true, hasUserVerification:true, isUserVerified:true}`）。

- [ ] **Step 3: 走一遍完整流程并记录**

1. 密码登录（`admin` / `testpw`）
2. 在设置页添加 passkey（step-up 输同一组凭据）
3. 登出
4. 登录页点「使用 passkey 登录」→ 应直接进入后台
5. 在设置页删除该 passkey → 登录页按钮应消失

把每一步的实际结果与 CDP 命令写进 `docs/TESTING-passkey.md`。

- [ ] **Step 4: 手工验证清单（机器覆盖不了）**

在 `docs/TESTING-passkey.md` 末尾记录以下项的实测结果：

- 真机 Touch ID 登录
- 真机 Face ID 登录（iPhone）
- 手机跨设备扫码登录
- 浏览器禁用 JS 后，密码 + TOTP 表单仍可正常登录

- [ ] **Step 5: 清理并提交**

```bash
rm -f /tmp/relayium-passkey /tmp/passkey-test.db && rm -rf /tmp/passkey-chrome
git add docs/TESTING-passkey.md
git commit -m "docs: passkey 端到端验证步骤与手工验证清单"
```

---

## 完成后

全部任务结束后跑一次完整验证：

```bash
cd server && go test ./... && go vet ./... && cd ../web && npx vitest run && npm run check
```

预期：Go 全绿、vet 无输出、web 测试与检查通过（web 未改动，此处只为确认未误伤）。

部署前确认产线 `RELAYIUM_ADMIN_PASS` 与 `RELAYIUM_ADMIN_TOTP_SECRET` 仍配置正常——passkey 是新增通道，密码后备必须保持可用。首次部署后**先注册一枚 passkey 再登出**，避免在没有任何凭据的情况下反复走密码流程。
