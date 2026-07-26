# CLI Pairing Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `relayium send <file>` mint its own pairing code with the CLI's bearer token, so a CLI-only user can complete a cross-network transfer without a browser.

**Architecture:** `POST /api/pair` currently resolves its caller with a hand-written cookie-only closure in `main.go`, while the CLI authenticates with a bearer token — so no CLI user can obtain a code. `account/auth.go` already resolves cookie-or-bearer but only as a wrapper; extract that resolution, point `/api/pair` at it, add a `MintPair` call to the CLI's cloud client, and mint automatically when `send` is given no code.

**Tech Stack:** Go 1.26.3, `net/http` + `net/http/httptest`, SQLite store (`account.OpenSQLite`), `coder/websocket`. Module path `github.com/relayium/relayium`, rooted at `server/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-cli-pairing-code-design.md`.
- `send`/`receive` are CLI↔CLI only. Do **not** add WebRTC, TURN, or any browser-interop path; a browser recipient is `relayium up`'s job.
- Pairing codes are 6 characters over `ACDEFHJKMNPRTWXY23456789` with a 5-minute TTL. Never hard-code the alphabet or the length in new code — use `signal.ValidCodeFormat`, `signal.CodeLen`, `signal.CodeAlphabet`.
- Minting stays account-attributed and rate-limited exactly as today: owner recorded, 10/min/IP. No new limiter, no new TTL.
- `send` must never start an interactive login. The target environment is servers and CI, where blocking on a browser approval hangs a job.
- Never send the access token to a server other than the one that issued it. Guard with the existing `sameServer` (`cmd/relayium/cloud.go:21-25`).
- All commands run from `server/`.

---

### Task 1: Export the cookie-or-bearer resolution

