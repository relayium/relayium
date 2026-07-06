# Cross-Network Login + Relay Attribution — Server Plan (Plan A)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-network realtime relay require a logged-in owner, attribute TURN relay bytes to that owner, and withhold TURN when the owner is over an interim monthly relay cap — all at the server/API layer.

**Architecture:** The pairing-code registry (`signal.PairRegistry`) stores an owner userID per code; `/api/pair` requires a session to mint (owner = the logged-in user), while `/ws?code=` and `/api/ice?code=` stay open to the anonymous receiver. `/api/ice` embeds `ownerUserID.code` in the TURN credential username so the coturn→Redis→metering pipeline records `usage_events.user_id`, and it withholds TURN (with a `relayDenied:"quota"` marker) when the owner's current-month relay bytes exceed an admin-editable `relay_monthly_free_bytes` cap.

**Tech Stack:** Go, `modernc.org/sqlite`, `net/http`. Tests: `cd server && go test ./...`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-06-cross-network-login-relay-attribution-design.md`.
- Initiator-owned model: `/api/pair` (mint) requires login; receiver joins `/ws?code=` and `/api/ice?code=` anonymously. LAN (no code, no `/api/pair`) is unchanged and anonymous.
- TURN credential username = `expiry:ownerUserID.code` (HMAC over the whole string, unchanged mechanism). userID is hex, code is 6 digits — `.` separator is unambiguous.
- metering attribution: split the coturn-username token on the first `.` → `(userID, code)`; a token with no `.` (legacy `expiry:code`) → `("", code)` so old allocations stay unattributed rather than erroring.
- Relay usage is metered per-user from `usage_events` (never `usage_monthly`). Month bucket = UTC via existing `periodOf`/`monthRange` in `sqlite.go`.
- Interim cap setting key `relay_monthly_free_bytes`, default `2 << 30` (2 GiB), DB-overridable via the existing settings mechanism and admin-editable. `/api/ice` withholds TURN when the owner's current-month relayed bytes `>=` cap and sets `relayDenied:"quota"`; on a DB read error it fails OPEN (issues TURN) rather than blocking a legit transfer.
- The `signal` package must not import `account`; the login check is injected into `PairHandler` as a `currentUser func(*http.Request)(string,bool)` callback wired in `main.go`.
- Module path `github.com/relayium/relayium`. Session cookie name (`sessionCookie = "relayium_session"`) stays internal to `account`; expose resolution via `Service.UserFromRequest`.
- Out of scope (Plan B / later): web client login gate + `relayDenied` UX + i18n; per-plan quota (billing phase-1); changing the client's relay-only ICE policy.

---

### Task 1: PairRegistry stores an owner per code

**Files:**
- Modify: `server/internal/signal/pair.go`
- Test: `server/internal/signal/pair_test.go`

**Interfaces:**
- Produces: `(*PairRegistry).MintFor(owner string) (code string, exp int64)`, `(*PairRegistry).OwnerOf(code string) (owner string, ok bool)`; `Validate(code string) bool` retained.

- [ ] **Step 1: Write the failing test**

Add to `server/internal/signal/pair_test.go`:

```go
func TestPairRegistryOwner(t *testing.T) {
	var clock int64 = 1000
	r := NewPairRegistry(60, func() int64 { return clock })

	code, exp := r.MintFor("user-abc")
	if exp != 1060 {
		t.Fatalf("exp = %d, want 1060", exp)
	}
	owner, ok := r.OwnerOf(code)
	if !ok || owner != "user-abc" {
		t.Fatalf("OwnerOf = (%q,%v), want (user-abc,true)", owner, ok)
	}
	if !r.Validate(code) {
		t.Fatalf("Validate should be true for a live code")
	}
	// After expiry: no owner, not valid.
	clock = 1060
	if owner, ok := r.OwnerOf(code); ok || owner != "" {
		t.Fatalf("expired OwnerOf = (%q,%v), want ('',false)", owner, ok)
	}
	if r.Validate(code) {
		t.Fatalf("Validate should be false after expiry")
	}
	// Unknown code.
	if _, ok := r.OwnerOf("000000"); ok {
		t.Fatalf("OwnerOf unknown code should be false")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestPairRegistryOwner -v`
Expected: FAIL — compile error, `MintFor`/`OwnerOf` undefined.

- [ ] **Step 3: Implement the owner-carrying registry**

In `server/internal/signal/pair.go`, replace the type, constructor, `Mint`, `Validate`, and `reap` with:

```go
// codeEntry is a live pairing code's expiry plus the userID that minted it.
type codeEntry struct {
	exp   int64
	owner string // userID that owns (and is billed for) this cross-network transfer
}

// PairRegistry mints short numeric pairing codes for realtime rendezvous. Codes
// are in-memory only and short-lived; a code becomes a 2-peer signaling room
// "c:<code>". Each code is owned by the logged-in user that minted it. now is
// injected for tests.
type PairRegistry struct {
	mu    sync.Mutex
	codes map[string]codeEntry
	ttl   int64
	now   func() int64
}

func NewPairRegistry(ttlSeconds int64, now func() int64) *PairRegistry {
	return &PairRegistry{codes: make(map[string]codeEntry), ttl: ttlSeconds, now: now}
}

// MintFor returns a fresh 6-digit code not colliding with a live one, bound to
// owner, plus its unix expiry.
func (p *PairRegistry) MintFor(owner string) (string, int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for {
		code := randCode()
		if e, ok := p.codes[code]; ok && e.exp > now {
			continue // collide with a still-live code; try again
		}
		exp := now + p.ttl
		p.codes[code] = codeEntry{exp: exp, owner: owner}
		return code, exp
	}
}

// OwnerOf returns the owning userID of a live code, or ("", false) if the code
// is unknown or expired.
func (p *PairRegistry) OwnerOf(code string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.codes[code]
	if !ok || e.exp <= p.now() {
		return "", false
	}
	return e.owner, true
}

// Validate reports whether code exists and has not expired (expiry is exclusive).
func (p *PairRegistry) Validate(code string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	e, ok := p.codes[code]
	return ok && e.exp > p.now()
}

func (p *PairRegistry) reap() {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for c, e := range p.codes {
		if e.exp <= now {
			delete(p.codes, c)
		}
	}
}
```

(Leave `Run`, `randCode`, and imports unchanged.)

- [ ] **Step 4: Update the pre-existing Mint test**

The old `TestPairRegistryMintValidate` calls `r.Mint()`, which no longer exists. In `pair_test.go`, change every `r.Mint()` / `reg.Mint()` call in that test to `r.MintFor("u")` (owner value irrelevant to that test's assertions). Do not change its other assertions.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./internal/signal/ -v`
Expected: PASS (new owner test + updated mint test + the rest).

- [ ] **Step 6: Commit**

```bash
git add server/internal/signal/pair.go server/internal/signal/pair_test.go
git commit -m "feat(signal): pairing codes carry an owner userID"
```

---

### Task 2: Login gate on `/api/pair` (+ optional session resolver)

**Files:**
- Modify: `server/internal/account/service.go` (add `UserFromRequest`)
- Modify: `server/internal/signal/pairhttp.go` (`PairHandler` gains `currentUser` callback + 401)
- Modify: `server/main.go` (wire the callback; move `/api/pair` registration into the account-available block)
- Test: `server/internal/account/session_resolve_test.go` (create); `server/internal/signal/pairhttp_test.go` (update)

**Interfaces:**
- Consumes: `PairRegistry.MintFor` (Task 1).
- Produces: `(*account.Service).UserFromRequest(r *http.Request) (User, bool)`; `signal.PairHandler(reg *PairRegistry, rl *RateLimiter, ipx *IPExtractor, currentUser func(*http.Request)(string,bool)) http.HandlerFunc`.

- [ ] **Step 1: Write the failing test for `UserFromRequest`**

Create `server/internal/account/session_resolve_test.go`:

```go
package account

import (
	"net/http"
	"testing"
)

func TestUserFromRequest(t *testing.T) {
	ts, svc, store, mail := newFileServer(t) // harness from files_test.go
	_ = store
	cookie := loginCookie(t, ts, mail, "who@example.com")

	// With a valid session cookie → resolves the user.
	req, _ := http.NewRequest("GET", "/api/pair", nil)
	req.AddCookie(cookie)
	u, ok := svc.UserFromRequest(req)
	if !ok || u.Email != "who@example.com" {
		t.Fatalf("UserFromRequest = (%+v,%v), want who@example.com,true", u, ok)
	}

	// No cookie → anonymous.
	req2, _ := http.NewRequest("GET", "/api/pair", nil)
	if _, ok := svc.UserFromRequest(req2); ok {
		t.Fatalf("UserFromRequest with no cookie should be false")
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestUserFromRequest -v`
Expected: FAIL — `UserFromRequest` undefined.

- [ ] **Step 3: Implement `UserFromRequest`**

In `server/internal/account/service.go`, near `RequireSession`/session helpers, add:

```go
// UserFromRequest resolves the logged-in user from the session cookie, or
// (User{}, false) when the cookie is absent or invalid. Unlike RequireSession it
// writes no response — callers decide how to treat an anonymous request.
func (s *Service) UserFromRequest(r *http.Request) (User, bool) {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return User{}, false
	}
	u, ok, err := s.ValidateSession(r.Context(), c.Value)
	if err != nil || !ok {
		return User{}, false
	}
	return u, true
}
```

Ensure `service.go` imports `net/http` (add if absent).

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestUserFromRequest -v`
Expected: PASS.

- [ ] **Step 5: Write the failing test for the PairHandler gate**

In `server/internal/signal/pairhttp_test.go`, add (adapting to that file's existing helpers for building a request/limiter/ipx — mirror an existing test's setup):

```go
func TestPairHandlerRequiresLogin(t *testing.T) {
	reg := NewPairRegistry(60, func() int64 { return 1000 })
	rl := NewRateLimiter(100, time.Minute) // permissive; match this file's constructor
	ipx := NewIPExtractor(nil)             // match this file's constructor

	// Anonymous (currentUser returns false) → 401.
	anon := PairHandler(reg, rl, ipx, func(*http.Request) (string, bool) { return "", false })
	rec := httptest.NewRecorder()
	anon.ServeHTTP(rec, httptest.NewRequest("POST", "/api/pair", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anon pair = %d, want 401", rec.Code)
	}

	// Logged in → 200 with a code owned by that user.
	authed := PairHandler(reg, rl, ipx, func(*http.Request) (string, bool) { return "user-xyz", true })
	rec2 := httptest.NewRecorder()
	authed.ServeHTTP(rec2, httptest.NewRequest("POST", "/api/pair", nil))
	if rec2.Code != http.StatusOK {
		t.Fatalf("authed pair = %d, want 200", rec2.Code)
	}
	var body struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(rec2.Body).Decode(&body)
	if owner, ok := reg.OwnerOf(body.Code); !ok || owner != "user-xyz" {
		t.Fatalf("minted code owner = (%q,%v), want user-xyz,true", owner, ok)
	}
}
```

Note: match `NewRateLimiter`/`NewIPExtractor` (or equivalent) to the exact constructors used elsewhere in `pairhttp_test.go`; read the file's existing tests first and copy their setup verbatim. Add imports `encoding/json`, `net/http`, `net/http/httptest`, `time`, `testing` as needed.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd server && go test ./internal/signal/ -run TestPairHandlerRequiresLogin -v`
Expected: FAIL — `PairHandler` takes 3 args, not 4.

- [ ] **Step 7: Add the login gate to PairHandler**

In `server/internal/signal/pairhttp.go`, replace `PairHandler`:

```go
// PairHandler mints a pairing code for a logged-in user. currentUser resolves the
// request's owner (injected so this package need not depend on the account layer);
// an anonymous request is rejected with 401 — cross-network rendezvous requires an
// owning account, while the receiver still joins the code room anonymously.
func PairHandler(reg *PairRegistry, rl *RateLimiter, ipx *IPExtractor, currentUser func(*http.Request) (string, bool)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := ipx.IP(r)
		if !rl.Allow(ip) {
			http.Error(w, "too many pairing requests", http.StatusTooManyRequests)
			return
		}
		userID, ok := currentUser(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		code, exp := reg.MintFor(userID)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "expiresAt": exp})
	}
}
```

- [ ] **Step 8: Rewire `/api/pair` in main.go into the account block**

In `server/main.go`, remove the current anonymous registration at line ~173:

```go
	mux.HandleFunc("POST /api/pair", signal.PairHandler(pairReg, pairLimiter, ipx))
```

and instead register it INSIDE the `else` block where `acct` exists (the block starting `acct := account.NewService(...)`), right after `acct.SetPairCodeOwner(...)` (added in Task 3) — or, for this task, immediately after `acct` is constructed:

```go
		mux.HandleFunc("POST /api/pair", signal.PairHandler(pairReg, pairLimiter, ipx,
			func(r *http.Request) (string, bool) {
				u, ok := acct.UserFromRequest(r)
				return u.ID, ok
			}))
```

This means: when the DB is unavailable (`dbErr != nil`, accounts disabled), `/api/pair` is simply not registered — cross-network pairing is unavailable but LAN transfer is unaffected, consistent with accounts being off. Leave a one-line comment saying so.

- [ ] **Step 9: Run the suites to verify they pass**

Run: `cd server && go build ./... && go test ./internal/signal/ ./internal/account/`
Expected: PASS. (`go build` confirms the main.go rewiring compiles.)

- [ ] **Step 10: Commit**

```bash
git add server/internal/account/service.go server/internal/account/session_resolve_test.go server/internal/signal/pairhttp.go server/internal/signal/pairhttp_test.go server/main.go
git commit -m "feat(pair): require login to mint a cross-network pairing code"
```

---

### Task 3: `/api/ice` resolves the owner and embeds it in the TURN credential

**Files:**
- Modify: `server/internal/account/service.go` (swap validator field for owner resolver)
- Modify: `server/internal/account/turn.go` (`handleICE`)
- Modify: `server/main.go` (`SetPairCodeOwner(pairReg.OwnerOf)`)
- Test: `server/internal/account/turn_test.go`

**Interfaces:**
- Consumes: `PairRegistry.OwnerOf` (Task 1).
- Produces: `(*Service).SetPairCodeOwner(fn func(string)(string,bool))`; TURN credential username token = `owner + "." + code`.

- [ ] **Step 1: Swap the service field**

In `server/internal/account/service.go`, replace the `validatePairCode` field and `SetPairCodeValidator` with:

```go
	pairCodeOwner func(string) (string, bool) // resolves a live code to its owner userID; nil until wired
```

```go
// SetPairCodeOwner wires the pairing-code registry so /api/ice can resolve a
// live code to its owning account — TURN is issued (and relay billed) for that
// owner. Called once at startup.
func (s *Service) SetPairCodeOwner(fn func(string) (string, bool)) { s.pairCodeOwner = fn }
```

- [ ] **Step 2: Write the failing test**

In `server/internal/account/turn_test.go`, update the harness usage: every `svc.SetPairCodeValidator(func(c string) bool {...})` becomes `svc.SetPairCodeOwner(...)` returning `(owner, ok)`. Then add:

```go
func TestICEEmbedsOwnerInTurnUsername(t *testing.T) {
	ts, _, _ := newICEServer(t, "secret") // existing helper; adjust to its real signature
	// A live code owned by "owner-1".
	// (Wire the owner resolver on the service the helper built — mirror how the
	// existing tests call SetPairCodeOwner on that service.)
	// Then request /api/ice?code=424242 and assert the TURN username embeds owner.
	resp := iceGet(t, ts, "?code=424242") // existing helper that returns the parsed body
	turn := firstTurn(resp)               // existing helper, or inline: find a turn: entry
	// username is "<expiry>:<owner>.<code>"
	if !strings.Contains(turn.Username, ":owner-1.424242") {
		t.Fatalf("turn username = %q, want to contain :owner-1.424242", turn.Username)
	}
}
```

Note: `turn_test.go` already has helpers (`newICEServer`, and it drives `/api/ice`); read them and match this test to their exact shapes. Set the owner resolver to `func(c string)(string,bool){ if c=="424242" { return "owner-1", true }; return "", false }`.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestICEEmbedsOwner -v`
Expected: FAIL — compile error (SetPairCodeOwner undefined) then, once compiling, username lacks the owner.

- [ ] **Step 4: Update `handleICE`**

In `server/internal/account/turn.go`, replace the top of `handleICE` (the code/validity block and the two credential emissions) so it resolves the owner and uses `owner.code` as the credential token:

```go
func (s *Service) handleICE(w http.ResponseWriter, r *http.Request) {
	servers := s.stunServers()
	code := r.URL.Query().Get("code")
	owner := ""
	validCode := false
	if code != "" && s.pairCodeOwner != nil {
		owner, validCode = s.pairCodeOwner(code)
	}
	now := s.now()
	expiry := now.Add(s.cfg.TURNCredTTL).Unix()

	// The credential username embeds the owner userID (and code) so coturn→Redis→
	// metering attributes relay bytes to the owning account.
	token := owner + "." + code

	if validCode && s.cfg.TURNSecret != "" && len(s.cfg.TURNURLs) > 0 {
		servers = append(servers, turnCredentials(s.cfg.TURNSecret, token, expiry, s.cfg.TURNURLs))
	}

	resp := map[string]any{"iceServers": servers}

	if validCode && len(s.cfg.TURNRelays) > 0 {
		relays := make([]relayEntry, 0, len(s.cfg.TURNRelays))
		for _, rc := range s.cfg.TURNRelays {
			if rc.ID == "" || rc.Secret == "" || len(rc.URLs) == 0 {
				continue
			}
			relays = append(relays, relayEntry{
				ID:         rc.ID,
				Region:     rc.Region,
				STUN:       rc.STUN,
				ICEServers: []ICEServer{turnCredentials(rc.Secret, token, expiry, rc.URLs)},
			})
		}
		if len(relays) > 0 {
			resp["relays"] = relays
		}
	}

	writeJSON(w, http.StatusOK, resp)
}
```

(The interim-cap gate is added in Task 6; keep this task to attribution only.)

- [ ] **Step 5: Wire the resolver in main.go**

In `server/main.go`, change line ~207 `acct.SetPairCodeValidator(pairReg.Validate)` to:

```go
		acct.SetPairCodeOwner(pairReg.OwnerOf)
```

- [ ] **Step 6: Run the suite to verify it passes**

Run: `cd server && go build ./... && go test ./internal/account/ -run TestICE -v`
Expected: PASS (all `/api/ice` tests, including the new owner-embed assertion).

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/service.go server/internal/account/turn.go server/internal/account/turn_test.go server/main.go
git commit -m "feat(ice): embed pairing-code owner in the TURN credential"
```

---

### Task 4: metering attributes relay bytes to the owner

**Files:**
- Modify: `server/internal/metering/metering.go`
- Test: `server/internal/metering/metering_test.go` (add cases; create if absent)

**Interfaces:**
- Produces: `splitAttrib(token string) (userID, code string)`.
- Consumes: the `owner.code` token format (Task 3).

- [ ] **Step 1: Write the failing test**

Add to `server/internal/metering/metering_test.go` (create the file with `package metering` if it does not exist):

```go
func TestSplitAttrib(t *testing.T) {
	cases := []struct{ in, user, code string }{
		{"deadbeefcafe.424242", "deadbeefcafe", "424242"}, // new format
		{"424242", "", "424242"},                          // legacy: no owner
		{"", "", ""},
	}
	for _, c := range cases {
		u, code := splitAttrib(c.in)
		if u != c.user || code != c.code {
			t.Fatalf("splitAttrib(%q) = (%q,%q), want (%q,%q)", c.in, u, code, c.user, c.code)
		}
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/metering/ -run TestSplitAttrib -v`
Expected: FAIL — `splitAttrib` undefined.

- [ ] **Step 3: Implement `splitAttrib` and use it in `handle`**

In `server/internal/metering/metering.go`, add:

```go
// splitAttrib splits a coturn-username token "<userID>.<code>" into its parts.
// A token with no '.' (legacy anonymous codes) yields ("", token), keeping global
// relay accounting working without attribution.
func splitAttrib(token string) (userID, code string) {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return "", token
}
```

Then in `handle`, replace the `rec := account.UsageEvent{...}` construction:

```go
	token := tokenFromUsername(ev.Username)
	if token == "" {
		w.Log.Printf("metering: skip alloc %s, malformed username %q", ev.AllocID, ev.Username)
		return
	}
	userID, code := splitAttrib(token)
	rec := account.UsageEvent{
		AllocID:      ev.AllocID,
		Token:        code,
		UserID:       userID,
		RelayedBytes: ev.RelayedBytes,
		RecordedAt:   w.Now(),
	}
```

(Delete the now-stale "recorded unattributed / deferred" comment block.)

- [ ] **Step 4: Add a handle-level attribution test**

Add to `metering_test.go` (mirror any existing `handle` test harness — a fake `Sink` capturing `RecordUsage`; if none exists, write a minimal fake implementing the `Sink` interface):

```go
type captureSink struct{ last account.UsageEvent }

func (c *captureSink) RecordUsage(_ context.Context, e account.UsageEvent) error {
	c.last = e
	return nil
}

func TestHandleAttributesOwner(t *testing.T) {
	sink := &captureSink{}
	w := &Worker{Sink: sink, Log: log.New(io.Discard, "", 0), Now: func() int64 { return 42 }}
	w.handle(context.Background(), UsageEvent{AllocID: "a1", Username: "999:deadbeef.424242", RelayedBytes: 500})
	if sink.last.UserID != "deadbeef" || sink.last.Token != "424242" || sink.last.RelayedBytes != 500 {
		t.Fatalf("recorded = %+v, want UserID=deadbeef Token=424242 Bytes=500", sink.last)
	}
}
```

Match `Worker`'s exact field names/constructor by reading `metering.go` first (the struct literal above must match; adjust `Sink`/`Log`/`Now` to the real fields).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && go test ./internal/metering/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/internal/metering/metering.go server/internal/metering/metering_test.go
git commit -m "feat(metering): attribute relay bytes to the code owner"
```

---

### Task 5: Interim relay-cap setting + per-user monthly relay read

**Files:**
- Modify: `server/internal/account/settings.go` (setting key, `Settings` field, resolve, seed)
- Modify: `server/internal/account/service.go` (Config field)
- Modify: `server/main.go` (flag/env default)
- Modify: `server/internal/account/store.go` (interface) + `server/internal/account/sqlite.go` (`UserRelayedSince`)
- Test: `server/internal/account/settings_test.go` (add) + `server/internal/account/sqlite_test.go` (add)

**Interfaces:**
- Produces: `SettingRelayMonthlyFree = "relay_monthly_free_bytes"`; `Settings.RelayMonthlyFree int64`; `Config.RelayMonthlyFree int64`; `(Store).UserRelayedSince(ctx, userID string, since int64) (int64, error)`.

- [ ] **Step 1: Write the failing test for `UserRelayedSince`**

Add to `server/internal/account/sqlite_test.go`:

```go
func TestUserRelayedSince(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	u, _ := s.UpsertUserByEmail(ctx, "r@example.com", "R")

	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a1", Token: "c1", UserID: u.ID, RelayedBytes: 100, RecordedAt: 1000})
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a2", Token: "c2", UserID: u.ID, RelayedBytes: 250, RecordedAt: 2000})
	_ = s.RecordUsage(ctx, UsageEvent{AllocID: "a3", Token: "c3", UserID: "other", RelayedBytes: 999, RecordedAt: 2000})

	// since=1500 → only the 250 event counts; "other" user excluded.
	got, err := s.UserRelayedSince(ctx, u.ID, 1500)
	if err != nil {
		t.Fatalf("UserRelayedSince: %v", err)
	}
	if got != 250 {
		t.Fatalf("got %d, want 250", got)
	}
	// since=0 → both of u's events.
	if got, _ := s.UserRelayedSince(ctx, u.ID, 0); got != 350 {
		t.Fatalf("got %d, want 350", got)
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestUserRelayedSince -v`
Expected: FAIL — `UserRelayedSince` undefined.

- [ ] **Step 3: Implement `UserRelayedSince`**

In `server/internal/account/store.go`, add to the `Store` interface near `UserUsageTotal`:

```go
	UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error)
```

In `server/internal/account/sqlite.go`, add:

```go
// UserRelayedSince sums a user's relayed bytes recorded at or after `since`
// (used for the interim monthly relay cap).
func (s *SQLiteStore) UserRelayedSince(ctx context.Context, userID string, since int64) (int64, error) {
	var total int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(relayed_bytes),0) FROM usage_events WHERE user_id = ? AND recorded_at >= ?`,
		userID, since).Scan(&total)
	return total, err
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server && go test ./internal/account/ -run TestUserRelayedSince -v`
Expected: PASS.

- [ ] **Step 5: Add the setting plumbing**

In `server/internal/account/settings.go`:
- Add the key constant alongside the others:
  ```go
  	SettingRelayMonthlyFree = "relay_monthly_free_bytes"
  ```
- Add to `Settings`:
  ```go
  	RelayMonthlyFree int64
  ```
- In `resolveSettings`, add:
  ```go
  		RelayMonthlyFree: s.settingOr(ctx, SettingRelayMonthlyFree, s.cfg.RelayMonthlyFree),
  ```
- In `SeedSettings`'s defaults slice, add:
  ```go
  		{SettingRelayMonthlyFree, s.cfg.RelayMonthlyFree},
  ```

In `server/internal/account/service.go`, add to `Config` (near `MaxFileSize`):

```go
	RelayMonthlyFree int64 // bytes; interim per-user monthly TURN-relay allowance
```

In `server/main.go`, add a flag near `maxFileSize` and pass it into the `account.Config{...}`:

```go
	relayMonthlyFree := flag.Int64("relay-monthly-free", envInt64("RELAYIUM_RELAY_MONTHLY_FREE", 2<<30),
		"interim per-user monthly TURN-relay allowance in bytes (default 2 GiB); superseded by per-plan quota later")
```
```go
			RelayMonthlyFree: *relayMonthlyFree,
```

- [ ] **Step 6: Write + run a settings test**

Add to `server/internal/account/settings_test.go`:

```go
func TestRelayMonthlyFreeResolvesAndSeeds(t *testing.T) {
	s := newTestStore(t)
	svc := NewService(s, &capturingMailer{}, Config{RelayMonthlyFree: 2 << 30})
	ctx := context.Background()
	// Default from Config when unset in DB.
	if st := svc.resolveSettings(ctx); st.RelayMonthlyFree != 2<<30 {
		t.Fatalf("default relay cap = %d, want %d", st.RelayMonthlyFree, int64(2<<30))
	}
	// DB override wins.
	if err := s.SetSetting(ctx, SettingRelayMonthlyFree, 5<<20, 1); err != nil {
		t.Fatal(err)
	}
	if st := svc.resolveSettings(ctx); st.RelayMonthlyFree != 5<<20 {
		t.Fatalf("override relay cap = %d, want %d", st.RelayMonthlyFree, int64(5<<20))
	}
}
```

Run: `cd server && go build ./... && go test ./internal/account/ -run 'TestRelayMonthlyFree|TestUserRelayedSince' -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/internal/account/settings.go server/internal/account/settings_test.go server/internal/account/service.go server/internal/account/store.go server/internal/account/sqlite.go server/internal/account/sqlite_test.go server/main.go
git commit -m "feat(account): interim relay_monthly_free_bytes setting + UserRelayedSince"
```

---

### Task 6: `/api/ice` withholds TURN over the interim cap

**Files:**
- Modify: `server/internal/account/turn.go` (`handleICE` gate + `relayDenied`)
- Test: `server/internal/account/turn_test.go`

**Interfaces:**
- Consumes: `resolveSettings().RelayMonthlyFree` (Task 5), `UserRelayedSince` (Task 5), `periodOf`/`monthRange` (existing in `sqlite.go`).

- [ ] **Step 1: Write the failing test**

Add to `server/internal/account/turn_test.go` (mirror the harness of the Task-3 owner test; seed the owner's usage_events via the store the helper exposes):

```go
func TestICEWithholdsTurnOverCap(t *testing.T) {
	// Build an ICE server whose store already has the owner over the cap.
	// Use the same harness as TestICEEmbedsOwnerInTurnUsername; set the owner
	// resolver to map 424242 -> "owner-1", and set the service Config /
	// DB setting RelayMonthlyFree to a small value, then record usage_events
	// for owner-1 in the current month exceeding it.
	ts, svc, store := newICEServerWithStore(t, "secret") // adapt to real helper(s)
	svc.SetPairCodeOwner(func(c string) (string, bool) {
		if c == "424242" {
			return "owner-1", true
		}
		return "", false
	})
	// Cap = 100 bytes; owner already relayed 500 this month.
	_ = store.SetSetting(context.Background(), SettingRelayMonthlyFree, 100, 1)
	now := svc.now().Unix()
	_ = store.RecordUsage(context.Background(), UsageEvent{
		AllocID: "x", Token: "424242", UserID: "owner-1", RelayedBytes: 500, RecordedAt: now,
	})

	resp := iceGet(t, ts, "?code=424242")
	if !hasNoTurn(resp) { // assert no turn: entry present
		t.Fatalf("expected STUN-only when over cap, got a TURN entry")
	}
	if resp["relayDenied"] != "quota" {
		t.Fatalf("relayDenied = %v, want quota", resp["relayDenied"])
	}
}
```

Adapt helper names to `turn_test.go`'s real ones (it already parses the `/api/ice` JSON; add a small `hasNoTurn`/inline check on `iceServers` + `relays`). If the existing harness doesn't expose the store, extend it minimally.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestICEWithholdsTurnOverCap -v`
Expected: FAIL — TURN still issued; no `relayDenied`.

- [ ] **Step 3: Add the cap gate to `handleICE`**

In `server/internal/account/turn.go`, insert the gate after `validCode` is determined and before the credential emissions (from Task 3's version):

```go
	now := s.now()
	expiry := now.Add(s.cfg.TURNCredTTL).Unix()

	// Interim relay cap: withhold TURN when the code's owner is over the monthly
	// free relay allowance. On a read error, fail open (issue TURN) rather than
	// blocking a legit transfer. Per-plan quota (billing phase-1) supersedes this.
	relayDenied := ""
	if validCode {
		st := s.resolveSettings(r.Context())
		since, _ := monthRange(periodOf(now.Unix()))
		if used, err := s.store.UserRelayedSince(r.Context(), owner, since); err == nil && used >= st.RelayMonthlyFree {
			validCode = false
			relayDenied = "quota"
		}
	}

	token := owner + "." + code
```

Then, just before `writeJSON`, add:

```go
	if relayDenied != "" {
		resp["relayDenied"] = relayDenied
	}
```

(Remove the duplicate `now`/`expiry` lines if Task 3 already declared them — keep a single declaration at the top of the gate.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go test ./internal/account/ -run TestICE -v`
Expected: PASS — over-cap withholds TURN + `relayDenied:"quota"`; under-cap and owner-embed tests still pass.

- [ ] **Step 5: Commit**

```bash
git add server/internal/account/turn.go server/internal/account/turn_test.go
git commit -m "feat(ice): withhold TURN and flag relayDenied over the monthly relay cap"
```

---

### Task 7: Admin settings form exposes the relay cap

**Files:**
- Modify: `server/internal/account/admin.go` (`adminSettingsView` build + `handleAdminSettings` parse)
- Modify: `server/internal/account/admin_templates.go` (form field)
- Test: `server/internal/account/admin_test.go`

**Interfaces:**
- Consumes: `SettingRelayMonthlyFree`, `Settings.RelayMonthlyFree` (Task 5).

- [ ] **Step 1: Write the failing test**

Add to `server/internal/account/admin_test.go` (mirror the existing settings-POST test; if none, mirror `TestAdminHomeDashboardAndPaging`'s authenticated GET + a POST to `/admin/settings`):

```go
func TestAdminSettingsSavesRelayCap(t *testing.T) {
	ts := newAdminServer(t, "admin", "s3cret")
	client := ts.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	_, _ = client.PostForm(ts.URL+"/admin/login",
		url.Values{"username": {"admin"}, "password": {"s3cret"}})

	// Post all five settings; relay cap = 3 MiB.
	resp, _ := client.PostForm(ts.URL+"/admin/settings", url.Values{
		"max_file_size_mb":       {"50"},
		"daily_quota_mb":         {"200"},
		"default_ttl_hours":      {"24"},
		"max_ttl_hours":          {"168"},
		"relay_monthly_free_mb":  {"3"},
	})
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("settings POST = %d, want 302", resp.StatusCode)
	}
	// The rendered dashboard shows the new value (3) in the relay-cap field.
	body := adminSessionGet(t, ts, "/admin") // helper from admin_metering_ui_test.go
	if !strings.Contains(body, `name="relay_monthly_free_mb"`) || !strings.Contains(body, `value="3"`) {
		t.Fatalf("relay cap field not rendered with value 3")
	}
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && go test ./internal/account/ -run TestAdminSettingsSavesRelayCap -v`
Expected: FAIL — field/parse absent.

- [ ] **Step 3: Add the field to the view + parse + template**

In `server/internal/account/admin_templates.go`, add to `adminSettingsView`:

```go
	RelayMonthlyFreeMB int64
```

and add the form input inside the settings `<form>` (after the max-ttl label):

```html
<label>中继月度免费额度 (MiB)<input type="number" name="relay_monthly_free_mb" min="1" value="{{.Settings.RelayMonthlyFreeMB}}"></label>
```

In `server/internal/account/admin.go`, in the home handler's `adminSettingsView{...}` literal add:

```go
			RelayMonthlyFreeMB: st.RelayMonthlyFree / (1024 * 1024),
```

In `handleAdminSettings`, add a fifth parsed field and persist it:

```go
	relayMB, ok5 := atoi("relay_monthly_free_mb")
```
Change the validation guard to include `ok5`:
```go
	if !(ok1 && ok2 && ok3 && ok4 && ok5) || defH > maxH {
```
Add to the `updates` slice:
```go
		{SettingRelayMonthlyFree, relayMB * 1024 * 1024},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && go build ./... && go test ./internal/account/ -run TestAdminSettings -v`
Expected: PASS.

- [ ] **Step 5: Full suite + commit**

Run: `cd server && go build ./... && go vet ./... && go test ./...`
Expected: PASS across all packages.

```bash
git add server/internal/account/admin.go server/internal/account/admin_templates.go server/internal/account/admin_test.go
git commit -m "feat(admin): editable relay_monthly_free_bytes in the settings form"
```

---

## Self-Review Notes

- **Spec coverage:** owner-per-code + `MintFor`/`OwnerOf` (T1) ✓; `/api/pair` login gate via injected `currentUser` (no signal→account dep) + `UserFromRequest` (T2) ✓; `/api/ice` owner resolve + `owner.code` TURN username (T3) ✓; metering `splitAttrib` records real `usage_events.user_id`, legacy `code` → unattributed (T4) ✓; interim `relay_monthly_free_bytes` (default 2 GiB, DB-overridable, seeded) + `UserRelayedSince` (T5) ✓; `/api/ice` withholds TURN over cap + `relayDenied:"quota"`, fail-open on error, UTC month via `periodOf`/`monthRange` (T6) ✓; admin-editable cap (T7) ✓; receiver stays anonymous — `/ws?code=` (`RoomFor`/`Validate`) and `/api/ice?code=` untouched for the receiver path ✓; LAN unaffected (no `/api/pair`, no TURN) ✓.
- **Signature consistency:** `MintFor(owner)`, `OwnerOf(code)(owner,ok)`, `UserFromRequest(r)(User,bool)`, `PairHandler(reg,rl,ipx,currentUser)`, `SetPairCodeOwner(fn)`, credential token `owner+"."+code`, `splitAttrib(token)(userID,code)`, `UserRelayedSince(ctx,userID,since)` used identically across tasks.
- **Deferred to Plan B (web) / later:** CrossPage login gate, `relayDenied` UX + i18n (Plan B); per-plan quota superseding the interim cap (billing phase-1).
- **Test-harness caveat:** Tasks 2/3/6/7 reference existing test helpers (`newFileServer`/`loginCookie`, `newICEServer`/`iceGet`, `newAdminServer`/`adminSessionGet`, `pairhttp_test` limiter/ipx constructors). Implementers must read those files first and match real names/signatures; the plan's helper names are indicative where the exact shape lives in code the task will open.
