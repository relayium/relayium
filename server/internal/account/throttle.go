package account

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	adminLoginMaxFails   = 5
	adminLoginLockWindow = 15 * time.Minute
)

type failEntry struct {
	count     int
	lockUntil time.Time
	last      time.Time // time of the most recent failure, for decay + eviction
}

// loginThrottle is a per-key in-memory failed-login limiter. Process-scoped,
// like admin sessions — no persistence needed.
type loginThrottle struct {
	mu      sync.Mutex
	entries map[string]*failEntry
}

func newLoginThrottle() *loginThrottle {
	return &loginThrottle{entries: map[string]*failEntry{}}
}

// locked reports whether key is currently within a lockout window.
func (t *loginThrottle) locked(key string, now time.Time) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.entries[key]
	if e == nil {
		return false
	}
	if !e.lockUntil.IsZero() && now.Before(e.lockUntil) {
		return true
	}
	// lock expired: forget the entry so counting restarts clean.
	if !e.lockUntil.IsZero() && !now.Before(e.lockUntil) {
		delete(t.entries, key)
	}
	return false
}

// recordFail increments the failure count for key and arms a lockout once the
// threshold is reached. Failures separated by more than the lock window are not
// "consecutive": the count restarts. It also sweeps stale entries so the map
// stays bounded by the set of recently-active keys rather than growing forever.
func (t *loginThrottle) recordFail(key string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sweep(now)
	e := t.entries[key]
	if e == nil {
		e = &failEntry{}
		t.entries[key] = e
	}
	// A gap longer than the window since the last failure restarts the count.
	if !e.last.IsZero() && now.Sub(e.last) > adminLoginLockWindow {
		e.count = 0
		e.lockUntil = time.Time{}
	}
	e.count++
	e.last = now
	if e.count >= adminLoginMaxFails {
		e.lockUntil = now.Add(adminLoginLockWindow)
	}
}

// sweep drops entries that are neither still locked nor recently active, so a
// stream of one-off failures from many IPs cannot grow the map without bound.
// Caller must hold t.mu.
func (t *loginThrottle) sweep(now time.Time) {
	for k, e := range t.entries {
		if now.Before(e.lockUntil) {
			continue // still serving a lockout
		}
		if now.Sub(e.last) > adminLoginLockWindow {
			delete(t.entries, k)
		}
	}
}

// reset clears any failure state for key (call on successful login).
func (t *loginThrottle) reset(key string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, key)
}

// clientIP returns the client's IP: first X-Forwarded-For entry when a reverse
// proxy sets it, else RemoteAddr with the port stripped. Mirrors
// internal/signal.ClientIP — SAME DEPLOYMENT CONTRACT: the proxy MUST overwrite
// (not append) X-Forwarded-For, else an attacker can spoof the leading entry
// and dodge the per-IP admin-login limit.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