**Files:**
- Modify: `server/account/auth.go:16-42`
- Test: `server/account/auth_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `func (s *Service) UserFromAuth(r *http.Request) (User, bool)` — returns the authenticated user and true, or the zero `User` and false. Task 2 consumes it.

- [ ] **Step 1: Write the failing test**

Append to `server/account/auth_test.go`:

```go
// TestUserFromAuthResolvesBothCredentials pins the resolution RequireAuth is
// built on, now that a root-mux handler (POST /api/pair) needs the user without
// the wrapper's 401-and-stop behaviour. The frozen-account case is the one that
// must not be lost in the extraction: a pending-delete account keeps its
// cli_tokens row, and only this guard stops it from minting.
func TestUserFromAuthResolvesBothCredentials(t *testing.T) {
	s, _ := newTestService(t)
	ctx := context.Background()
	u, err := s.store.UpsertUserByEmail(ctx, "resolve@example.com", "")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	raw := "rlm_cli_" + authx.RandToken()
	dev, err := s.store.UpsertDevice(ctx, Device{ID: authx.NewID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatalf("upsert device: %v", err)
	}
	if err := s.store.CreateCLIToken(ctx, CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}

	req := httptest.NewRequest("GET", "/x", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	got, ok := s.UserFromAuth(req)
	if !ok || got.ID != u.ID {
		t.Fatalf("bearer: ok=%v id=%q want %q", ok, got.ID, u.ID)
	}

	if _, ok := s.UserFromAuth(httptest.NewRequest("GET", "/x", nil)); ok {
		t.Fatal("no credentials should not resolve a user")
	}

	bad := httptest.NewRequest("GET", "/x", nil)
	bad.Header.Set("Authorization", "Bearer rlm_cli_nope")
	if _, ok := s.UserFromAuth(bad); ok {
		t.Fatal("unknown bearer should not resolve a user")
	}

	if err := s.store.SetAccountDeletion(ctx, u.ID, s.now().Unix(), s.now().Unix()+100); err != nil {
		t.Fatalf("schedule deletion: %v", err)
	}
	frozen := httptest.NewRequest("GET", "/x", nil)
	frozen.Header.Set("Authorization", "Bearer "+raw)
	if _, ok := s.UserFromAuth(frozen); ok {
		t.Fatal("frozen account should not resolve a user")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./account/ -run TestUserFromAuthResolvesBothCredentials`
Expected: FAIL — `s.UserFromAuth undefined (type *Service has no field or method UserFromAuth)`

- [ ] **Step 3: Write the implementation**

Replace the body of `server/account/auth.go` (keep the package clause and imports):

```go
// UserFromAuth resolves the caller as an authenticated User from EITHER the
// session cookie (browser) OR an "Authorization: Bearer rlm_cli_…" header (CLI
// token, Task 5's cli_tokens table). A valid bearer touches the token's
// last_seen_at.
//
// RequireAuth is the wrapper form. This is the same resolution exposed to
// handlers mounted on the ROOT mux — POST /api/pair — which need the user
// without the wrapper's 401-and-stop behaviour.
func (s *Service) UserFromAuth(r *http.Request) (User, bool) {
	if u, ok := s.UserFromRequest(r); ok { // session cookie
		return u, true
	}
	const bearerPrefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, bearerPrefix) {
		return User{}, false
	}
	raw := strings.TrimSpace(h[len(bearerPrefix):])
	hash := authx.HashToken(raw)
	uid, _, ok, err := s.store.GetCLITokenUser(r.Context(), hash)
	if err != nil || !ok {
		return User{}, false
	}
	u, gerr := s.store.GetUserByID(r.Context(), uid)
	// Mirror the cookie path's central frozen-account guard (ValidateSession
	// rejects DeletedAt>0): a pending-delete/frozen account must not keep
	// CLI/API access via a bearer token either.
	if gerr != nil || u.DeletedAt != 0 {
		return User{}, false
	}
	_ = s.store.TouchCLIToken(r.Context(), hash, s.now().Unix())
	return u, true
}

// RequireAuth wraps a handler, resolving the caller with UserFromAuth and
// 401ing when it cannot. This is a superset of RequireSession: cookie-based
// tests/behavior are unaffected, and CLI callers reach the same endpoints with
// a bearer token instead of a cookie.
func (s *Service) RequireAuth(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := s.UserFromAuth(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next(w, r, u)
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./account/`
Expected: PASS. `TestRequireAuthBearer` must still pass untouched — it is the regression guard for the 10 endpoints already using the wrapper.

- [ ] **Step 5: Commit**

```bash
git add server/account/auth.go server/account/auth_test.go
git commit -m "refactor(account): export UserFromAuth, rebuild RequireAuth on it"
```

---

### Task 2: Let `/api/pair` accept the CLI bearer

**Files:**
- Modify: `server/main.go:439-443`
- Create: `server/pairuser.go`
- Test: `server/pairuser_test.go`

**Interfaces:**
- Consumes: `account.Service.UserFromAuth` (Task 1).
- Produces: `func pairUser(acct *account.Service) func(*http.Request) (string, bool)` — the resolver `signal.PairHandler` takes as its `currentUser` argument.

Why a named function in package `main` rather than the inline closure: this is the wiring that decides whether `relayium send` can mint at all, and an inline closure in `main()` cannot be tested. Package `main` already carries tests (`spa_test.go`, `config_test.go`), so the file has a home.

- [ ] **Step 1: Write the failing test**

Create `server/pairuser_test.go`:

```go
package main

import (
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/relayium/relayium/account"
	"github.com/relayium/relayium/authx"
)

// newPairTestService builds a real account.Service on a temp SQLite file — the
// same constructor main() uses — so the resolver is exercised against the real
// store rather than a stub.
func newPairTestService(t *testing.T) *account.Service {
	t.Helper()
	store, err := account.OpenSQLite(filepath.Join(t.TempDir(), "pair.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return account.NewService(store, &account.LogMailer{Log: log.Default()}, account.Config{
		BaseURL:    "http://example.test",
		SessionTTL: time.Hour,
	})
}

// TestPairUserAcceptsCLIBearer is the regression for the reason a CLI user
// could not obtain a pairing code at all: /api/pair resolved its caller from
// the session cookie only, and the CLI has a bearer token.
func TestPairUserAcceptsCLIBearer(t *testing.T) {
	svc := newPairTestService(t)
	ctx := context.Background()
	u, err := svc.Store().UpsertUserByEmail(ctx, "cli@example.com", "")
	if err != nil {
		t.Fatalf("upsert user: %v", err)
	}
	raw := "rlm_cli_" + authx.RandToken()
	dev, err := svc.Store().UpsertDevice(ctx, account.Device{ID: authx.NewID(), UserID: u.ID, Name: "cli", Kind: "cli", CreatedAt: 1})
	if err != nil {
		t.Fatalf("upsert device: %v", err)
	}
	if err := svc.Store().CreateCLIToken(ctx, account.CLIToken{TokenHash: authx.HashToken(raw), UserID: u.ID, DeviceID: dev.ID, CreatedAt: 1}); err != nil {
		t.Fatalf("create cli token: %v", err)
	}

	resolve := pairUser(svc)

	req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
	req.Header.Set("Authorization", "Bearer "+raw)
	got, ok := resolve(req)
	if !ok || got != u.ID {
		t.Fatalf("bearer: ok=%v id=%q want %q", ok, got, u.ID)
	}

	if _, ok := resolve(httptest.NewRequest(http.MethodPost, "/api/pair", nil)); ok {
		t.Fatal("anonymous request must not resolve an owner")
	}
}
```

`account.Service.Store()` already exists (`server/account/service.go:333`) and `*SQLiteStore` has `Close()` (`server/account/sqlite.go:958`), so the harness above compiles as written — no new accessor is needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test . -run TestPairUserAcceptsCLIBearer`
Expected: FAIL — `undefined: pairUser`

- [ ] **Step 3: Write the implementation**

Create `server/pairuser.go`:

```go
package main

import (
	"net/http"

	"github.com/relayium/relayium/account"
)

// pairUser resolves the owner of a POST /api/pair request. Minting is
// account-attributed (the owner is billed for the transfer's relay usage), but
// the CLI authenticates with a bearer token rather than a session cookie — so
// this must accept both, which account.UserFromAuth does.
//
// Until this existed the endpoint read the session cookie only, which meant no
// CLI user could obtain a pairing code by any route: `relayium send <file>
// <code>` had no reachable happy path.
func pairUser(acct *account.Service) func(*http.Request) (string, bool) {
	return func(r *http.Request) (string, bool) {
		u, ok := acct.UserFromAuth(r)
		return u.ID, ok
	}
}
```

Then in `server/main.go`, replace lines 439-443:

```go
		mux.HandleFunc("POST /api/pair", signal.PairHandler(pairReg, pairLimiter, ipx, pairUser(acct)))
```

Keep the existing comment above it, amending the last sentence to note that minting accepts a session cookie or a CLI bearer.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test . ./account/ ./internal/signal/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/pairuser.go server/pairuser_test.go server/main.go
git commit -m "fix(pair): accept the CLI bearer token when minting a pairing code"
```

---

### Task 3: `MintPair` on the CLI's cloud client

**Files:**
- Create: `server/internal/cloud/pair.go`
- Modify: `server/internal/cloud/login.go:85-113` (postJSON)
- Test: `server/internal/cloud/pair_test.go`

**Interfaces:**
- Consumes: `Client.postJSON` (existing, unexported).
- Produces:
  - `type Pair struct { Code string; ExpiresAt int64 }`
  - `func (c *Client) MintPair(ctx context.Context) (Pair, error)`
  - `type HTTPError struct { Path string; Status int; Body string }` with `Error() string` — returned by `postJSON` for any non-2xx, so callers can distinguish 401 from 429. Task 5 matches on it with `errors.As`.

- [ ] **Step 1: Write the failing test**

Create `server/internal/cloud/pair_test.go`:

```go
package cloud

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMintPairSendsBearerAndReturnsCode(t *testing.T) {
	var gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":"K7M4XR","expiresAt":1900000000}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_abc"
	p, err := c.MintPair(context.Background())
	if err != nil {
		t.Fatalf("MintPair: %v", err)
	}
	if p.Code != "K7M4XR" || p.ExpiresAt != 1900000000 {
		t.Fatalf("pair = %+v", p)
	}
	if gotPath != "/api/pair" {
		t.Errorf("path = %q, want /api/pair", gotPath)
	}
	if gotAuth != "Bearer rlm_cli_abc" {
		t.Errorf("Authorization = %q", gotAuth)
	}
}

// The caller must be able to tell "log in again" from "slow down" — a bare
// string error would force it to parse prose.
func TestMintPairSurfacesStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_expired"
	_, err := c.MintPair(context.Background())
	var he *HTTPError
	if !errors.As(err, &he) {
		t.Fatalf("err = %v, want *HTTPError", err)
	}
	if he.Status != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", he.Status)
	}
}

// The server explains a 503 ("could not mint a pairing code, try again" — the
// code space is full, see maxMintAttempts). That sentence is more useful than
// the status number, so it must survive into the error.
func TestMintPairKeepsServerMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "could not mint a pairing code, try again", http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_abc"
	_, err := c.MintPair(context.Background())
	if err == nil || !strings.Contains(err.Error(), "could not mint a pairing code") {
		t.Fatalf("err = %v, want the server's sentence", err)
	}
}

// An empty code is a server bug, not a code: minting it into the UI would print
// a "code" nobody can join (see maxMintAttempts in signal/pair.go).
func TestMintPairRejectsEmptyCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":"","expiresAt":0}`))
	}))
	defer srv.Close()

	c := NewClient(srv.URL)
	c.Token = "rlm_cli_abc"
	if _, err := c.MintPair(context.Background()); err == nil {
		t.Fatal("empty code should be an error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/cloud/ -run TestMintPair`
Expected: FAIL — `c.MintPair undefined`, `undefined: HTTPError`

- [ ] **Step 3: Write the implementation**

Create `server/internal/cloud/pair.go`:

```go
package cloud

import (
	"context"
	"fmt"
)

// Pair is a freshly minted cross-network pairing code and the unix time it
// expires. CLI-side mirror of web/src/lib/transfer-link.ts's createPair.
type Pair struct {
	Code      string
	ExpiresAt int64
}

type pairResponse struct {
	Code      string `json:"code"`
	ExpiresAt int64  `json:"expiresAt"`
}

// MintPair mints a pairing code owned by the logged-in account. It requires
// Token: minting is account-attributed, while joining a code's room stays
// anonymous — only the sender signs in.
func (c *Client) MintPair(ctx context.Context) (Pair, error) {
	var resp pairResponse
	if err := c.postJSON(ctx, "/api/pair", nil, &resp); err != nil {
		return Pair{}, err
	}
	if resp.Code == "" {
		return Pair{}, fmt.Errorf("/api/pair: server returned an empty code")
	}
	return Pair{Code: resp.Code, ExpiresAt: resp.ExpiresAt}, nil
}
```

In `server/internal/cloud/login.go`, add the bearer header inside `postJSON`, right after the Content-Type line:

```go
	req.Header.Set("Content-Type", "application/json")
	// Bearer when we have one. It is empty during device login — start/poll are
	// the calls that obtain the token — where the header is simply omitted.
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}
```

and replace `postJSON`'s non-2xx return with a typed error carrying the server's own sentence:

```go
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// The server states its reason in the body ("could not mint a pairing
		// code, try again"); a bare status number throws that away. Bounded read
		// — the body is remote input, and this goes straight to a terminal.
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return &HTTPError{Path: path, Status: resp.StatusCode, Body: strings.TrimSpace(string(b))}
	}
```

Add `io` and `strings` to `login.go`'s imports.

Add to `server/internal/cloud/pair.go`:

```go
// HTTPError carries the status and message of a failed API call so a caller can
// tell "log in again" (401) from "slow down" (429) without parsing prose, and
// can still show the operator what the server actually said.
type HTTPError struct {
	Path   string
	Status int
	Body   string
}

func (e *HTTPError) Error() string {
	if e.Body != "" {
		return fmt.Sprintf("%s: %s (HTTP %d)", e.Path, e.Body, e.Status)
	}
	return fmt.Sprintf("%s: unexpected status %d", e.Path, e.Status)
}
```

No existing test asserts on the old message text (verified by grep), so the richer form breaks nothing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./internal/cloud/`
Expected: PASS — including the existing device-login tests, which exercise `postJSON` with an empty Token.

- [ ] **Step 5: Commit**

```bash
git add server/internal/cloud/pair.go server/internal/cloud/pair_test.go server/internal/cloud/login.go
git commit -m "feat(cloud): MintPair client call and a typed HTTP status error"
```

---

### Task 4: Decide whether the last argument is a code

**Files:**
- Modify: `server/cmd/relayium/crossnet.go:86-118`
- Test: `server/cmd/relayium/crossnet_test.go`

**Interfaces:**
- Consumes: `signal.ValidCodeFormat` (existing).
- Produces: `func splitSendArgs(args []string) (srcs []string, code string, err error)` — `code == ""` means "mint one". Task 5 consumes it.

The rule: the last argument is a code **iff** it does not exist on disk and is shaped like a code. Both halves are load-bearing — shape alone eats the second file of `send a.zip b.zip`; the disk check alone would misread a file literally named `K7M4XR`. When the last argument is neither an existing file nor a code-shaped string, do not guess: say so, and name both readings.

- [ ] **Step 1: Write the failing test**

Append to `server/cmd/relayium/crossnet_test.go`:

```go
func TestSplitSendArgs(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "a.zip")
	if err := os.WriteFile(real, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A file whose name is also a well-formed pairing code. The file wins.
	coded := filepath.Join(dir, "K7M4XR")
	if err := os.WriteFile(coded, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name     string
		args     []string
		wantSrcs []string
		wantCode string
		wantErr  bool
	}{
		{"single source mints", []string{real}, []string{real}, "", false},
		{"trailing code is a code", []string{real, "K7M4XR"}, []string{real}, "K7M4XR", false},
		{"two sources mint", []string{real, real}, []string{real, real}, "", false},
		{"code-named file stays a source", []string{real, coded}, []string{real, coded}, "", false},
		{"neither file nor code errors", []string{real, "726122"}, nil, "", true},
		{"no arguments errors", nil, nil, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srcs, code, err := splitSendArgs(tc.args)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got srcs=%v code=%q", srcs, code)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if code != tc.wantCode {
				t.Errorf("code = %q, want %q", code, tc.wantCode)
			}
			if strings.Join(srcs, "|") != strings.Join(tc.wantSrcs, "|") {
				t.Errorf("srcs = %v, want %v", srcs, tc.wantSrcs)
			}
		})
	}
}

