package account

import (
	"testing"
	"time"
)

func TestPerInstanceThreshold(t *testing.T) {
	cases := []struct{ n, div, want int }{
		{5, 1, 5},   // single instance / IP-hash: unchanged
		{5, 0, 5},   // 0 treated as 1
		{5, -1, 5},  // negative treated as 1
		{5, 2, 3},   // round to nearest (2.5 -> 3)
		{5, 3, 2},   // 1.67 -> 2
		{5, 5, 1},   // exactly 1
		{5, 10, 1},  // would be 0.5 -> floored at 1
		{1, 3, 1},   // would be 0 -> floored at 1
		{200, 3, 67}, // breaker threshold
		{30, 4, 8},  // ws limiter (7.5 -> 8)
	}
	for _, c := range cases {
		if got := PerInstanceThreshold(c.n, c.div); got != c.want {
			t.Errorf("PerInstanceThreshold(%d,%d)=%d want %d", c.n, c.div, got, c.want)
		}
	}
}

// A divided lockout threshold locks sooner (round-robin interim: each instance
// sees ~1/N of an attacker's failures, so it must lock at ~1/N the count).
func TestLoginThrottleHonorsDividedThreshold(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	tr := newLoginThrottle(PerInstanceThreshold(5, 5)) // -> 1
	tr.recordFail("ip", now)
	if !tr.locked("ip", now) {
		t.Fatal("a threshold-1 throttle must lock after a single failure")
	}

	// Divisor 1 keeps the full threshold: 4 fails not locked, 5th locks.
	full := newLoginThrottle(PerInstanceThreshold(5, 1)) // -> 5
	for i := 0; i < 4; i++ {
		full.recordFail("ip", now)
	}
	if full.locked("ip", now) {
		t.Fatal("full threshold must not lock before 5 failures")
	}
	full.recordFail("ip", now)
	if !full.locked("ip", now) {
		t.Fatal("full threshold must lock on the 5th failure")
	}
}

// The Config divisor propagates to the Service's login throttles.
func TestServiceAppliesRateLimitDivisor(t *testing.T) {
	svc := NewService(newTestStore(t), nil, Config{RateLimitDivisor: 5})
	now := svc.now()
	// PerInstanceThreshold(5,5)=1, so a single admin-login failure locks the IP.
	svc.adminLogins.recordFail("1.2.3.4", now)
	if !svc.adminLogins.locked("1.2.3.4", now) {
		t.Fatal("with divisor 5 the admin-login lockout threshold is 1; one failure must lock")
	}
}
