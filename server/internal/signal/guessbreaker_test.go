package signal

import (
	"testing"
	"time"
)

func TestGuessBreakerTripsAndCoolsDown(t *testing.T) {
	now := int64(1000)
	clock := func() int64 { return now }
	b := NewGuessBreaker(3, time.Minute, 30*time.Second, clock) // threshold 3 for the test

	// Under threshold: not open.
	for i := 0; i < 3; i++ {
		if open, _ := b.RecordInvalid(); open {
			t.Fatalf("attempt %d: breaker should be closed under threshold", i)
		}
	}
	// The next attempt exceeds the window budget -> open.
	open, logNow := b.RecordInvalid()
	if !open {
		t.Fatal("breaker should be OPEN after exceeding threshold in the window")
	}
	if !logNow {
		t.Fatal("first open should signal a WARN log")
	}
	// Still within cooldown -> stays open, but log is throttled (no second log).
	now += 5
	if open, logNow := b.RecordInvalid(); !open || logNow {
		t.Fatalf("within cooldown: want open=true logNow=false, got open=%v logNow=%v", open, logNow)
	}
	// After the cooldown with no new over-budget bursts -> closes.
	now += 60 // past cooldown and past the 1-min window (attempts aged out)
	if open, _ := b.RecordInvalid(); open {
		t.Fatal("breaker should auto-close after cooldown once the burst subsides")
	}
}

func TestGuessBreakerLogThrottledToCooldown(t *testing.T) {
	now := int64(0)
	b := NewGuessBreaker(1, time.Minute, 30*time.Second, func() int64 { return now })
	b.RecordInvalid() // 1 (budget)
	if _, logNow := b.RecordInvalid(); !logNow { // 2 -> over -> open, first log
		t.Fatal("first open should log")
	}
	now += 29
	if _, logNow := b.RecordInvalid(); logNow {
		t.Fatal("log must be throttled within cooldown")
	}
	now += 2 // now 31 >= last log + 30
	if _, logNow := b.RecordInvalid(); !logNow {
		t.Fatal("log allowed again after cooldown elapses while still open")
	}
}
