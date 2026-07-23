package main

import (
	"strconv"
	"testing"
)

// TestReplayGuardClaim covers the three properties the /dl route depends on:
// a token is claimable exactly once, distinct tokens don't interfere, and an
// entry stops blocking once the token it came from has expired.
func TestReplayGuardClaim(t *testing.T) {
	g := newReplayGuard()
	const now = 1000
	if !g.claim("a", now+60, now) {
		t.Fatal("first claim must succeed")
	}
	if g.claim("a", now+60, now) {
		t.Fatal("second claim of the same token must fail")
	}
	if !g.claim("b", now+60, now) {
		t.Fatal("a different token must be unaffected")
	}
	// Past the recorded expiry the entry is inert: that token can no longer be
	// presented anyway (Verify rejects it), so it must not pin memory or block a
	// later token that happens to reuse the id.
	if !g.claim("a", now+120, now+61) {
		t.Fatal("an expired entry must not block a new claim")
	}
}

// TestReplayGuardPrunes: the used-set is swept as it grows, so a long-running
// node doesn't accumulate an entry per download forever.
func TestReplayGuardPrunes(t *testing.T) {
	g := newReplayGuard()
	const now = 1000
	for i := 0; i < 4*minPruneAt; i++ {
		g.claim("k"+strconv.Itoa(i), now+10, now)
	}
	if len(g.used) < minPruneAt {
		t.Fatalf("unexpired entries were dropped: %d", len(g.used))
	}
	// Now that they're all expired, the next claim past the threshold sweeps them.
	before := len(g.used)
	for i := 0; i < 4*minPruneAt; i++ {
		g.claim("late"+strconv.Itoa(i), now+120, now+100)
	}
	if len(g.used) >= before+4*minPruneAt {
		t.Fatalf("used-set never pruned: %d entries after %d", len(g.used), before)
	}
}
