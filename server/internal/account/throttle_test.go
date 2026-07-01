package account

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestLoginThrottleLocksAfterThreshold(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < adminLoginMaxFails; i++ {
		if tr.locked("1.2.3.4", now) {
			t.Fatalf("should not be locked before threshold (i=%d)", i)
		}
		tr.recordFail("1.2.3.4", now)
	}
	if !tr.locked("1.2.3.4", now) {
		t.Fatal("should be locked after threshold reached")
	}
}

func TestLoginThrottleUnlocksAfterWindow(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < adminLoginMaxFails; i++ {
		tr.recordFail("1.2.3.4", now)
	}
	later := now.Add(adminLoginLockWindow + time.Second)
	if tr.locked("1.2.3.4", later) {
		t.Fatal("should unlock after lock window passes")
	}
}

func TestLoginThrottleResetOnSuccess(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < adminLoginMaxFails-1; i++ {
		tr.recordFail("1.2.3.4", now)
	}
	tr.reset("1.2.3.4")
	tr.recordFail("1.2.3.4", now) // one fail after reset
	if tr.locked("1.2.3.4", now) {
		t.Fatal("reset should clear prior failure count")
	}
}

func TestLoginThrottlePerKey(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	for i := 0; i < adminLoginMaxFails; i++ {
		tr.recordFail("1.1.1.1", now)
	}
	if tr.locked("2.2.2.2", now) {
		t.Fatal("different key must not be affected")
	}
}

func TestLoginThrottleEvictsStaleEntries(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	// Key A accumulates sub-threshold failures (count 2, never locked).
	tr.recordFail("1.1.1.1", now)
	tr.recordFail("1.1.1.1", now)
	// A later failure for a different key, past the window, must sweep A's
	// stale entry so the map doesn't grow unbounded with sub-threshold keys.
	later := now.Add(adminLoginLockWindow + time.Second)
	tr.recordFail("2.2.2.2", later)
	if _, ok := tr.entries["1.1.1.1"]; ok {
		t.Fatal("stale sub-threshold entry should have been evicted")
	}
	if len(tr.entries) != 1 {
		t.Fatalf("only the fresh key should remain, got %d entries", len(tr.entries))
	}
}

func TestLoginThrottleDecaysCountAfterWindow(t *testing.T) {
	tr := newLoginThrottle()
	now := time.Unix(1_700_000_000, 0)
	// Four failures (one below threshold), never locked.
	for i := 0; i < adminLoginMaxFails-1; i++ {
		tr.recordFail("1.2.3.4", now)
	}
	// A failure after the window elapsed is not "consecutive": the count
	// restarts rather than tipping into a lockout.
	later := now.Add(adminLoginLockWindow + time.Second)
	tr.recordFail("1.2.3.4", later)
	if tr.locked("1.2.3.4", later) {
		t.Fatal("a failure after the window should restart the count, not lock")
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("POST", "/admin/login", nil)
	r.RemoteAddr = "9.9.9.9:5555"
	if got := clientIP(r); got != "9.9.9.9" {
		t.Fatalf("RemoteAddr host: got %q", got)
	}
	r.Header.Set("X-Forwarded-For", "5.5.5.5, 9.9.9.9")
	if got := clientIP(r); got != "5.5.5.5" {
		t.Fatalf("XFF first entry: got %q", got)
	}
}
