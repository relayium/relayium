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

// PairAdmission decides whether the account this request resolved to may be
// handed a pairing code AT ALL, as opposed to how fast it may ask for one.
//
// It answers "" to admit, or a STABLE MACHINE-READABLE refusal code the client
// branches on — never prose. The client has to tell this refusal apart from the
// IP rate limiter's, which shares its status: one means "this account cannot use
// the rendezvous it is asking for" and leads to an upgrade/LAN screen, the other
// means "slow down" and leads to a retry.
//
// Injected, like currentUser above and for the same reason: the question is an
// account-layer one (is this owner's monthly cross-network allowance spent?) and
// this package must not learn how to ask it. The dependency runs account →
// signal, never back.
type PairAdmission func(r *http.Request, userID string) string

// PairHandler mints a pairing code for a logged-in user. currentUser resolves the
// request's owner (injected so this package need not depend on the account layer);
// an anonymous request is rejected with 401 — cross-network rendezvous requires an
// owning account, while the receiver still joins the code room anonymously. The
// IPExtractor determines the rate-limit key (see IPExtractor for the
// X-Forwarded-For policy).
//
// `admit` is the pre-mint admission gate (B3). Nil means no gate at all, which is
// the old behaviour exactly. It runs AFTER the login check — so it is never asked
// about an anonymous "" — and IMMEDIATELY BEFORE MintFor, with nothing in
// between, because this is the authoritative answer: a client-side preflight can
// be stale by the time the button is clicked, and a CLI or bearer client never
// asks one. A refusal allocates nothing; a code taken out of a 10^6 space and
// handed to nobody collides with real mints for its whole TTL.
func PairHandler(reg *PairRegistry, rl *RateLimiter, ipx *IPExtractor, currentUser func(*http.Request) (string, bool), admit PairAdmission, afterMint ...func()) http.HandlerFunc {
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
		// Ordered after the limiter on purpose: a guessing or retry flood must not
		// turn into a flood of quota reads against the database.
		if admit != nil {
			if reason := admit(r, userID); reason != "" {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": reason})
				return
			}
		}
		code, exp := reg.MintFor(userID)
		if code == "" {
			// 码空间被活码占满（配置事故，见 maxMintAttempts）。宁可明确报错，
			// 也不要把空串当成码发出去——那会让前端显示一个谁也加入不了的"码"。
			http.Error(w, "could not mint a pairing code, try again", http.StatusServiceUnavailable)
			return
		}
		// The optional observer runs only after MintFor succeeded and is
		// panic-contained: aggregate accounting must never fail or crash an
		// otherwise successful product action. Production's callback is a bounded
		// non-blocking queue write, so this adds no per-request goroutine.
		if len(afterMint) > 0 && afterMint[0] != nil {
			observe := afterMint[0]
			func() {
				defer func() { _ = recover() }()
				observe()
			}()
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "expiresAt": exp})
	}
}