// The user-visible bug that started this: a made-up numeric code must not
// degrade into "no such file", it must explain what a code is.
func TestSplitSendArgsExplainsAMadeUpCode(t *testing.T) {
	_, _, err := splitSendArgs([]string{"pando_uu.zip", "726122"})
	if err == nil {
		t.Fatal("want an error")
	}
	for _, want := range []string{"726122", "pairing code", "relayium send"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}
```

Add `os`, `path/filepath`, and `strings` to the test file's imports if absent.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/relayium/ -run TestSplitSendArgs`
Expected: FAIL — `undefined: splitSendArgs`

- [ ] **Step 3: Write the implementation**

Add to `server/cmd/relayium/crossnet.go`:

```go
// splitSendArgs separates the source paths from an optional trailing pairing
// code. An empty code means "mint one".
//
// The last argument is a code iff it does NOT exist on disk and IS shaped like
// a code. Both halves matter: shape alone would eat the second file of
// `send a.zip b.zip`, and the disk check alone would misread a file genuinely
// named "K7M4XR". When it is neither, guessing either way produces a wrong and
// confusing error ("no such file: 726122" for a mistyped code, "not a valid
// code" for a mistyped filename), so name both readings instead.
func splitSendArgs(args []string) (srcs []string, code string, err error) {
	if len(args) == 0 {
		return nil, "", fmt.Errorf("send needs <src...> [code]")
	}
	last := args[len(args)-1]
	if _, statErr := os.Stat(last); statErr == nil {
		return args, "", nil // a real file wins over a code-shaped name
	}
	if len(args) == 1 {
		return args, "", nil // a lone argument is a source; BuildManifest reports it missing
	}
	if signal.ValidCodeFormat(last) {
		return args[:len(args)-1], last, nil
	}
	return nil, "", fmt.Errorf(
		"last argument %q is neither an existing file nor a pairing code\n"+
			"  codes are %d characters from %s, and last 5 minutes\n"+
			"  to mint one automatically, leave it out:  relayium send %s",
		last, signal.CodeLen, signal.CodeAlphabet, strings.Join(args[:len(args)-1], " "))
}
```

Add `os`, `strings`, and `github.com/relayium/relayium/internal/signal` to `crossnet.go`'s imports.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./cmd/relayium/ -run TestSplitSendArgs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/cmd/relayium/crossnet.go server/cmd/relayium/crossnet_test.go
git commit -m "feat(cli): decide the trailing send argument by disk and by shape"
```

---

### Task 5: Mint on `send`, print the hand-off block

**Files:**
- Create: `server/cmd/relayium/sendpair.go`
- Modify: `server/cmd/relayium/crossnet.go:86-118` (runSendCross)
- Test: `server/cmd/relayium/sendpair_test.go`

**Interfaces:**
- Consumes: `splitSendArgs` (Task 4); `cloud.Client.MintPair`, `cloud.Pair`, `cloud.HTTPError` (Task 3); existing `cloud.Load`, `resolveConfigDir`, `sameServer`, `defaultCloudServer`, `defaultServer`.
- Produces:
  - `func apiBase(server string) (string, error)` — `wss://host` → `https://host`, `ws://host` → `http://host`, trailing slash trimmed.
  - `func mintCode(ctx context.Context, server string, stderr io.Writer) (string, error)` — mints, prints the hand-off block to stderr, returns the code.

- [ ] **Step 1: Write the failing test**

Create `server/cmd/relayium/sendpair_test.go`:

```go
package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/relayium/relayium/internal/cloud"
)

func TestAPIBase(t *testing.T) {
	cases := map[string]string{
		"wss://relayium.com":  "https://relayium.com",
		"ws://localhost:8080": "http://localhost:8080",
		"https://relayium.com/": "https://relayium.com",
	}
	for in, want := range cases {
		got, err := apiBase(in)
		if err != nil {
			t.Fatalf("apiBase(%q): %v", in, err)
		}
		if got != want {
			t.Errorf("apiBase(%q) = %q, want %q", in, got, want)
		}
	}
}

// Minting needs an account, and on a server there is no browser to bounce
// through — so this must fail fast and say what to run, never start a login.
func TestMintCodeNotLoggedIn(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	var errb bytes.Buffer
	_, err := mintCode(context.Background(), "wss://relayium.com", &errb)
	if err == nil {
		t.Fatal("want an error when not logged in")
	}
	for _, want := range []string{"relayium login", "relayium up"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

func TestMintCodePrintsHandoffBlock(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer rlm_cli_abc" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"code":"K7M4XR","expiresAt":4102444800}`))
	}))
	defer srv.Close()

	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: srv.URL, AccessToken: "rlm_cli_abc", AccountEmail: "a@example.com"}); err != nil {
		t.Fatal(err)
	}

	var errb bytes.Buffer
	code, err := mintCode(context.Background(), srv.URL, &errb)
	if err != nil {
		t.Fatalf("mintCode: %v", err)
	}
	if code != "K7M4XR" {
		t.Fatalf("code = %q", code)
	}
	out := errb.String()
	for _, want := range []string{"K7M4XR", "relayium receive K7M4XR", "waiting for the receiver"} {
		if !strings.Contains(out, want) {
			t.Errorf("block %q does not contain %q", out, want)
		}
	}
	// The install one-liner is first-party only: a self-hosted origin has no
	// install.sh, and this test server is one.
	if strings.Contains(out, "install.sh") {
		t.Errorf("install line should be omitted for a non-default server: %q", out)
	}
}

