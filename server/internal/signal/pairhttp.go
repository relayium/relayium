// server/internal/signal/pairhttp.go
package signal

import (
	"context"
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

// reap prunes hits that have aged out of the window, then deletes any key
// whose slice is now empty, keeping the per-IP map from growing unbounded.
func (rl *RateLimiter) reap() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	cutoff := rl.now() - rl.window
	for key, hits := range rl.hits {
		kept := hits[:0]
		for _, t := range hits {
			if t > cutoff {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			delete(rl.hits, key)
		} else {
			rl.hits[key] = kept
		}
	}
}

// Run reaps idle IP entries every interval until ctx is cancelled.
func (rl *RateLimiter) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			rl.reap()
		}
	}
}

// PairHandler mints a pairing code for a logged-in user. currentUser resolves the
// request's owner (injected so this package need not depend on the account layer);
// an anonymous request is rejected with 401 — cross-network rendezvous requires an
// owning account, while the receiver still joins the code room anonymously. The
// IPExtractor determines the rate-limit key (see IPExtractor for the
// X-Forwarded-For policy).
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
		if code == "" {
			// 码空间被活码占满（配置事故，见 maxMintAttempts）。宁可明确报错，
			// 也不要把空串当成码发出去——那会让前端显示一个谁也加入不了的"码"。
			http.Error(w, "could not mint a pairing code, try again", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "expiresAt": exp})
	}
}
