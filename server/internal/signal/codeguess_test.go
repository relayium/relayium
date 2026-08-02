package signal

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func newTestGuessBudget(limit int, clock *int64) *CodeGuessLimiter {
	return NewCodeGuessLimiter(limit, time.Minute, func() int64 { return *clock })
}

// The core property: the budget counts DISTINCT candidates, so the sixth
// different code is refused while the first five are admitted.
func TestCodeGuessLimiterRefusesTheSixthDistinctCandidate(t *testing.T) {
	clock := int64(1_000)
	l := newTestGuessBudget(5, &clock)
	for i := 1; i <= 5; i++ {
		if !l.AllowCode("203.0.113.7", fmt.Sprintf("%06d", 900_000+i)) {
			t.Fatalf("candidate %d refused inside the budget", i)
		}
	}
	if l.AllowCode("203.0.113.7", "900999") {
		t.Fatal("the sixth distinct candidate was admitted")
	}
}

// A real client presents one code to /api/ice and then the same code to /ws.
// That is one guess and must cost one slot, or the honest budget would be 2 or 3
// candidates rather than 5.
func TestCodeGuessLimiterChargesARepeatedCodeOnce(t *testing.T) {
	clock := int64(1_000)
	l := newTestGuessBudget(5, &clock)
	for i := 0; i < 20; i++ {
		if !l.AllowCode("203.0.113.7", "424242") {
			t.Fatalf("repeat %d of the same code was refused", i)
		}
	}
	// Four more distinct codes still fit: the repeats consumed exactly one slot.
	for i := 1; i <= 4; i++ {
		if !l.AllowCode("203.0.113.7", fmt.Sprintf("%06d", 100_000+i)) {
			t.Fatalf("distinct candidate %d refused — repeats over-charged the budget", i)
		}
	}
	if l.AllowCode("203.0.113.7", "999999") {
		t.Fatal("the sixth distinct candidate was admitted")
	}
}

// Per-IP, not global: one address exhausting its budget must not deny another.
func TestCodeGuessLimiterIsPerIP(t *testing.T) {
	clock := int64(1_000)
	l := newTestGuessBudget(5, &clock)
	for i := 1; i <= 6; i++ {
		l.AllowCode("203.0.113.7", fmt.Sprintf("%06d", 700_000+i))
	}
	if !l.AllowCode("198.51.100.4", "700001") {
		t.Fatal("a different address was refused out of the first address's budget")
	}
}

// The window really is trailing: past it the candidates expire and the address
// is served again.
func TestCodeGuessLimiterExpiresCandidates(t *testing.T) {
	clock := int64(1_000)
	l := newTestGuessBudget(5, &clock)
	for i := 1; i <= 5; i++ {
		l.AllowCode("203.0.113.7", fmt.Sprintf("%06d", 800_000+i))
	}
	if l.AllowCode("203.0.113.7", "800999") {
		t.Fatal("the sixth distinct candidate was admitted inside the window")
	}
	clock += 61
	if !l.AllowCode("203.0.113.7", "800999") {
		t.Fatal("candidates did not expire after the trailing window")
	}
	// And the reaper forgets an address that has gone quiet, so the map does not
	// grow with every source that ever guessed once.
	clock += 61
	l.reap()
	l.mu.Lock()
	n := len(l.seen)
	l.mu.Unlock()
	if n != 0 {
		t.Fatalf("reap left %d idle address entries", n)
	}
}

// Candidates are strings. A limiter that parsed them as numbers would merge
// "000042" with "42" and hand an attacker a free extra guess.
func TestCodeGuessLimiterKeepsLeadingZeroCandidatesDistinct(t *testing.T) {
	clock := int64(1_000)
	l := newTestGuessBudget(2, &clock)
	if !l.AllowCode("203.0.113.7", "000042") {
		t.Fatal("first candidate refused")
	}
	if !l.AllowCode("203.0.113.7", "42") {
		t.Fatal(`"42" was refused — it should be a second, distinct candidate`)
	}
	if l.AllowCode("203.0.113.7", "000043") {
		t.Fatal(`"000042" and "42" were treated as one candidate`)
	}
}

// An empty code is a LAN request, not a pairing-code guess: never counted, never
// refused, and it must not even take a slot away from later real candidates.
func TestCodeGuessLimiterIgnoresTheEmptyCode(t *testing.T) {
	clock := int64(1_000)
	l := newTestGuessBudget(1, &clock)
	for i := 0; i < 50; i++ {
		if !l.AllowCode("203.0.113.7", "") {
			t.Fatal("an empty code was refused")
		}
	}
	if !l.AllowCode("203.0.113.7", "123456") {
		t.Fatal("empty codes consumed the real candidate budget")
	}
}

// A mis-wired zero budget must fail closed rather than silently disable the gate.
func TestCodeGuessLimiterZeroLimitFailsClosed(t *testing.T) {
	clock := int64(1_000)
	l := newTestGuessBudget(0, &clock)
	if l.AllowCode("203.0.113.7", "123456") {
		t.Fatal("a zero budget admitted a candidate")
	}
	if !l.AllowCode("203.0.113.7", "") {
		t.Fatal("a zero budget refused an empty (non-guess) code")
	}
}

// Both handlers call this from their own goroutines, so the map must be safe
// under concurrency. Run with -race.
func TestCodeGuessLimiterIsConcurrencySafe(t *testing.T) {
	clock := int64(1_000)
	l := newTestGuessBudget(5, &clock)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				l.AllowCode(fmt.Sprintf("198.51.100.%d", i), fmt.Sprintf("%06d", j))
			}
		}(i)
	}
	wg.Wait()
}