// The access token authenticates to the server that issued it and nowhere else.
func TestMintCodeRefusesForeignServer(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		t.Fatal(err)
	}
	if err := cloud.Save(cfgDir, cloud.Creds{Server: "https://relayium.com", AccessToken: "rlm_cli_abc"}); err != nil {
		t.Fatal(err)
	}
	var errb bytes.Buffer
	_, err = mintCode(context.Background(), "wss://someone-elses-host.example", &errb)
	if err == nil || !strings.Contains(err.Error(), "logged in to https://relayium.com") {
		t.Fatalf("want a server-mismatch refusal, got %v", err)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/relayium/ -run 'TestAPIBase|TestMintCode'`
Expected: FAIL — `undefined: apiBase`, `undefined: mintCode`

- [ ] **Step 3: Write the implementation**

Create `server/cmd/relayium/sendpair.go`:

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relayium/relayium/internal/cloud"
)

// apiBase turns the crossnet --server URL (a wss:// signaling base) into the
// HTTP base the account API lives on, so a self-hoster passes one flag rather
// than two.
func apiBase(server string) (string, error) {
	u, err := url.Parse(server)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "wss":
		u.Scheme = "https"
	case "ws":
		u.Scheme = "http"
	}
	return strings.TrimRight(u.String(), "/"), nil
}

// errNotLoggedIn is the copy for "minting needs an account". It never starts a
// login: `send` runs on servers and in CI, where blocking on a browser approval
// hangs a job that expected a fast failure.
func errNotLoggedIn(base string) error {
	login := "relayium login"
	if !sameServer(base, defaultCloudServer) {
		login = "relayium login --server " + base
	}
	return fmt.Errorf(
		"minting a pairing code needs an account (the sender signs in; the receiver never does)\n"+
			"  run `%s` first, or pass a code you were given:  relayium send <file> <code>\n"+
			"  sending to someone with a browser instead?  `relayium up <file>` returns a download link",
		login)
}

// mintCode mints a pairing code with the stored CLI credentials and prints the
// block the sender hands to the other machine's operator.
func mintCode(ctx context.Context, server string, stderr io.Writer) (string, error) {
	base, err := apiBase(server)
	if err != nil {
		return "", err
	}
	cfgDir, err := resolveConfigDir("")
	if err != nil {
		return "", err
	}
	creds, ok, err := cloud.Load(cfgDir)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", errNotLoggedIn(base)
	}
	// Never send the access token to a server other than the one that issued it
	// — it would leak the credential and would not authenticate there anyway.
	if !sameServer(base, creds.Server) {
		return "", fmt.Errorf("you're logged in to %s — run `relayium login --server %s` before sending from there", creds.Server, base)
	}
	c := cloud.NewClient(creds.Server)
	c.Token = creds.AccessToken
	p, err := c.MintPair(ctx)
	if err != nil {
		var he *cloud.HTTPError
		if errors.As(err, &he) {
			switch he.Status {
			case http.StatusUnauthorized:
				return "", errNotLoggedIn(base)
			case http.StatusTooManyRequests:
				return "", fmt.Errorf("too many pairing requests — wait a minute and try again")
			}
		}
		return "", err
	}
	printHandoff(stderr, p, base)
	return p.Code, nil
}

// printHandoff writes the one block a sender pastes into a chat window or
// another machine's SSH session: everything the recipient needs, no link to
// follow (the CLI cannot consume a URL, and the recipient is at a terminal).
func printHandoff(w io.Writer, p cloud.Pair, base string) {
	// Derived from the server's expiry rather than hard-coded, so the copy
	// follows a TTL change instead of lying about it.
	mins := int(time.Until(time.Unix(p.ExpiresAt, 0)) / time.Minute)
	if mins < 1 {
		mins = 1
	}
	fmt.Fprintf(w, "Code: %s   (valid %d minutes)\n", p.Code, mins)
	fmt.Fprintf(w, "On the other machine:  relayium receive %s\n", p.Code)
	// First-party only: a self-hosted origin has no install.sh to point at.
	if sameServer(base, defaultCloudServer) {
		fmt.Fprintf(w, "  not installed there?  curl -fsSL %s/install.sh | sh\n", defaultCloudServer)
	}
	fmt.Fprintln(w, "waiting for the receiver…")
}
```

Then rewrite the head of `runSendCross` in `server/cmd/relayium/crossnet.go`:

```go
func runSendCross(args []string, stdout, stderr io.Writer) int {
	f, rest, err := parseCrossFlags(args)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	srcs, code, err := splitSendArgs(rest)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 2
	}
	m, paths, err := xfer.BuildManifest(srcs)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	xfer.WarnIfEmpty(m, stderr)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	// Mint only after the sources check out: a code starts its 5-minute clock
	// the moment it is minted, and burning one on a typo'd path wastes it.
	if code == "" {
		if code, err = mintCode(ctx, f.server, stderr); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}
	conn, err := crossnetConn(ctx, code, "sender", f, stderr)
	…
```

The rest of the function is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test ./cmd/relayium/`
Expected: PASS, including the existing `TestRunSendNeedsArgs` (no arguments still exits non-zero with usage naming `send`).

- [ ] **Step 5: Commit**

```bash
git add server/cmd/relayium/sendpair.go server/cmd/relayium/sendpair_test.go server/cmd/relayium/crossnet.go
git commit -m "feat(cli): mint a pairing code when send is given none"
```

---

### Task 6: Correct the documentation

**Files:**
- Modify: `README.md:69`
- Modify: `web/scripts/pages/content/articles/cli-send-to-someone.mjs`
- Modify: `web/scripts/pages/content/articles/cli-getting-started.mjs`
- Modify: `web/scripts/pages/content/articles/guides-receive-from-cli.mjs`
- Modify: `web/scripts/pages/content/articles/guides-self-host.mjs`

These four articles are the ones `docs/tutorial-content-optimization-report.md:30-36` identified as teaching a flow that cannot work. Both language versions of each file must change together — the report also records that the zh copy carries the same claim.

Claims to remove: that the code is made up or agreed out of band; that `send`/`receive` need no account on either end; any six-digit numeric example (`123456`, `428571`).

Claims to state instead: the sender's CLI mints the code (`relayium send <file>` with no code, after `relayium login`); the code is 6 characters from a restricted alphabet with no `0` or `1`; it lasts 5 minutes; the receiver needs no account; a browser recipient wants `relayium up` instead, because CLI and browser transfers do not interoperate.

- [ ] **Step 1: Find every affected claim**

```bash
cd /Users/lily/code/relayium/relayium
grep -rn "make it up\|makes it up\|any short string\|agree on\|自己定的\|商定\|123456\|428571" README.md web/scripts/pages/content/articles/
```

Expected: hits in `README.md:69` and the four articles above. Any additional file the grep surfaces is in scope for this task.

- [ ] **Step 2: Rewrite README.md:69**

```markdown
- **`send` / `receive` by pairing code** — `relayium send ./file.zip` mints a code with your account (after `relayium login`) and prints what the other end runs: `relayium receive K7M4XR`. Codes are 6 characters and last 5 minutes; the receiver needs no account. Cross-network and direct peer-to-peer — a small rendezvous handshake introduces the two ends, the file goes straight between them, no relay. Sending to someone with a browser instead? Use `relayium up` for a download link.
```

- [ ] **Step 3: Rewrite the four articles, both languages**

Every `428571` in `cli-send-to-someone.mjs` (lines 25, 28, 32, 41, 102, 105, 109, 118) becomes a minted code — use `K7M4XR` — and the send example loses its code argument entirely, because that is now what mints one. The FAQ answer at line 61 is the load-bearing correction:

```
before:  "You make it up. It's any short string both sides type — agree on it
          over a call or a chat. It only needs to match on both ends."

after:   "Relayium mints it. Run `relayium send ./release.zip` (after
          `relayium login`) and the CLI prints a 6-character code good for five
          minutes, plus the exact command the other end runs. You can't choose
          it yourself — the server only accepts codes it issued."
