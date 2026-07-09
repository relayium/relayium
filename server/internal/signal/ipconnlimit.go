package signal

import "sync"

// maxConnsPerIP bounds concurrent /ws connections from a single client IP so one
// source cannot exhaust server memory/goroutines. Tunable.
const maxConnsPerIP = 20

// IPConnLimiter is a per-IP concurrent-connection counter. Empty entries are
// pruned on release to keep the map bounded (same pattern as RateLimiter).
type IPConnLimiter struct {
	mu sync.Mutex
	n  map[string]int
}

func NewIPConnLimiter() *IPConnLimiter {
	return &IPConnLimiter{n: make(map[string]int)}
}

// Acquire reserves a connection slot for ip, returning false when ip is already
// at maxConnsPerIP. A successful Acquire must be balanced by exactly one Release.
func (l *IPConnLimiter) Acquire(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.n[ip] >= maxConnsPerIP {
		return false
	}
	l.n[ip]++
	return true
}

// Release frees a slot for ip and drops the map entry when it reaches zero.
func (l *IPConnLimiter) Release(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.n[ip] <= 1 {
		delete(l.n, ip)
		return
	}
	l.n[ip]--
}
