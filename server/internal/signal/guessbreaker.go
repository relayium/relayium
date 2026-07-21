package signal

import (
	"sync"
	"time"
)

// guessBreakerKey is the single global key under which all invalid pairing-code
// join attempts are counted (the breaker is process-wide, not per-IP).
const guessBreakerKey = "global"

// GuessBreaker is a process-wide detector for pairing-code brute-forcing. It
// counts INVALID /ws?code= attempts in a fixed window; once the window budget is
// exceeded it latches OPEN for a cooldown. It never inspects or blocks valid
// codes — callers only feed it invalid attempts — so it cannot deny a legitimate
// join. When open, callers shed the invalid attempt (429) and log (throttled).
type GuessBreaker struct {
	rl       *RateLimiter // windowed count of invalid attempts under guessBreakerKey
	cooldown int64        // seconds the breaker stays open after a trip
	now      func() int64

	mu        sync.Mutex
	openUntil int64 // unix secs until which the breaker is OPEN (open iff now < openUntil)
	nextLogAt int64 // earliest unix secs a WARN may be emitted again
}

func NewGuessBreaker(threshold int, window, cooldown time.Duration, now func() int64) *GuessBreaker {
	return &GuessBreaker{
		rl:       NewRateLimiter(threshold, window, now),
		cooldown: int64(cooldown.Seconds()),
		now:      now,
	}
}

// IsOpen reports whether the breaker is currently latched open, WITHOUT
// recording an attempt. Lets a caller (e.g. /api/ice on a valid or empty code,
// which never feeds the breaker) shed credential issuance during an active
// brute-force flood detected via other requests.
func (b *GuessBreaker) IsOpen() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.now() < b.openUntil
}

// RecordInvalid records one invalid pairing-code attempt and reports whether the
// breaker is currently OPEN and whether the caller should emit a WARN now (at
// most once per cooldown while open). Uses absolute deadlines (openUntil /
// nextLogAt) rather than a "0 = never" sentinel so it behaves correctly even at
// unix time 0 (unit tests use a clock starting at 0).
func (b *GuessBreaker) RecordInvalid() (open, logNow bool) {
	over := !b.rl.Allow(guessBreakerKey) // false => window budget exceeded
	now := b.now()
	b.mu.Lock()
	defer b.mu.Unlock()
	if over {
		b.openUntil = now + b.cooldown // (re)arm / extend the open window
	}
	open = now < b.openUntil
	if open && now >= b.nextLogAt {
		b.nextLogAt = now + b.cooldown
		logNow = true
	}
	return open, logNow
}
