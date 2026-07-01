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
// threshold is reached.
func (t *loginThrottle) recordFail(key string, now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e := t.entries[key]
	if e == nil {
		e = &failEntry{}
		t.entries[key] = e
	}
	e.count++
	if e.count >= adminLoginMaxFails {
		e.lockUntil = now.Add(adminLoginLockWindow)
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
