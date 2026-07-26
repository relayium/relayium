package signal

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestGlobalConnLimiterCapsAtLimit(t *testing.T) {
	l := NewGlobalConnLimiter()
	for i := 0; i < maxGlobalConns; i++ {
		if !l.Acquire() {
			t.Fatalf("acquire %d under cap should succeed", i)
		}
	}
	if l.Acquire() {
		t.Fatal("acquire past the global cap must fail")
	}
}

func TestGlobalConnLimiterReleaseFreesSlot(t *testing.T) {
	l := NewGlobalConnLimiter()
	for i := 0; i < maxGlobalConns; i++ {
		l.Acquire()
	}
	l.Release()
	if !l.Acquire() {
		t.Fatal("after a release a new acquire should succeed")
	}
}

// TestGlobalConnLimiterRejectedAcquireDoesNotLeakSlot is the highest-value
// test in this file: a rejected Acquire that nonetheless incremented the
// counter would permanently shrink the effective cap by one every time the
// server is at capacity, turning a transient traffic spike into a permanent,
// ever-worsening outage.
func TestGlobalConnLimiterRejectedAcquireDoesNotLeakSlot(t *testing.T) {
	l := NewGlobalConnLimiter()
	for i := 0; i < maxGlobalConns; i++ {
		if !l.Acquire() {
			t.Fatalf("acquire %d under cap should succeed", i)
		}
	}
	// At cap: this Acquire must fail...
	if l.Acquire() {
		t.Fatal("acquire at cap should fail")
	}
	// ...and, critically, must not have consumed a slot. Free exactly one real
	// slot: if the rejected Acquire above had leaked a slot, the cap would now
	// effectively be maxGlobalConns-1, and freeing one real slot would still
	// leave us at capacity.
	l.Release()
	if !l.Acquire() {
		t.Fatal("after freeing one real slot, one acquire should succeed")
	}
	if l.Acquire() {
		t.Fatal("a second acquire should fail: the earlier rejected acquire must not have consumed a slot")
	}
}

// TestGlobalConnLimiterConcurrentAcquireRelease exercises Acquire/Release from
// many goroutines at once (run with -race) and checks the counter lands back
// at exactly zero once every successful acquire has been released — a data
// race or lost update here would desync the live count from reality and
// either wrongly reject traffic or let the server run over its budget.
func TestGlobalConnLimiterConcurrentAcquireRelease(t *testing.T) {
	l := NewGlobalConnLimiter()
	const workers = 500
	const roundsPerWorker = 50
	var wg sync.WaitGroup
	var accepted int64
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for r := 0; r < roundsPerWorker; r++ {
				if l.Acquire() {
					atomic.AddInt64(&accepted, 1)
					l.Release()
				}
			}
		}()
	}
	wg.Wait()
	if accepted == 0 {
		t.Fatal("expected at least some concurrent acquires to succeed")
	}
	if !l.Acquire() {
		t.Fatal("counter should be back at zero after every acquire was released, so one more acquire should succeed")
	}
}

// TestGlobalConnLimiterNeverExceedsCapUnderConcurrency drives concurrent
// Acquire calls well past the cap and checks that exactly maxGlobalConns of
// them succeed — proving the mutex actually serializes the check-and-increment
// rather than merely avoiding a crash under -race.
func TestGlobalConnLimiterNeverExceedsCapUnderConcurrency(t *testing.T) {
	l := NewGlobalConnLimiter()
	const extra = 500
	var wg sync.WaitGroup
	var accepted int64
	for i := 0; i < maxGlobalConns+extra; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if l.Acquire() {
				atomic.AddInt64(&accepted, 1)
			}
		}()
	}
	wg.Wait()
	if accepted != maxGlobalConns {
		t.Fatalf("expected exactly %d concurrent acquires to succeed, got %d", maxGlobalConns, accepted)
	}
}
