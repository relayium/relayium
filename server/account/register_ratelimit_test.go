package account

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relayium/relayium/internal/signal"
)

func TestRegisterRateLimited(t *testing.T) {
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour})
	svc.SetRegisterLimiter(&fakeLimiter{limit: 5})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)

	emails := []string{
		"reg1@example.com", "reg2@example.com", "reg3@example.com",
		"reg4@example.com", "reg5@example.com",
	}
	for i, email := range emails {
		resp, err := http.Post(ts.URL+"/api/auth/register", "application/json",
			strings.NewReader(`{"email":"`+email+`","password":"longenough1"}`))
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode == http.StatusTooManyRequests {
			t.Fatalf("request %d: got 429, want non-429", i)
		}
	}

	sendsBefore := mail.sends()
	resp, err := http.Post(ts.URL+"/api/auth/register", "application/json",
		strings.NewReader(`{"email":"reg6@example.com","password":"longenough1"}`))
	if err != nil {
		t.Fatalf("6th request: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("6th request: got status %d, want %d", resp.StatusCode, http.StatusTooManyRequests)
	}
	if got := mail.sends(); got != sendsBefore {
		t.Fatalf("6th (rate-limited) request sent an email: sends went from %d to %d", sendsBefore, got)
	}
}

func TestRegisterLimiterUsesIPv6PrefixKey(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})
	ipx := signal.NewIPExtractor(nil)
	svc.SetClientIP(ipx.IP)
	svc.SetRateLimitIP(ipx.RateLimitKey)
	limiter := &fakeLimiter{limit: 10}
	svc.SetRegisterLimiter(limiter)

	for _, ip := range []string{"2001:db8:55:9::1", "2001:db8:55:9::beef"} {
		r := httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader("{"))
		r.RemoteAddr = "[" + ip + "]:443"
		w := httptest.NewRecorder()
		svc.handleRegister(w, r)
	}
	if len(limiter.keys) != 2 || limiter.keys[0] != "2001:db8:55:9::/64" || limiter.keys[1] != limiter.keys[0] {
		t.Fatalf("register limiter keys = %#v", limiter.keys)
	}
}

func TestRegisterNoLimiterUnaffected(t *testing.T) {
	store := newTestStore(t)
	mail := &capturingMailer{}
	svc := NewService(store, mail, Config{BaseURL: "http://example.test", SessionTTL: time.Hour})
	ts := httptest.NewServer(svc.Routes())
	t.Cleanup(ts.Close)

	for i := 0; i < 6; i++ {
		email := "nolimit" + string(rune('1'+i)) + "@example.com"
		resp, err := http.Post(ts.URL+"/api/auth/register", "application/json",
			strings.NewReader(`{"email":"`+email+`","password":"longenough1"}`))
		if err != nil {
			t.Fatalf("request %d: %v", i, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("request %d: got status %d, want 200", i, resp.StatusCode)
		}
	}
}
