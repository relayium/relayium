package account

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// device/start is unauthenticated (the CLI's very first call), so it shares
// the register endpoint's anti-abuse limiter to keep cli_device_auth bounded.
func TestDeviceStartRateLimited(t *testing.T) {
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour})
	svc.SetRegisterLimiter(&fakeLimiter{limit: 5})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)

	for i := 0; i < 5; i++ {
		resp, err := http.Post(ts.URL+"/api/cli/device/start", "application/json", strings.NewReader(`{}`))
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("request %d: got 429, want non-429", i)
		}
	}

	resp, err := http.Post(ts.URL+"/api/cli/device/start", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("6th request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("6th request: got status %d, want %d", resp.StatusCode, http.StatusTooManyRequests)
	}
}

func TestDeviceStartNoLimiterUnaffected(t *testing.T) {
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)

	for i := 0; i < 6; i++ {
		resp, err := http.Post(ts.URL+"/api/cli/device/start", "application/json", strings.NewReader(`{}`))
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("request %d: got status %d, want 200", i, resp.StatusCode)
		}
	}
}
