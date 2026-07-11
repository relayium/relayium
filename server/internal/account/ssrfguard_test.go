package account

import (
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestIsBlockedIP(t *testing.T) {
	blocked := []string{"127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.4",
		"169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1"}
	for _, s := range blocked {
		if !isBlockedIP(net.ParseIP(s)) {
			t.Errorf("isBlockedIP(%s) = false, want blocked", s)
		}
	}
	allowed := []string{"8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"}
	for _, s := range allowed {
		if isBlockedIP(net.ParseIP(s)) {
			t.Errorf("isBlockedIP(%s) = true, want allowed", s)
		}
	}
}

func TestValidateNodeStorageURL(t *testing.T) {
	bad := []string{
		"http://127.0.0.1:9000",
		"http://169.254.169.254/latest/meta-data/",
		"https://10.0.0.5/blob",
		"ftp://example.com",
		"file:///etc/passwd",
		"://nohost",
		"https://",
	}
	for _, u := range bad {
		if err := validateNodeStorageURL(u, false); err == nil {
			t.Errorf("validateNodeStorageURL(%q) = nil, want rejected", u)
		}
	}
	good := []string{"https://node.example.com", "http://relay1.relayium.com:8080/x"}
	for _, u := range good {
		if err := validateNodeStorageURL(u, false); err != nil {
			t.Errorf("validateNodeStorageURL(%q) = %v, want accepted", u, err)
		}
	}
	// The escape hatch lets a private literal through.
	if err := validateNodeStorageURL("http://127.0.0.1:9000", true); err != nil {
		t.Errorf("with allowPrivate: %v, want accepted", err)
	}
}

// The guarded dialer must refuse a real connection to a loopback server, and
// allow it only when the escape hatch is set.
func TestGuardedDialContextBlocksLoopback(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	blocked := &http.Client{Transport: &http.Transport{DialContext: guardedDialContext(false)}}
	if _, err := blocked.Get(srv.URL); err == nil {
		t.Fatal("guarded client reached loopback server; want refusal")
	} else if !strings.Contains(err.Error(), "non-public") {
		t.Fatalf("unexpected error: %v", err)
	}

	allowed := &http.Client{Transport: &http.Transport{DialContext: guardedDialContext(true)}}
	resp, err := allowed.Get(srv.URL)
	if err != nil {
		t.Fatalf("allowPrivate client failed to reach loopback: %v", err)
	}
	resp.Body.Close()
}
