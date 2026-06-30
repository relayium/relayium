// server/internal/signal/pairhttp_test.go
package signal

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPairHandlerMints(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(5, time.Minute, now)
	h := PairHandler(reg, rl)

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

func TestPairHandlerRateLimitsPerIP(t *testing.T) {
	clock := int64(1000)
	now := func() int64 { return clock }
	reg := NewPairRegistry(300, now)
	rl := NewRateLimiter(2, time.Minute, now)
	h := PairHandler(reg, rl)

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
