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
