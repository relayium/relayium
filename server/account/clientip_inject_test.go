package account

import (
	"net/http/httptest"
	"testing"

	"github.com/relayium/relayium/internal/signal"
)

func TestClientIPDefaultsToPackageFunc(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})

	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.9:1234"
	if got := svc.clientIP(r); got != "203.0.113.9" {
		t.Fatalf("clientIP = %q, want %q", got, "203.0.113.9")
	}

	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := svc.clientIP(r); got != "1.2.3.4" {
		t.Fatalf("clientIP with XFF = %q, want %q", got, "1.2.3.4")
	}
}

func TestClientIPInjectedExtractorIsUsed(t *testing.T) {
	svc := NewService(newTestStore(t), &capturingMailer{}, Config{})

	ipx := signal.NewIPExtractor(nil) // loopback-only trust
	svc.SetClientIP(ipx.IP)

	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.9:1234"
	r.Header.Set("X-Forwarded-For", "1.2.3.4")
	if got := svc.clientIP(r); got != "203.0.113.9" {
		t.Fatalf("untrusted peer XFF should be ignored: clientIP = %q, want %q", got, "203.0.113.9")
	}

	r.RemoteAddr = "127.0.0.1:9"
	if got := svc.clientIP(r); got != "1.2.3.4" {
		t.Fatalf("loopback peer XFF should be trusted: clientIP = %q, want %q", got, "1.2.3.4")
	}
}
