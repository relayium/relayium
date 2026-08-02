package signal

import (
	"context"
	"sync"
	"time"
)

// CodeGuessLimiter caps how many DISTINCT pairing-code candidates one client IP
// may present per trailing window — counted ACROSS every endpoint that answers,
// in any observable way, whether a code is live.
//
// Why this exists separately from the per-endpoint RateLimiters: /ws?code= and
// /api/ice?code= are two halves of ONE oracle. /ws refuses an unknown code with
// 403 and admits a live one; /api/ice always answers 200 but only puts a turn:
// entry in the body for a live code (see account.handleICE). Both therefore
// reveal validity, and both used to spend their own independent 5/min/IP budget,
// so an attacker who split guesses across the two endpoints got ~10 candidates
// per minute from one address — double the number the design claimed.
//
// The product boundary is one same-IP pairing-code input budget over both
// oracles, which is what this type is: a trailing window over the SET of
// candidate strings an IP has presented, not over its request count.
//
//   - The same IP presenting the same code again — including the ordinary
//     /api/ice-then-/ws pair a real client makes for one code — occupies the one
//     slot that code already took. A real receiver spends exactly one.
//   - The (limit+1)-th DIFFERENT code inside the window is refused on whichever
//     endpoint it arrives at, however the first `limit` were split between them.
//   - An empty code is not a guess and is never counted (LAN /api/ice and LAN
//     /ws both pass no code at all).
//   - Codes are compared as strings, so "000042" and "42" are different
//     candidates and a leading zero is never normalised away.
//
// This is a per-process bound, like every other limiter here. Behind a
// round-robin load balancer an IP's requests land on several instances and each
// enforces its own budget, which is what account.PerInstanceThreshold divides
// for; sticky/IP-hash routing is the arrangement under which the figure is
// actually the figure. Do not describe it as a global or cross-instance cap.
//
// The raw per-endpoint request limiters stay in place alongside this one: they
// bound repeated identical requests (which cost the server work but cost this
// budget nothing) and are the thing that stops a single code being hammered.
type CodeGuessLimiter struct {
	mu sync.Mutex
	// seen maps client IP -> candidate code -> last-seen unix secs. The inner map
	// holds at most `limit` live entries per IP, and Run reaps IPs that go idle.
	seen   map[string]map[string]int64
	limit  int
	window int64
	now    func() int64
}

// NewCodeGuessLimiter builds a limiter admitting `limit` distinct candidate
// codes per IP per window. limit <= 0 refuses every non-empty candidate: this is
// a security gate, so a mis-wired zero must fail closed and be obvious rather
// than silently disable the cap. "No cap" is expressed by passing no limiter at
// all (the call sites nil-check).
func NewCodeGuessLimiter(limit int, window time.Duration, now func() int64) *CodeGuessLimiter {
	return &CodeGuessLimiter{
		seen:   make(map[string]map[string]int64),
		limit:  limit,
		window: int64(window.Seconds()),
		now:    now,
	}
}

// AllowCode records `code` as a candidate presented by `ip` and reports whether
// that IP stays within its distinct-candidate budget for the trailing window.
// An empty code is always allowed and never recorded — it is not a guess.
//
// Repeating a code already inside the window refreshes its timestamp instead of
// taking a second slot: the two requests are the same guess, and one live code
// held open by a working client must not decay into a fresh charge mid-session.
func (l *CodeGuessLimiter) AllowCode(ip, code string) bool {
	if code == "" {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now - l.window
	codes := l.seen[ip]
	for c, t := range codes {
		if t <= cutoff {
			delete(codes, c)
		}
	}
	if _, ok := codes[code]; ok {
		codes[code] = now
		return true
	}
	if len(codes) >= l.limit {
		return false
	}
	if codes == nil {
		codes = make(map[string]int64, l.limit)
		l.seen[ip] = codes
	}
	codes[code] = now
	return true
}

// reap drops candidates that have aged out of the window and forgets any IP left
// with none, so the map tracks only currently-guessing addresses.
func (l *CodeGuessLimiter) reap() {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := l.now() - l.window
	for ip, codes := range l.seen {
		for c, t := range codes {
			if t <= cutoff {
				delete(codes, c)
			}
		}
		if len(codes) == 0 {
			delete(l.seen, ip)
		}
	}
}

// Run reaps idle entries every interval until ctx is cancelled.
func (l *CodeGuessLimiter) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			l.reap()
		}
	}
}
