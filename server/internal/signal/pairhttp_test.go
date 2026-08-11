// server/internal/signal/pairhttp_test.go
package signal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// alwaysAuthed stubs a logged-in currentUser for tests that exercise minting
// and rate-limiting rather than the login gate itself.
func alwaysAuthed(*http.Request) (string, bool) { return "user-test", true }

func TestPairHandlerMints(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(5, time.Minute, now)
	h := PairHandler(reg, rl, NewIPExtractor(nil), alwaysAuthed, nil)

	req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
	req.RemoteAddr = "203.0.113.5:5555"
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body struct {
		Code      string `json:"code"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(body.Code) != 6 || body.ExpiresAt != 1300 {
		t.Fatalf("body = %+v, want 6-digit code + exp 1300", body)
	}
	if !reg.Validate(body.Code) {
		t.Fatal("minted code should validate in the registry")
	}
}

func TestRateLimiterReapEvictsIdleKeys(t *testing.T) {
	clock := int64(1000)
	rl := NewRateLimiter(5, time.Minute, func() int64 { return clock })
	rl.Allow("203.0.113.7")
	clock = 1000 + 61 // past the 60s window
	rl.reap()
	rl.mu.Lock()
	_, present := rl.hits["203.0.113.7"]
	rl.mu.Unlock()
	if present {
		t.Fatal("reap should evict a key whose hits all aged out")
	}
}

func TestPairHandlerRequiresLogin(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(60, now)
	rl := NewRateLimiter(100, time.Minute, now) // permissive; match this file's constructor
	ipx := NewIPExtractor(nil)

	// Anonymous (currentUser returns false) → 401.
	anon := PairHandler(reg, rl, ipx, func(*http.Request) (string, bool) { return "", false }, nil)
	rec := httptest.NewRecorder()
	anon.ServeHTTP(rec, httptest.NewRequest("POST", "/api/pair", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anon pair = %d, want 401", rec.Code)
	}

	// Logged in → 200 with a code owned by that user.
	authed := PairHandler(reg, rl, ipx, func(*http.Request) (string, bool) { return "user-xyz", true }, nil)
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

// ── admission (B3) ──────────────────────────────────────────────────────────
//
// The mint is the last place the server can refuse a rendezvous an account
// cannot use, and it has to be the AUTHORITATIVE place: the choose screen's
// preflight is advisory (it can be stale by the time the button is clicked, and
// a CLI/bearer client never asks it at all), so the answer that decides is the
// one taken here, immediately before MintFor.

// blocked is an admission that always refuses, with a stable machine-readable
// code the client can branch on.
func blocked(reason string) PairAdmission {
	return func(*http.Request, string) string { return reason }
}

func TestPairHandlerRefusesAMintTheOwnerMayNotHave(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(5, time.Minute, now)
	h := PairHandler(reg, rl, NewIPExtractor(nil), alwaysAuthed, blocked("traffic_exhausted"))

	req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
	req.RemoteAddr = "203.0.113.9:5555"
	rec := httptest.NewRecorder()
	h(rec, req)

	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", rec.Code)
	}
	// Machine-readable, because the client has to tell this apart from the IP
	// rate limiter's 429 above it — one is "you personally are out of
	// allowance" and the other is "slow down", and they lead to different
	// screens.
	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("the refusal is not JSON (%q): %v", rec.Body.String(), err)
	}
	if body.Error != "traffic_exhausted" {
		t.Fatalf("refusal error = %q, want traffic_exhausted", body.Error)
	}
}

// Nothing is allocated by a refusal. A code taken out of the space and handed to
// nobody is worse than useless: it collides with the next mint for its whole TTL.
func TestARefusedMintAllocatesNoCode(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(5, time.Minute, now)
	h := PairHandler(reg, rl, NewIPExtractor(nil), alwaysAuthed, blocked("traffic_exhausted"))

	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/pair", nil))

	reg.mu.Lock()
	n := len(reg.codes)
	reg.mu.Unlock()
	if n != 0 {
		t.Fatalf("the registry holds %d code(s) after a refused mint", n)
	}
}

// The gate runs on the owner the request actually resolved to, and only after
// the login check — so an anonymous request is still a 401 rather than an
// account-shaped refusal, and the gate is never asked about "".
func TestAdmissionRunsAfterAuthAndOnTheResolvedOwner(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	rl := NewRateLimiter(100, time.Minute, now)
	ipx := NewIPExtractor(nil)

	var asked []string
	record := PairAdmission(func(_ *http.Request, userID string) string {
		asked = append(asked, userID)
		return ""
	})

	anon := PairHandler(NewPairRegistry(300, now), rl, ipx,
		func(*http.Request) (string, bool) { return "", false }, record)
	rec := httptest.NewRecorder()
	anon(rec, httptest.NewRequest("POST", "/api/pair", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d, want 401", rec.Code)
	}
	if len(asked) != 0 {
		t.Fatalf("the admission gate was asked about %v for an anonymous request", asked)
	}

	authed := PairHandler(NewPairRegistry(300, now), rl, ipx,
		func(*http.Request) (string, bool) { return "user-xyz", true }, record)
	rec2 := httptest.NewRecorder()
	authed(rec2, httptest.NewRequest("POST", "/api/pair", nil))
	if rec2.Code != 200 {
		t.Fatalf("admitted mint = %d, want 200", rec2.Code)
	}
	if len(asked) != 1 || asked[0] != "user-xyz" {
		t.Fatalf("the gate was asked about %v, want exactly [user-xyz]", asked)
	}
}

// The IP limiter still comes first, and the gate is not consulted for a request
// that never gets that far — otherwise a flood would turn into a quota-read
// flood against the database.
func TestTheIPLimiterStillShedsBeforeTheAdmissionGate(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	rl := NewRateLimiter(1, time.Minute, now)
	asks := 0
	h := PairHandler(NewPairRegistry(300, now), rl, NewIPExtractor(nil), alwaysAuthed,
		func(*http.Request, string) string { asks++; return "" })

	call := func() int {
		req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
		req.RemoteAddr = "198.51.100.9:1"
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec.Code
	}
	if got := call(); got != 200 {
		t.Fatalf("first = %d, want 200", got)
	}
	if got := call(); got != http.StatusTooManyRequests {
		t.Fatalf("second = %d, want 429 from the IP limiter", got)
	}
	if asks != 1 {
		t.Fatalf("the admission gate was asked %d times, want 1 — a rate-limited request must not reach it", asks)
	}
}

// A deployment with no gate wired keeps the old behaviour exactly, which is what
// makes the parameter safe to add to a handler several call sites construct.
func TestNoAdmissionGateMeansNoAdmissionCheck(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	h := PairHandler(reg, NewRateLimiter(5, time.Minute, now), NewIPExtractor(nil), alwaysAuthed, nil)
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/api/pair", nil))
	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestPairHandlerRateLimitsPerIP(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(2, time.Minute, now)
	h := PairHandler(reg, rl, NewIPExtractor(nil), alwaysAuthed, nil)

	call := func(ip string) int {
		req := httptest.NewRequest(http.MethodPost, "/api/pair", nil)
		req.RemoteAddr = ip + ":1"
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec.Code
	}

	if call("198.51.100.1") != 200 || call("198.51.100.1") != 200 {
		t.Fatal("first two from an IP should pass")
	}
	if got := call("198.51.100.1"); got != http.StatusTooManyRequests {
		t.Fatalf("third = %d, want 429", got)
	}
	// A different IP is unaffected.
	if call("198.51.100.2") != 200 {
		t.Fatal("a fresh IP should pass")
	}
}
