package account

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/relayium/relayium/httpx"
)

const (
	passwordAttemptsPerMinute = 20
	passwordAttemptSources    = 8192
	emailSendBudgetKeys       = 32768
	passwordResetCooldown     = time.Minute
)

type passwordAttemptEntry struct {
	start time.Time
	count int
}

// passwordAttemptBudget bounds password work before either login handler reaches
// bcrypt. It is per source, shared by web/native, and never locks an email across
// unrelated sources. Like the existing lockouts this is per process; sticky-IP
// routing (or RateLimitDivisor) is required with multiple server instances.
type passwordAttemptBudget struct {
	mu      sync.Mutex
	limit   int
	entries map[string]passwordAttemptEntry
}

func newPasswordAttemptBudget(limit int) *passwordAttemptBudget {
	return &passwordAttemptBudget{limit: limit, entries: make(map[string]passwordAttemptEntry)}
}

func (b *passwordAttemptBudget) allow(key string, now time.Time) (bool, time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	e, exists := b.entries[key]
	if exists && (now.Before(e.start) || !now.Before(e.start.Add(time.Minute))) {
		delete(b.entries, key)
		exists = false
	}
	if !exists {
		// A cardinality flood must not allocate unbounded source state. Sweep only
		// when full; existing sources retain their own budget during saturation.
		if len(b.entries) >= passwordAttemptSources {
			for k, v := range b.entries {
				if now.Before(v.start) || !now.Before(v.start.Add(time.Minute)) {
					delete(b.entries, k)
				}
			}
			if len(b.entries) >= passwordAttemptSources {
				return false, time.Minute
			}
		}
		e = passwordAttemptEntry{start: now}
	}
	if e.count >= b.limit {
		return false, e.start.Add(time.Minute).Sub(now)
	}
	e.count++
	b.entries[key] = e
	return true, 0
}

func (s *Service) allowPasswordAttempt(w http.ResponseWriter, r *http.Request) bool {
	ok, wait := s.passwordAttempts.allow(s.rateLimitIP(r), s.now())
	if ok {
		return true
	}
	seconds := int((wait + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	httpx.WriteJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too many attempts, try again later"})
	return false
}

// reserveEmail atomically spends both send budgets. Checking and incrementing
// through separate mutex acquisitions lets concurrent requests pass a budget
// they all observed before any of them spent it. A reset's address-wide cooldown
// also lives inside this reservation, so changing IP cannot evade it. Rejected
// requests change no counters and cannot extend the owner's waiting period.
func (t *loginThrottle) reserveEmail(sourceKey, budgetKey string, now time.Time, cooldown time.Duration) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sweep(now)
	keys := [2]string{sourceKey, budgetKey}
	missing := 0
	for _, key := range keys {
		e := t.entries[key]
		if e != nil && !e.lockUntil.IsZero() {
			if now.Before(e.lockUntil) {
				return false
			}
			delete(t.entries, key)
			e = nil
		}
		if e == nil {
			missing++
		}
	}
	if len(t.entries)+missing > emailSendBudgetKeys {
		return false
	}
	if e := t.entries[budgetKey]; e != nil && cooldown > 0 && !e.last.IsZero() && now.Sub(e.last) < cooldown {
		return false
	}
	for _, key := range keys {
		e := t.entries[key]
		if e == nil {
			e = &failEntry{}
			t.entries[key] = e
		}
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
	return true
}

func (s *Service) allowPasswordResetEmail(email string, r *http.Request) bool {
	return s.resetRequests.reserveEmail(email+"|"+s.rateLimitIP(r), emailBudgetKey(email), s.now(), passwordResetCooldown)
}
