package account

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// A-L14: the send-mail endpoints were throttled per email+IP only, so requests
// spread over many source IPs could make one address receive an unbounded
// number of mails. The per-address budget caps the total.
func TestEmailSendEndpointsCapPerAddressAcrossIPs(t *testing.T) {
	const attempts = 20
	for _, tc := range []struct {
		name string
		call func(svc *Service, email string) *httptest.ResponseRecorder
	}{
		{"magic", func(svc *Service, email string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("POST", "/api/auth/magic/request", strings.NewReader(url.Values{"email": {email}}.Encode()))
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			rec := httptest.NewRecorder()
			svc.handleMagicRequest(rec, req)
			return rec
		}},
		{"forgot", func(svc *Service, email string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("POST", "/api/auth/password/forgot", strings.NewReader(`{"email":"`+email+`"}`))
			rec := httptest.NewRecorder()
			svc.handleForgotPassword(rec, req)
			return rec
		}},
		{"resend-verify", func(svc *Service, email string) *httptest.ResponseRecorder {
			req := httptest.NewRequest("POST", "/api/auth/email/resend", strings.NewReader(`{"email":"`+email+`"}`))
			rec := httptest.NewRecorder()
			svc.handleResendVerification(rec, req)
			return rec
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := newTestStore(t)
			m := &capturingMailer{}
			svc := NewService(st, m, Config{BaseURL: "https://relayium.test",
				SessionTTL: time.Hour, MagicTTL: 15 * time.Minute, VerifyTTL: 24 * time.Hour, ResetTTL: time.Hour})
			// An unverified password account: the one shape all three endpoints mail.
			if _, err := svc.Register(t.Context(), "victim@example.com", "supersecret", ""); err != nil {
				t.Fatal(err)
			}
			m.mu.Lock()
			m.count = 0
			m.mu.Unlock()
			var ip atomic.Int64
			svc.rateLimitIP = func(*http.Request) string { return fmt.Sprintf("198.51.100.%d", ip.Add(1)) }

			for range attempts {
				if rec := tc.call(svc, "victim@example.com"); rec.Code != http.StatusOK {
					t.Fatalf("want 200 on every request, got %d", rec.Code)
				}
			}
			m.mu.Lock()
			sent := m.count
			m.mu.Unlock()
			if sent != adminLoginMaxFails {
				t.Fatalf("%d requests from %d IPs sent %d mails, want the per-address budget %d", attempts, attempts, sent, adminLoginMaxFails)
			}
			// Another address is unaffected by the victim's exhausted budget.
			if _, err := svc.Register(t.Context(), "other@example.com", "supersecret", ""); err != nil {
				t.Fatal(err)
			}
			m.mu.Lock()
			m.count = 0
			m.mu.Unlock()
			tc.call(svc, "other@example.com")
			m.mu.Lock()
			sent = m.count
			m.mu.Unlock()
			if sent != 1 {
				t.Fatalf("an unrelated address sent %d mails, want 1", sent)
			}
		})
	}
}
