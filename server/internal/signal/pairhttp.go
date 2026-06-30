// server/internal/signal/pairhttp.go
package signal

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// RateLimiter is a simple per-key fixed-window counter (key = client IP). It is
// intentionally minimal: bounded memory via lazy pruning on each Allow call.
type RateLimiter struct {
	mu     sync.Mutex
	hits   map[string][]int64
	limit  int
	window int64
	now    func() int64
}

func NewRateLimiter(limit int, window time.Duration, now func() int64) *RateLimiter {
	return &RateLimiter{hits: make(map[string][]int64), limit: limit, window: int64(window.Seconds()), now: now}
}

// Allow records a hit for key and reports whether it stays within limit over the
// trailing window.
func (rl *RateLimiter) Allow(key string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := rl.now()
	cutoff := now - rl.window
	kept := rl.hits[key][:0]
	for _, t := range rl.hits[key] {
		if t > cutoff {
			kept = append(kept, t)
		}
	}
	if len(kept) >= rl.limit {
		rl.hits[key] = kept
		return false
	}
	rl.hits[key] = append(kept, now)
	return true
}

// PairHandler serves the anonymous POST /api/pair endpoint: it rate-limits by
// client IP, then mints a short rendezvous code. No auth, no DB.
func PairHandler(reg *PairRegistry, rl *RateLimiter) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := ClientIP(r)
		if !rl.Allow(ip) {
			http.Error(w, "too many pairing requests", http.StatusTooManyRequests)
			return
		}
		code, exp := reg.Mint()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "expiresAt": exp})
	}
}