```

and its zh counterpart at line 138:

```
before:  "是你自己定的。任何一个双方都能输入的简短字符串都行——打电话或聊天时约定好。
          它只需要在两端一致即可。"

after:   "由 Relayium 生成。登录后运行 `relayium send ./release.zip`，CLI 会打印一个
          6 位、5 分钟内有效的码，以及对面要执行的完整命令。这个码不能自己指定——
          服务器只认它自己签发的。"
```

Apply the same correction in the other three files: `cli-getting-started.mjs` (its FAQ claims send/receive need no account — the sender does), `guides-receive-from-cli.mjs` (drop "agreed out of band"; state that CLI codes pair CLI to CLI and a browser recipient uses a `relayium up` link), `guides-self-host.mjs` (drop "the CLI is free and needs no account either way"). Keep each article's voice and structure — change the claims, not the shape.

- [ ] **Step 4: Verify no stale claim survives**

```bash
cd /Users/lily/code/relayium/relayium
grep -rn "make it up\|makes it up\|any short string\|自己定的\|123456\|428571" README.md web/scripts/pages/content/articles/
cd web && npm run build
```

Expected: the grep prints nothing; the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add README.md web/scripts/pages/content/articles/
git commit -m "docs(cli): pairing codes are minted, not invented"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run the whole Go suite**

Run: `cd server && go build ./... && go vet ./... && go test ./...`
Expected: PASS throughout.

- [ ] **Step 2: Run the web suite**

Run: `cd web && npm test`
Expected: PASS. Nothing in this plan touches web source, so a failure here is pre-existing — report it, do not fix it in this branch.

- [ ] **Step 3: Exercise the real binary against production**

```bash
cd server && go build -o /tmp/relayium ./cmd/relayium
/tmp/relayium send /tmp/relayium 726122        # expect: "neither an existing file nor a pairing code"
/tmp/relayium send /tmp/relayium               # logged out: expect the login guidance, exit 1
```

With credentials present, `relayium send <file>` must print the hand-off block and then wait for a receiver. Confirm a real CLI↔CLI transfer end to end if two machines are available; note in the PR if they were not.

- [ ] **Step 4: Commit any fixes, then stop**

Do not merge. The `/device` nginx fix this work depends on for `relayium login` lives in the private `relayium-ops` repo and must be applied to the production host by hand — verify `curl -o /dev/null -w '%{http_code}' https://relayium.com/device` returns 200 before announcing that CLI login works.
