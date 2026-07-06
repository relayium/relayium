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
	h := PairHandler(reg, rl, NewIPExtractor(nil), alwaysAuthed)

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

func TestPairHandlerRateLimitsPerIP(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(2, time.Minute, now)
	h := PairHandler(reg, rl, NewIPExtractor(nil), alwaysAuthed)

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
