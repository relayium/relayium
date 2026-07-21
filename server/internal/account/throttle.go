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

// PerInstanceThreshold splits a global abuse threshold across `divisor`
// round-robin instances (rounded to nearest, floored at 1). divisor <= 1 returns
// n unchanged.
//
// It exists for the multi-instance interim (docs/multi-instance-state-migration.md
// §7.5): the rate limiters and lockouts are per-process, so behind a load
// balancer their effective global budget must be reconciled with instance count.
// The PREFERRED reconciliation is not division at all but **IP-hash / sticky-by-IP
// LB routing** — then every per-IP limiter and lockout sees all of a given IP's
// traffic on one instance and enforces the full threshold correctly, so the
// divisor stays 1. Set the divisor to N only for a ROUND-ROBIN LB (where an IP's
// requests spread across instances), and note it does not fix the *global*
// GuessBreaker or make a per-instance lockout follow an attacker across
// instances — those genuinely want IP-hash routing or a shared store.
func PerInstanceThreshold(n, divisor int) int {
	if divisor <= 1 {
		return n
	}
	v := (n + divisor/2) / divisor // round to nearest
	if v < 1 {
		v = 1
	}
	return v
}

type failEntry struct {
	count     int
	lockUntil time.Time
	last      time.Time // time of the most recent failure, for decay + eviction
}

// loginThrottle is a per-key in-memory failed-login limiter. Per-IP and
// process-scoped: correct across instances when the load balancer routes by
// client IP (each IP pins to one instance, which then sees all of its failures
// and enforces the full threshold). maxFails is the lockout threshold, lowered
// by the rate-limit divisor for a round-robin LB (see PerInstanceThreshold).
type loginThrottle struct {
	mu       sync.Mutex
	maxFails int
	entries  map[string]*failEntry
}

func newLoginThrottle(maxFails int) *loginThrottle {
	if maxFails < 1 {
		maxFails = 1
	}
	return &loginThrottle{maxFails: maxFails, entries: map[string]*failEntry{}}
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
	if e.count >= t.maxFails {
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
